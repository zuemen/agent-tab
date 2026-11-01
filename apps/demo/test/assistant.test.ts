import { describe, expect, it } from "vitest";
import { askAssistant, type AssistantEvent, ruleBasedAnswer, ruleBasedPick } from "../src/assistant.ts";

function fakeToolkit() {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  return {
    calls,
    client: {
      listTools: async () => ({
        tools: [
          { name: "get_order", description: "Get an order", inputSchema: { type: "object", properties: {} } },
          { name: "list_transactions", description: "List all", inputSchema: { type: "object", properties: {} } },
        ],
      }),
      callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
        calls.push(req);
        return { content: [{ type: "text", text: JSON.stringify({ id: req.arguments.id, status: "COMPLETED" }) }] };
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
      beta: { messages: {
        create: async (params: { tools: { name: string }[] }) => {
          seen.push(params);
          const t = turns[i++];
          if (!t) return { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] };
          return { stop_reason: "tool_use", content: [{ type: "tool_use", id: `u${i}`, name: t.name, input: t.input }] };
        },
      } },
    },
  };
}

const facts = { tabId: "tab_x", orderId: "5O190127TN364715T", view: { tabId: "tab_x" } };

describe("tab assistant", () => {
  it("gets the ledger, propose_refund, and only get_order from the PayPal Agent Toolkit", async () => {
    const model = scriptedModel([]);
    await askAssistant({ question: "q", facts, proposeRefund: () => ({}), toolkit: fakeToolkit().client as never, anthropic: model.client as never });
    expect(model.seen[0]!.tools.map((t) => t.name)).toEqual(["tab_ledger", "propose_refund", "get_order"]);
  });

  it("never moves money: propose_refund only creates a proposal", async () => {
    const proposals: [number, string][] = [];
    const events: AssistantEvent[] = [];
    const model = scriptedModel([{ name: "propose_refund", input: { call_number: 3, reason: "useless" } }]);
    await askAssistant({
      question: "refund call 3",
      facts,
      proposeRefund: (n, r) => {
        proposals.push([n, r]);
        return { id: "ref_1", status: "proposed" };
      },
      anthropic: model.client as never,
      onEvent: (e) => events.push(e),
    });
    expect(proposals).toEqual([[3, "useless"]]);
    expect(events.map((e) => e.type)).toEqual(["refund_proposed"]);
  });

  it("looks up only this tab's order", async () => {
    const tk = fakeToolkit();
    const model = scriptedModel([
      { name: "get_order", input: { id: "OTHER-ORDER" } },
      { name: "get_order", input: { id: "5O190127TN364715T" } },
      { name: "list_transactions", input: {} },
    ]);
    await askAssistant({ question: "q", facts, proposeRefund: () => ({}), toolkit: tk.client as never, anthropic: model.client as never });
    expect(tk.calls).toEqual([{ name: "get_order", arguments: { id: "5O190127TN364715T" } }]);
  });

  it("without PayPal tools (simulated rail) it works from the ledger only", async () => {
    const model = scriptedModel([{ name: "tab_ledger", input: {} }]);
    const answer = await askAssistant({ question: "what did I buy?", facts, proposeRefund: () => ({}), anthropic: model.client as never });
    expect(answer).toBe("done");
    expect(model.seen[0]!.tools.map((t) => t.name)).toEqual(["tab_ledger", "propose_refund"]);
  });
  it("answers plainly instead of returning an empty reply when the model declines", async () => {
    const refusing = { beta: { messages: { create: async () => ({ stop_reason: "refusal", content: [] }) } } };
    const answer = await askAssistant({ question: "q", facts, proposeRefund: () => ({}), anthropic: refusing as never });
    expect(answer).toMatch(/can't help/);
  });
});

describe("rule-based fallback (no model)", () => {
  const e = (seq: number, resource: string, cents: number) => ({ seq, seller: resource.split("/")[0]!, resource, amountMicros: cents * 10_000 });

  it("picks a repeat purchase first, then the most expensive call, skipping refunded and sub-cent calls", () => {
    const entries = [e(1, "data/price", 2), e(2, "data/price", 2), e(3, "data/menu", 25), e(4, "panel/ask", 40)];
    expect(ruleBasedPick({ entries })).toEqual({ seq: 2, reason: "it is another purchase from the same paid tool as call #1 (data/price)" });
    expect(ruleBasedPick({ entries, refunds: [{ entrySeq: 2, status: "completed" }] })).toEqual({ seq: 4, reason: "it was the most expensive call (panel/ask)" });
    expect(ruleBasedPick({ entries: [{ ...e(1, "a/b", 0), amountMicros: 5_000 }] })).toBeUndefined();
  });

  it("proposes the refund only when asked, and always says it is rule-based", async () => {
    const view = { entries: [e(1, "data/price", 2), e(2, "panel/ask", 40)] };
    const proposed: number[] = [];
    const events: string[] = [];
    const list = await ruleBasedAnswer({ question: "what did I buy?", view, proposeRefund: (n) => proposed.push(n), onEvent: (ev) => events.push(ev.type) });
    expect(list).toMatch(/fixed rules/);
    expect(list).toMatch(/#2 panel\/ask \$0\.40/);
    expect(proposed).toEqual([]);
    const ans = await ruleBasedAnswer({ question: "Which charge was least worth it? Propose a refund.", view, proposeRefund: (n) => proposed.push(n), onEvent: (ev) => events.push(ev.type) });
    expect(ans).toMatch(/fixed rules/);
    expect(ans).toMatch(/Call #2 .*most expensive/);
    expect(proposed).toEqual([2]);
    expect(events).toEqual(["refund_proposed"]);
  });

  it("reports when the picked call cannot be refunded", async () => {
    const ans = await ruleBasedAnswer({ question: "refund it", view: { entries: [e(1, "a/b", 5)] }, proposeRefund: () => { throw new Error("not allowed"); } });
    expect(ans).toMatch(/cannot be refunded: not allowed/);
  });
});
