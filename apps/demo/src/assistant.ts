import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/mcp";
import { DEFAULT_MODEL } from "@agent-tab/agent";

/**
 * Tab assistant: answers the tab owner's questions about charges and can issue
 * refunds. PayPal lookups and refunds go through PayPal's official Agent
 * Toolkit (its MCP server, run in-process), limited to three tools.
 */

const TOOLKIT_ACTIONS = { orders: { get: true }, transactions: { list: true }, payments: { createRefund: true } };

export interface TabFacts {
  tabId: string;
  orderId?: string;
  /** Completed captures on this tab: id -> captured cents. */
  captures: Map<string, number>;
  view: unknown;
}

export interface AssistantEvent {
  type: "tool" | "refund" | "blocked";
  detail: Record<string, unknown>;
}

export async function connectPayPalToolkit(accessToken: string): Promise<Client> {
  const server = new PayPalAgentToolkit({ accessToken, configuration: { actions: TOOLKIT_ACTIONS, context: { sandbox: true } } });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "agenttab-assistant", version: "0.1.0" });
  await client.connect(clientT);
  return client;
}

const SYSTEM = `You are the assistant for a person who opened an AgentTab: a PayPal-authorized spending tab their AI agent used to buy tool calls from sellers.
Answer questions about what was bought, what it cost, what was captured from their PayPal authorization, and what was released.
Use tab_ledger for the tab's own records. When PayPal tools are available, use them to confirm with PayPal (get_order for the order and its captures).
Refunds: only call create_refund when the person explicitly asks for a refund. Refund only a capture that belongs to this tab and never more than that capture. Say exactly what you refunded and the PayPal refund id.
Be brief and concrete. Amounts in USD.`;

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content.map((c: { type?: string; text?: string }) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n");
}

function centsOf(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
}

export async function askAssistant(opts: {
  question: string;
  facts: TabFacts;
  toolkit?: Client;
  anthropic?: Anthropic;
  model?: string;
  onEvent?: (ev: AssistantEvent) => void;
}): Promise<string> {
  const anthropic = opts.anthropic ?? new Anthropic();
  const tools: Anthropic.Tool[] = [
    { name: "tab_ledger", description: "This tab's mandate, every paid call, captures, payouts and PayPal ids.", input_schema: { type: "object", properties: {} } },
  ];
  if (opts.toolkit) {
    const listed = await opts.toolkit.listTools();
    for (const t of [...listed.tools].sort((a, b) => a.name.localeCompare(b.name))) {
      tools.push({ name: t.name, description: `[PayPal Agent Toolkit] ${t.description ?? ""}`.slice(0, 1024), input_schema: t.inputSchema as Anthropic.Tool.InputSchema });
    }
  }
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `Tab ${opts.facts.tabId}${opts.facts.orderId ? `, PayPal order ${opts.facts.orderId}` : ""}.\n\n${opts.question}` },
  ];
  for (let turn = 0; turn < 8; turn++) {
    const res = await anthropic.messages.create({
      model: opts.model ?? DEFAULT_MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      tools,
      thinking: { type: "adaptive" },
      cache_control: { type: "ephemeral" },
      messages,
    });
    messages.push({ role: "assistant", content: res.content });
    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || !uses.length) {
      return res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
    }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of uses) {
      const input = (use.input ?? {}) as Record<string, unknown>;
      if (use.name === "tab_ledger") {
        results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(opts.facts.view) });
        continue;
      }
      if (!opts.toolkit) {
        results.push({ type: "tool_result", tool_use_id: use.id, content: "PayPal tools are not available on this server.", is_error: true });
        continue;
      }
      if (use.name === "create_refund") {
        // Guard: the model may only refund this tab's own captures, up to their amount.
        const captureId = String(input.capture_id ?? "");
        const captured = opts.facts.captures.get(captureId);
        const amount = input.amount as { value?: unknown } | undefined;
        const want = amount?.value === undefined ? captured : centsOf(amount.value);
        if (captured === undefined || want === undefined || want <= 0 || want > captured) {
          opts.onEvent?.({ type: "blocked", detail: { captureId, requested: amount?.value ?? "full" } });
          results.push({ type: "tool_result", tool_use_id: use.id, content: "Refused: refunds are limited to this tab's own captures and their captured amounts.", is_error: true });
          continue;
        }
      }
      if (use.name === "get_order" && opts.facts.orderId && input.id !== undefined && input.id !== opts.facts.orderId) {
        results.push({ type: "tool_result", tool_use_id: use.id, content: "Refused: only this tab's PayPal order can be looked up.", is_error: true });
        continue;
      }
      try {
        const out = await opts.toolkit.callTool({ name: use.name, arguments: input });
        if (use.name === "create_refund" && !out.isError) {
          // Later refunds of the same capture only get what is left of it.
          const captureId = String(input.capture_id);
          const amount = input.amount as { value?: unknown } | undefined;
          const left = opts.facts.captures.get(captureId) ?? 0;
          opts.facts.captures.set(captureId, Math.max(0, left - (amount?.value === undefined ? left : centsOf(amount.value) ?? left)));
        }
        opts.onEvent?.({ type: use.name === "create_refund" ? "refund" : "tool", detail: { tool: use.name, input } });
        results.push({ type: "tool_result", tool_use_id: use.id, content: textOf(out.content), ...(out.isError ? { is_error: true } : {}) });
      } catch (err) {
        results.push({ type: "tool_result", tool_use_id: use.id, content: `PayPal error: ${(err as Error).message}`, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }
  return "I could not finish answering that.";
}
