import { describe, expect, it } from "vitest";
import { askAssistant, type AssistantEvent } from "../src/assistant.ts";

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
});
