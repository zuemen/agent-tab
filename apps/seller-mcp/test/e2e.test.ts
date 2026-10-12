import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createx402MCPClient, type x402MCPClient } from "@x402/mcp";
import { generateAgentKeyPair, type AgentKeyPair } from "@agent-tab/core";
import { SimulatedRail } from "@agent-tab/paypal";
import { PayPalTabClientScheme, type TabSigner } from "@agent-tab/x402-paypal";
import { TabService, createApp, type SellerConfig } from "@agent-tab/facilitator";
import { SELLERS, createSellerServer, facilitatorClientFor } from "../src/index.ts";

const sellerConfigs: SellerConfig[] = SELLERS.map((s) => ({
  id: s.id,
  name: s.name,
  description: s.description,
  payoutReceiver: `${s.id}@example.test`,
  apiKey: `key-${s.id}`,
}));

let httpServer: ServerType;
let base: string;
let rail: SimulatedRail;
let service: TabService;
let keys: AgentKeyPair;
let tab: TabSigner | undefined;
const clients: x402MCPClient[] = [];

async function connect(sellerId: string): Promise<x402MCPClient> {
  const seller = SELLERS.find((s) => s.id === sellerId)!;
  const server = await createSellerServer(seller, facilitatorClientFor(base, `key-${sellerId}`), "paypal:simulated");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = createx402MCPClient({
    name: "test-agent",
    version: "0.0.1",
    schemes: [{ network: "paypal:simulated", client: new PayPalTabClientScheme(() => tab) }],
    spendControls: { allowedAssets: true, maxAmountPerPayment: false },
    autoPayment: true,
  });
  await client.connect(clientT);
  clients.push(client);
  return client;
}

async function openTab(terms: Partial<{ budgetUsd: string; perCallCapUsd: string; captureThresholdUsd: string; sellers: string[] }> = {}) {
  const req = await fetch(`${base}/api/tab-requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentPublicKey: keys.publicKey, purpose: "Research an oat cold brew launch", agentName: "Test agent" }),
  }).then((r) => r.json() as Promise<{ tabId: string }>);
  const approve = await fetch(`${base}/api/tabs/${req.tabId}/terms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      budgetUsd: "2.00",
      perCallCapUsd: "0.50",
      captureThresholdUsd: "0.10",
      sellers: ["harbor-gazette", "openfield-data", "field-panel"],
      expiresInHours: 2,
      ...terms,
    }),
  }).then((r) => r.json() as Promise<{ approveUrl: string }>);
  // The human clicks approve; PayPal redirects back to our return URL.
  const token = new URL(approve.approveUrl).searchParams.get("token")!;
  const returnUrl = rail.approve(token);
  const res = await fetch(returnUrl, { redirect: "manual" });
  expect(res.status).toBe(302);
  tab = { tabId: req.tabId, keys };
  return req.tabId;
}

async function view(tabId: string) {
  return fetch(`${base}/api/tabs/${tabId}`).then((r) => r.json()) as Promise<any>;
}

beforeEach(async () => {
  keys = generateAgentKeyPair();
  tab = undefined;
  await new Promise<void>((resolve) => {
    httpServer = serve({ fetch: (req) => app.fetch(req), port: 0 }, (info) => {
      base = `http://127.0.0.1:${info.port}`;
      resolve();
    });
    // eslint-disable-next-line prefer-const
    var app = createApp((service = new TabService((rail = new SimulatedRail("http://placeholder/simulated/approve")), {
      publicUrl: "http://placeholder",
      network: "paypal:simulated",
      platformFeeBps: 1000,
      sellers: sellerConfigs,
    })));
  });
  // Return URLs must point at the live port.
  (service.config as { publicUrl: string }).publicUrl = base;
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await new Promise<void>((r) => httpServer.close(() => r()));
});

describe("end to end over MCP + x402 + simulated PayPal", () => {
  it("free tools need no payment", async () => {
    const gazette = await connect("harbor-gazette");
    const res = await gazette.callTool("search_headlines", { query: "oat" });
    expect(res.paymentMade).toBe(false);
    expect(res.isError).toBeFalsy();
  });

  it("a paid tool without a tab fails cleanly", async () => {
    const gazette = await connect("harbor-gazette");
    await expect(gazette.callTool("read_article", { id: "pa-0419" })).rejects.toThrow(/no open PayPal tab/);
  });

  it("pays per call, captures in batches, closes, and pays sellers", async () => {
    const tabId = await openTab();
    const gazette = await connect("harbor-gazette");
    const data = await connect("openfield-data");
    const panel = await connect("field-panel");

    const a = await gazette.callTool("read_article", { id: "pa-0419" });
    expect(a.isError).toBeFalsy();
    expect(a.paymentMade).toBe(true);
    expect(a.paymentResponse?.success).toBe(true);
    expect(a.paymentResponse?.transaction).toBe(`${tabId}:1`);
    expect(JSON.parse((a.content[0] as { text: string }).text).title).toMatch(/Oat milk/);

    await data.callTool("price_history", { item: "oat_milk" });
    await gazette.callTool("read_article", { id: "pa-0412" });
    // $0.12 accrued > $0.10 threshold -> one interim capture of 12 cents
    await new Promise((r) => setTimeout(r, 50));
    let v = await view(tabId);
    expect(v.totals.spent).toBe("0.12");
    expect(v.captures).toHaveLength(1);
    expect(v.captures[0]).toMatchObject({ amountCents: 12, final: false, status: "completed" });

    await panel.callTool("ask_panel", { question: "Would you buy an oat cold brew under $5?" });
    await data.callTool("competitor_menu", { area: "Harbor Street" });

    v = await fetch(`${base}/api/tabs/${tabId}/close`, { method: "POST" }).then((r) => r.json());
    expect(v.status).toBe("closed");
    expect(v.totals.spent).toBe("0.77");
    expect(v.totals.captured).toBe("0.77");
    // Each later call crossed the $0.10 threshold on its own, so everything was
    // captured in interim batches; closing just voids the unused authorization.
    expect(v.captures.map((c: { amountCents: number }) => c.amountCents)).toEqual([12, 40, 25]);
    expect(v.paypal.voided).toBe(true);
    // 10% platform fee, sellers paid their share rounded down
    expect(v.payout.status).toBe("completed");
    expect(v.payout.lines).toEqual([
      { seller: "field-panel", amountCents: 36, amount: "0.36" },
      { seller: "harbor-gazette", amountCents: 9, amount: "0.09" },
      { seller: "openfield-data", amountCents: 24, amount: "0.24" },
    ]);
    const auth = [...rail.authorizations.values()][0]!;
    expect(auth.capturedCents).toBe(77);
    expect(auth.status).toBe("VOIDED");
    expect(rail.payouts).toHaveLength(1);
  });

  it("the final capture takes whatever is left below the threshold", async () => {
    const tabId = await openTab({ captureThresholdUsd: "1.00" });
    const gazette = await connect("harbor-gazette");
    await gazette.callTool("read_article", { id: "pa-0419" });
    await gazette.callTool("read_article", { id: "pa-0412" });
    const v = await fetch(`${base}/api/tabs/${tabId}/close`, { method: "POST" }).then((r) => r.json());
    expect(v.captures).toHaveLength(1);
    expect(v.captures[0]).toMatchObject({ amountCents: 10, final: true, status: "completed" });
    expect(v.paypal.voided).toBe(false);
    expect([...rail.authorizations.values()][0]!.status).toBe("CAPTURED");
  });

  it("blocks a seller that is not on the mandate", async () => {
    await openTab();
    const velvet = await connect("velvet-insights");
    const res = await velvet.callTool("premium_forecast", { topic: "cold brew" });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/seller_not_allowed/);
  });

  it("stops at the budget and never charges past it", async () => {
    const tabId = await openTab({ budgetUsd: "0.50", perCallCapUsd: "0.40", captureThresholdUsd: "0.50" });
    const panel = await connect("field-panel");
    const ok = await panel.callTool("ask_panel", { question: "q1" });
    expect(ok.isError).toBeFalsy();
    const over = await panel.callTool("ask_panel", { question: "q2" });
    expect(over.isError).toBe(true);
    expect(JSON.stringify(over.content)).toMatch(/insufficient_funds/);
    const v = await view(tabId);
    expect(v.totals.spent).toBe("0.40");
    expect(v.totals.calls).toBe(1);
  });

  it("revoking voids the unused authorization and blocks further calls", async () => {
    const tabId = await openTab({ captureThresholdUsd: "1.00" });
    const gazette = await connect("harbor-gazette");
    await gazette.callTool("read_article", { id: "pa-0419" });
    const v = await fetch(`${base}/api/tabs/${tabId}/revoke`, { method: "POST" }).then((r) => r.json());
    expect(v.status).toBe("closed");
    expect(v.closeReason).toBe("revoked");
    expect(v.totals.captured).toBe("0.05");
    const after = await gazette.callTool("read_article", { id: "pa-0412" });
    expect(after.isError).toBe(true);
    expect(JSON.stringify(after.content)).toMatch(/tab_not_active/);
  });

  it("a definitive capture failure freezes the tab", async () => {
    const tabId = await openTab();
    const panel = await connect("field-panel");
    const { PayPalError } = await import("@agent-tab/paypal");
    rail.failNext.capture = new PayPalError("expired", 422, "AUTHORIZATION_EXPIRED");
    await panel.callTool("ask_panel", { question: "q" });
    await new Promise((r) => setTimeout(r, 50));
    const v = await view(tabId);
    expect(v.status).toBe("closing");
    expect(v.closeReason).toBe("capture_failed");
    const again = await panel.callTool("ask_panel", { question: "q2" });
    expect(again.isError).toBe(true);
  });
});
