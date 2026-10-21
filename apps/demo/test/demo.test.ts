import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SimulatedRail } from "@agent-tab/paypal";
import { connectSeller } from "@agent-tab/agent";
import { buildDemo } from "../src/app.ts";

let server: ServerType;
let base = "";
let rail: SimulatedRail;
let demo: ReturnType<typeof buildDemo>;
const owners = new Map<string, string>();
const H = (tabId: string) => ({ "content-type": "application/json", "x-agenttab-owner": owners.get(tabId) ?? "" });

beforeAll(async () => {
  rail = new SimulatedRail("http://pending/simulated/approve");
  demo = buildDemo({
    rail,
    network: "paypal:simulated",
    publicUrl: "http://pending",
    internalUrl: () => base,
    payoutReceiver: (id) => `${id}@example.com`,
  });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: demo.app.fetch, port: 0 }, (info) => {
      base = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
  (demo.service.config as { publicUrl: string }).publicUrl = base;
  await demo.ready();
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function approveDemoTab(): Promise<string> {
  const start = await fetch(`${base}/api/demo/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(
    (r) => r.json() as Promise<{ tabId: string; reviewUrl: string }>,
  );
  owners.set(start.tabId, new URL(start.reviewUrl).hash.replace("#owner=", ""));
  const view = await fetch(`${base}/api/tabs/${start.tabId}`, { headers: H(start.tabId) }).then((r) => r.json());
  const { approveUrl } = await fetch(`${base}/api/tabs/${start.tabId}/terms`, {
    method: "POST",
    headers: H(start.tabId),
    body: JSON.stringify(view.suggested),
  }).then((r) => r.json() as Promise<{ approveUrl: string }>);
  const returnUrl = rail.approve(new URL(approveUrl).searchParams.get("token")!);
  await fetch(returnUrl, { redirect: "manual" });
  return start.tabId;
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

describe("all-in-one demo", () => {
  it("the scripted agent buys within the mandate and is refused by the off-list seller", async () => {
    const tabId = await approveDemoTab();
    const events: { type: string; detail?: { type: string; reason?: string } }[] = [];
    demo.service.events.on("event", (ev) => {
      if (ev.tabId === tabId) events.push(ev);
    });
    const run = await fetch(`${base}/api/demo/run`, { method: "POST", headers: H(tabId), body: JSON.stringify({ tabId }) });
    expect(run.status).toBe(202);
    expect((await run.json()).mode).toBe("scripted");
    await waitFor(async () => (events.some((e) => e.detail?.type === "done") ? true : undefined));

    const refused = events.filter((e) => e.detail?.type === "payment_refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.detail!.reason).toMatch(/seller_not_allowed/);
    const v = await fetch(`${base}/api/tabs/${tabId}`, { headers: H(tabId) }).then((r) => r.json());
    // 2 articles (0.10) + price history (0.02) + competitor menu (0.25) + panel (0.40)
    expect(v.totals.spent).toBe("0.77");
    expect(v.totals.calls).toBe(5);

    const closed = await fetch(`${base}/api/tabs/${tabId}/close`, { method: "POST", headers: H(tabId), body: "{}" }).then((r) => r.json());
    expect(closed.status).toBe("closed");
    expect(closed.totals.captured).toBe("0.77");
    expect(closed.payout.lines.length).toBe(3);
  });

  it("serves each seller over Streamable HTTP to any MCP client", async () => {
    const tabId = await approveDemoTab();
    const { generateAgentKeyPair } = await import("@agent-tab/core");
    // A different agent key than the one on the mandate: the tab must refuse it.
    const stranger = generateAgentKeyPair();
    const conn = await connectSeller("harbor-gazette", "Harbor Gazette", new StreamableHTTPClientTransport(new URL(`${base}/mcp/harbor-gazette`)), "paypal:simulated", () => ({ tabId, keys: stranger }));
    expect(conn.tools.map((t) => t.name).sort()).toEqual(["read_article", "search_headlines"]);
    expect(conn.tools.find((t) => t.name === "read_article")!.price).toBe("$0.05");
    const free = await conn.client.callTool("search_headlines", { query: "oat" });
    expect(free.isError).toBeFalsy();
    const paid = await conn.client.callTool("read_article", { id: "pa-0419" });
    expect(paid.isError).toBe(true);
    expect(JSON.stringify(paid.content)).toMatch(/invalid_signature/);
    await conn.client.close();
  });

  it("the Claude loop routes tool calls to sellers and pays from the tab (stubbed model)", async () => {
    const tabId = await approveDemoTab();
    const { generateAgentKeyPair } = await import("@agent-tab/core");
    const { runClaudeAgent } = await import("@agent-tab/agent");
    // Re-key the tab's agent: start a fresh request so we hold the key.
    const keys = generateAgentKeyPair();
    const req = demo.service.requestTab({ agentPublicKey: keys.publicKey, purpose: "stub run", suggested: { sellers: ["harbor-gazette"] } });
    owners.set(req.tabId, req.ownerKey);
    const view = await fetch(`${base}/api/tabs/${req.tabId}`, { headers: H(req.tabId) }).then((r) => r.json());
    const { approveUrl } = await demo.service.approveTerms(req.tabId, view.suggested);
    const token = new URL(approveUrl).searchParams.get("token")!;
    rail.approve(token);
    await demo.service.onApproved(token);
    expect(tabId).not.toBe(req.tabId);

    const conn = await connectSeller("harbor-gazette", "Harbor Gazette", new StreamableHTTPClientTransport(new URL(`${base}/mcp/harbor-gazette`)), "paypal:simulated", () => ({ tabId: req.tabId, keys }));
    const seen: unknown[] = [];
    const replies = [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "harbor-gazette__read_article", input: { id: "pa-0419" } }] },
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "tab_status", input: {} }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Buy it. Purchases: Harbor Gazette article $0.05." }] },
    ];
    const fake = { beta: { messages: { create: async (params: { tools: { name: string }[]; messages: unknown[] }) => { seen.push(params); return replies.shift(); } } } };
    const events: { type: string }[] = [];
    const answer = await runClaudeAgent({ task: "t", sellers: [conn], tabStatus: async () => demo.service.view(req.tabId), onEvent: (e) => events.push(e), anthropic: fake as never });
    expect(answer).toMatch(/Buy it/);
    const first = seen[0] as { model: string; tools: { name: string }[]; cache_control?: unknown; fallbacks?: unknown; betas?: string[]; output_config?: unknown };
    expect(first.tools.map((t) => t.name)).toEqual(["harbor-gazette__read_article", "harbor-gazette__search_headlines", "tab_status"]);
    expect(first.cache_control).toEqual({ type: "ephemeral" });
    expect(first.model).toBe("claude-sonnet-5-5");
    expect(first.output_config).toEqual({ effort: "medium" });
    expect(first).toMatchObject({ fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
    expect(events.map((e) => e.type)).toEqual(["tool_call", "payment", "tool_result", "text", "done"]);
    const v = await fetch(`${base}/api/tabs/${req.tabId}`, { headers: H(req.tabId) }).then((r) => r.json());
    expect(v.totals.spent).toBe("0.05");
    await conn.client.close();
  });

  it("only the owner can run the agent; MCP endpoints are POST only", async () => {
    const tabId = await approveDemoTab();
    const noKey = await fetch(`${base}/api/demo/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tabId }) });
    expect(noKey.status).toBe(403);
    const runs = await fetch(`${base}/api/demo/runs/${tabId}`);
    expect(runs.status).toBe(403);
    const get = await fetch(`${base}/mcp/harbor-gazette`);
    expect(get.status).toBe(405);
    const ask = await fetch(`${base}/api/tabs/${tabId}/ask`, { method: "POST", headers: H(tabId), body: JSON.stringify({ question: "hi" }) });
    expect(ask.status).toBe(503); // no Claude key configured in tests
  });
});
