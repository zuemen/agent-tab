import { describe, expect, it } from "vitest";
import { askAssistant, type AssistantEvent } from "../src/assistant.ts";

function fakeToolkit() {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  return {
    calls,
    client: {
      listTools: async () => ({
        tools: [
          { name: "create_refund", description: "Refund a capture", inputSchema: { type: "object", properties: {} } },
          { name: "get_order", description: "Get an order", inputSchema: { type: "object", properties: {} } },
        ],
      }),
      callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
        calls.push(req);
        return { content: [{ type: "text", text: JSON.stringify({ id: "REFUND-1", status: "COMPLETED" }) }] };
      },
    },
  };
}

/** A stand-in model that issues the given tool calls one turn at a time, then answers. */
function scriptedModel(turns: { name: string; input: Record<string, unknown> }[]) {
  const seen: { tools: { name: string }[] }[] = [];
  let i = 0;
  return {
    seen,
    client: {
      messages: {
        create: async (params: { tools: { name: string }[] }) => {
          seen.push(params);
          const t = turns[i++];
          if (!t) return { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] };
          return { stop_reason: "tool_use", content: [{ type: "tool_use", id: `u${i}`, name: t.name, input: t.input }] };
        },
      },
    },
  };
}

const facts = () => ({ tabId: "tab_x", orderId: "5O190127TN364715T", captures: new Map([["CAP1", 40]]), view: { tabId: "tab_x" } });

describe("tab assistant guard", () => {
  it("exposes the tab ledger plus the PayPal Agent Toolkit tools", async () => {
    const model = scriptedModel([]);
    await askAssistant({ question: "q", facts: facts(), toolkit: fakeToolkit().client as never, anthropic: model.client as never });
    expect(model.seen[0]!.tools.map((t) => t.name)).toEqual(["tab_ledger", "create_refund", "get_order"]);
  });

  it("refunds this tab's capture within its amount, and tracks what is left", async () => {
    const tk = fakeToolkit();
    const f = facts();
    const events: AssistantEvent[] = [];
    const model = scriptedModel([
      { name: "create_refund", input: { capture_id: "CAP1", amount: { currency_code: "USD", value: "0.25" } } },
      { name: "create_refund", input: { capture_id: "CAP1", amount: { currency_code: "USD", value: "0.20" } } }, // only 0.15 left
      { name: "create_refund", input: { capture_id: "CAP1", amount: { currency_code: "USD", value: "0.15" } } },
    ]);
    await askAssistant({ question: "refund", facts: f, toolkit: tk.client as never, anthropic: model.client as never, onEvent: (e) => events.push(e) });
    expect(tk.calls.map((c) => (c.arguments.amount as { value: string }).value)).toEqual(["0.25", "0.15"]);
    expect(events.map((e) => e.type)).toEqual(["refund", "blocked", "refund"]);
    expect(f.captures.get("CAP1")).toBe(0);
  });

  it("blocks refunds of captures that are not on this tab, and lookups of other orders", async () => {
    const tk = fakeToolkit();
    const model = scriptedModel([
      { name: "create_refund", input: { capture_id: "SOMEONE-ELSES" } },
      { name: "get_order", input: { id: "OTHER-ORDER" } },
      { name: "get_order", input: { id: "5O190127TN364715T" } },
    ]);
    await askAssistant({ question: "q", facts: facts(), toolkit: tk.client as never, anthropic: model.client as never });
    expect(tk.calls).toEqual([{ name: "get_order", arguments: { id: "5O190127TN364715T" } }]);
  });

  it("works without PayPal tools (simulated rail): ledger only", async () => {
    const model = scriptedModel([{ name: "tab_ledger", input: {} }]);
    const answer = await askAssistant({ question: "what did I buy?", facts: facts(), anthropic: model.client as never });
    expect(answer).toBe("done");
    expect(model.seen[0]!.tools.map((t) => t.name)).toEqual(["tab_ledger"]);
  });
});
