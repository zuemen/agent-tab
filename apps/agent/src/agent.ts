import Anthropic from "@anthropic-ai/sdk";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createx402MCPClient, type x402MCPClient } from "@x402/mcp";
import { PayPalTabClientScheme, describePrice, type PayPalNetwork, type TabSigner } from "@agent-tab/x402-paypal";

export const DEFAULT_MODEL = process.env.AGENT_MODEL ?? "claude-opus-5-5";

export type AgentEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; seller: string; tool: string; input: unknown; price: string }
  | { type: "payment"; seller: string; tool: string; amount: string; transaction: string }
  | { type: "payment_refused"; seller: string; tool: string; reason: string }
  | { type: "tool_result"; seller: string; tool: string; ok: boolean }
  | { type: "done"; answer: string; mode: "claude" | "scripted" };

export interface SellerConnection {
  sellerId: string;
  sellerName: string;
  client: x402MCPClient;
  tools: { name: string; description: string; inputSchema: Record<string, unknown>; price: string }[];
}

/** Connect to one seller's MCP server with a PayPal-tab paying client. */
export async function connectSeller(
  sellerId: string,
  sellerName: string,
  transport: Transport,
  network: PayPalNetwork,
  getTab: () => TabSigner | undefined,
  onPayment?: (info: { toolName: string; price: string }) => void,
): Promise<SellerConnection> {
  const client = createx402MCPClient({
    name: "agenttab-agent",
    version: "0.1.0",
    schemes: [{ network, client: new PayPalTabClientScheme(getTab) }],
    // The tab mandate is the spend control; the facilitator enforces it.
    spendControls: { allowedAssets: true, maxAmountPerPayment: false },
    autoPayment: true,
    onPaymentRequested: ({ toolName, paymentRequired }) => {
      const req = paymentRequired.accepts[0];
      onPayment?.({ toolName, price: req ? describePrice(req) : "?" });
      return true;
    },
  });
  await client.connect(transport);
  const listed = await client.listTools();
  const tools = listed.tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema as Record<string, unknown>,
    price: String((t._meta as { price?: string } | undefined)?.price ?? "free"),
  }));
  return { sellerId, sellerName, client, tools };
}

const SYSTEM_PROMPT = `You are a research agent working for a small-business owner.
You can buy information from independent sellers (newsrooms, data providers, a paid local panel) through tools.
Paid tools are charged to a spending tab the owner approved in PayPal: it has a total budget, a per-call cap, an allowlist of sellers, and an expiry. The tab is enforced outside of you; refused payments come back as tool errors.

Rules:
- Spend like it is the owner's money. Use free tools first. Buy only what changes your answer.
- Never try to get around a refused payment (different seller, splitting calls). Report it instead.
- Before finishing, call tab_status once and include what you spent.
- Final answer: a short recommendation (max ~200 words), then a "Purchases" list: seller, item, price, why it was worth it.`;

const TAB_STATUS_TOOL: Anthropic.Tool = {
  name: "tab_status",
  description: "Show the PayPal tab: budget, spent, remaining, per-call cap, allowed sellers. Free.",
  input_schema: { type: "object", properties: {} },
};

function toolName(sellerId: string, tool: string): string {
  return `${sellerId.replace(/[^a-zA-Z0-9_-]/g, "_")}__${tool}`.slice(0, 128);
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content.map((c: { type?: string; text?: string }) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n");
}

/** Pull the refusal reason out of an x402 PaymentRequired tool error. */
export function refusalReason(content: unknown): string {
  const text = textOf(content);
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (parsed.error) return parsed.error;
  } catch {
    /* not JSON */
  }
  return text.slice(0, 300);
}

export interface RunOptions {
  task: string;
  sellers: SellerConnection[];
  tabStatus: () => Promise<unknown>;
  onEvent: (ev: AgentEvent) => void;
  anthropic?: Anthropic;
  model?: string;
  maxTurns?: number;
}

async function callSellerTool(conn: SellerConnection, tool: string, input: Record<string, unknown>, onEvent: RunOptions["onEvent"]) {
  const spec = conn.tools.find((t) => t.name === tool);
  onEvent({ type: "tool_call", seller: conn.sellerName, tool, input, price: spec?.price ?? "?" });
  try {
    const res = await conn.client.callTool(tool, input);
    if (res.paymentMade && res.paymentResponse?.success) {
      onEvent({ type: "payment", seller: conn.sellerName, tool, amount: spec?.price ?? "?", transaction: res.paymentResponse.transaction });
    }
    if (res.isError) {
      const reason = refusalReason(res.content);
      onEvent({ type: "payment_refused", seller: conn.sellerName, tool, reason });
      return { ok: false, text: `Refused: ${reason}` };
    }
    onEvent({ type: "tool_result", seller: conn.sellerName, tool, ok: true });
    return { ok: true, text: textOf(res.content) };
  } catch (err) {
    const reason = (err as Error).message;
    onEvent({ type: "payment_refused", seller: conn.sellerName, tool, reason });
    return { ok: false, text: `Error: ${reason}` };
  }
}

/** Claude decides what to buy. Requires ANTHROPIC_API_KEY (or a client). */
export async function runClaudeAgent(opts: RunOptions): Promise<string> {
  const anthropic = opts.anthropic ?? new Anthropic();
  const routes = new Map<string, { conn: SellerConnection; tool: string }>();
  const tools: Anthropic.Tool[] = [];
  // Deterministic order keeps the tools prefix cacheable.
  for (const conn of [...opts.sellers].sort((a, b) => a.sellerId.localeCompare(b.sellerId))) {
    for (const t of [...conn.tools].sort((a, b) => a.name.localeCompare(b.name))) {
      const name = toolName(conn.sellerId, t.name);
      routes.set(name, { conn, tool: t.name });
      tools.push({
        name,
        description: `[${conn.sellerName} · ${t.price === "free" ? "free" : `${t.price} per call`}] ${t.description}`,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      });
    }
  }
  tools.push(TAB_STATUS_TOOL);

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: opts.task }];
  for (let turn = 0; turn < (opts.maxTurns ?? 20); turn++) {
    const response = await anthropic.messages.create({
      model: opts.model ?? DEFAULT_MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools,
      thinking: { type: "adaptive" },
      cache_control: { type: "ephemeral" },
      messages,
    });
    messages.push({ role: "assistant", content: response.content });
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) opts.onEvent({ type: "text", text: block.text });
    }
    if (response.stop_reason === "pause_turn") continue;
    const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || !uses.length) {
      const answer = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      opts.onEvent({ type: "done", answer, mode: "claude" });
      return answer;
    }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of uses) {
      if (use.name === TAB_STATUS_TOOL.name) {
        results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(await opts.tabStatus()) });
        continue;
      }
      const route = routes.get(use.name);
      if (!route) {
        results.push({ type: "tool_result", tool_use_id: use.id, content: `Unknown tool ${use.name}`, is_error: true });
        continue;
      }
      const out = await callSellerTool(route.conn, route.tool, (use.input ?? {}) as Record<string, unknown>, opts.onEvent);
      results.push({ type: "tool_result", tool_use_id: use.id, content: out.text, ...(out.ok ? {} : { is_error: true }) });
    }
    messages.push({ role: "user", content: results });
  }
  const answer = "Stopped: too many turns.";
  opts.onEvent({ type: "done", answer, mode: "claude" });
  return answer;
}

/**
 * Fixed purchase plan with no language model, for judges and CI without an
 * Anthropic key. Labeled "scripted" everywhere it is shown.
 */
export async function runScriptedAgent(opts: Omit<RunOptions, "anthropic" | "model">): Promise<string> {
  const by = (id: string) => opts.sellers.find((s) => s.sellerId === id);
  const plan: [string, string, Record<string, unknown>][] = [
    ["harbor-gazette", "search_headlines", { query: "oat ferry waterfront" }],
    ["harbor-gazette", "read_article", { id: "pa-0412" }],
    ["harbor-gazette", "read_article", { id: "pa-0419" }],
    ["openfield-data", "price_history", { item: "oat_milk" }],
    ["openfield-data", "competitor_menu", { area: "Harbor Street" }],
    ["field-panel", "ask_panel", { question: "Would you buy an oat-milk cold brew near the ferry for $4.75?" }],
    ["velvet-insights", "premium_forecast", { topic: "oat cold brew demand" }],
  ];
  const lines: string[] = [];
  for (const [sellerId, tool, input] of plan) {
    const conn = by(sellerId);
    if (!conn) continue;
    const out = await callSellerTool(conn, tool, input, opts.onEvent);
    const free = conn.tools.find((t) => t.name === tool)?.price === "free";
    lines.push(`${conn.sellerName} · ${tool}: ${out.ok ? (free ? "used (free)" : "bought") : out.text}`);
  }
  const status = (await opts.tabStatus()) as { totals?: { spent?: string; remaining?: string } };
  const answer = [
    "Scripted run (no language model): a fixed purchase plan to demonstrate the tab.",
    ...lines,
    `Spent $${status.totals?.spent ?? "?"}; $${status.totals?.remaining ?? "?"} left on the tab.`,
  ].join("\n");
  opts.onEvent({ type: "done", answer, mode: "scripted" });
  return answer;
}
