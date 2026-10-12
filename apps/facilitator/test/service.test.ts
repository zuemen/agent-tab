import { beforeEach, describe, expect, it } from "vitest";
import { generateAgentKeyPair, newNonce, signCharge, type AgentKeyPair } from "@agent-tab/core";
import { PayPalError, SimulatedRail } from "@agent-tab/paypal";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { TabService, createApp, type SellerConfig } from "../src/index.ts";

const SELLERS: SellerConfig[] = [
  { id: "news", name: "News", description: "", payoutReceiver: "news@example.test", apiKey: "k-news" },
  { id: "data", name: "Data", description: "", payoutReceiver: "data@example.test", apiKey: "k-data" },
];

let rail: SimulatedRail;
let svc: TabService;
let keys: AgentKeyPair;

function setup() {
  rail = new SimulatedRail("http://x/approve");
  svc = new TabService(rail, { publicUrl: "http://x", network: "paypal:simulated", platformFeeBps: 1000, sellers: SELLERS });
  keys = generateAgentKeyPair();
}

async function openTab(terms: Partial<{ budgetUsd: string; captureThresholdUsd: string; perCallCapUsd: string }> = {}) {
  const req = svc.requestTab({ agentPublicKey: keys.publicKey, purpose: "test" });
  const { approveUrl } = await svc.approveTerms(req.tabId, {
    budgetUsd: "2.00",
    perCallCapUsd: "0.50",
    captureThresholdUsd: "0.10",
    sellers: ["news", "data"],
    expiresInHours: 2,
    ...terms,
  });
  const token = new URL(approveUrl).searchParams.get("token")!;
  rail.approve(token);
  await svc.onApproved(token);
  return req;
}

function pay(tabId: string, seller: string, amountMicros: number) {
  const req: PaymentRequirements = {
    scheme: "paypal-tab",
    network: "paypal:simulated",
    asset: "USD",
    amount: String(amountMicros),
    payTo: seller,
    maxTimeoutSeconds: 60,
    extra: { resource: `${seller}/tool` },
  };
  const now = Date.now();
  const signed = signCharge(keys, { tabId, seller, resource: `${seller}/tool`, amountMicros, nonce: newNonce(), issuedAt: now, expiresAt: now + 60_000 });
  const payload: PaymentPayload = { x402Version: 2, accepted: req, payload: { tabId, charge: signed.charge, signature: signed.signature } };
  const res = svc.settle(payload, req, SELLERS.find((s) => s.id === seller));
  if (!res.success) throw new Error(res.errorReason);
  return res;
}

const settleCaptures = () => new Promise((r) => setTimeout(r, 20));
const view = (tabId: string) => svc.view(tabId) as any;

beforeEach(setup);

describe("owner key", () => {
  it("is required to set terms, close, and revoke; others only see a minimal status", async () => {
    const app = createApp(svc);
    const { tabId, reviewUrl, ownerKey } = svc.requestTab({ agentPublicKey: keys.publicKey, purpose: "p" });
    expect(new URL(reviewUrl).hash).toBe(`#owner=${ownerKey}`);
    const post = (path: string, headers: Record<string, string> = {}) =>
      app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ budgetUsd: "1.00", perCallCapUsd: "0.10", captureThresholdUsd: "0.10", sellers: ["news"], expiresInHours: 1 }) });
    expect((await post(`/api/tabs/${tabId}/terms`)).status).toBe(403);
    expect((await post(`/api/tabs/${tabId}/terms`, { "x-agenttab-owner": "wrong" })).status).toBe(403);
    expect((await post(`/api/tabs/${tabId}/revoke`)).status).toBe(403);
    expect((await app.request(`/api/tabs/${tabId}/revoke`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
    const pub = await (await app.request(`/api/tabs/${tabId}`)).json();
    expect(pub).toEqual({ tabId, status: "requested", owner: false });
    expect((await post(`/api/tabs/${tabId}/terms`, { "x-agenttab-owner": ownerKey })).status).toBe(200);
    const full = await (await app.request(`/api/tabs/${tabId}`, { headers: { "x-agenttab-owner": ownerKey } })).json();
    expect(full.owner).toBe(true);
    expect(full.purpose).toBe("p");
  });

  it("puts the terms on PayPal's approval page via the order description", async () => {
    const req = svc.requestTab({ agentPublicKey: keys.publicKey, purpose: "p" });
    await svc.approveTerms(req.tabId, { budgetUsd: "1.00", perCallCapUsd: "0.25", captureThresholdUsd: "0.10", sellers: ["news"], expiresInHours: 6 });
    const order = [...rail.orders.values()][0]!;
    expect(order.description).toBe("AgentTab: max $0.25/call, 1 seller, 6h");
    expect(view(req.tabId).status).toBe("awaiting_approval");
  });
});

describe("PayPal statuses are the source of truth", () => {
  it("a DECLINED capture does not count as money received and freezes the tab", async () => {
    const { tabId } = await openTab();
    rail.nextCaptureStatus = "DECLINED";
    pay(tabId, "news", 150_000);
    await settleCaptures();
    let v: any = view(tabId);
    expect(v.status).toBe("closing");
    expect(v.closeReason).toBe("capture_failed");
    expect(v.captures[0]).toMatchObject({ status: "failed" });
    v = await svc.close(tabId, "closed_by_user");
    // The final capture at close collects what was used; payouts only count collected money.
    expect(v.totals.captured).toBe("0.15");
    expect(v.payout.lines).toEqual([{ seller: "news", amountCents: 13, amount: "0.13" }]);
  });

  it("an authorization that is not CREATED never opens the tab", async () => {
    const req = svc.requestTab({ agentPublicKey: keys.publicKey, purpose: "p" });
    const { approveUrl } = await svc.approveTerms(req.tabId, { budgetUsd: "1.00", perCallCapUsd: "0.10", captureThresholdUsd: "0.10", sellers: ["news"], expiresInHours: 1 });
    const token = new URL(approveUrl).searchParams.get("token")!;
    rail.approve(token);
    rail.nextAuthorizationStatus = "DENIED";
    await svc.onApproved(token);
    const v = view(req.tabId);
    expect(v.status).toBe("cancelled");
    expect(v.notice).toMatch(/DENIED/);
    expect(() => pay(req.tabId, "news", 10_000)).toThrow(/tab_not_active/);
  });

  it("a 401 from PayPal keeps the capture pending (no freeze) and the retry reuses the request id", async () => {
    const { tabId } = await openTab();
    rail.failNext.capture = new PayPalError("auth", 401, "AUTHENTICATION_FAILURE");
    pay(tabId, "news", 200_000);
    await settleCaptures();
    let v: any = view(tabId);
    expect(v.status).toBe("active");
    expect(v.captures[0]).toMatchObject({ status: "pending", requestId: `${tabId}-capture-1` });
    await svc.sweep();
    v = view(tabId);
    expect(v.captures).toHaveLength(1);
    expect(v.captures[0]).toMatchObject({ status: "completed", requestId: `${tabId}-capture-1` });
  });

  it("if PayPal took the money but answered with an error, reconciliation adopts the capture instead of capturing again", async () => {
    const { tabId } = await openTab();
    rail.ghostNextCapture = new PayPalError("lost answer", 422, "UNPROCESSABLE_ENTITY");
    pay(tabId, "news", 300_000);
    await settleCaptures();
    const v = view(tabId);
    expect(v.status).toBe("active");
    expect(v.captures).toHaveLength(1);
    expect(v.captures[0]).toMatchObject({ status: "completed", amountCents: 30 });
    expect(rail.captures.reduce((s, c) => s + c.amountCents, 0)).toBe(30);
  });

  it("payouts wait while a capture is PENDING at PayPal, then go out once it completes", async () => {
    const { tabId } = await openTab();
    rail.nextCaptureStatus = "PENDING";
    pay(tabId, "news", 200_000);
    await settleCaptures();
    let v: any = await svc.close(tabId, "closed_by_user");
    expect(v.status).toBe("closing");
    expect(v.payout).toBeUndefined();
    rail.captures[0]!.status = "COMPLETED";
    await svc.sweep();
    v = view(tabId);
    expect(v.status).toBe("closed");
    expect(v.payout.status).toBe("completed");
  });
});

describe("closing survives temporary failures", () => {
  it("a void that fails with a 503 is retried by sweep", async () => {
    const { tabId } = await openTab({ captureThresholdUsd: "0.10" });
    pay(tabId, "news", 200_000);
    await settleCaptures();
    rail.failNext.void = new PayPalError("down", 503, "SERVICE_UNAVAILABLE");
    let v: any = await svc.close(tabId, "closed_by_user");
    expect(v.status).toBe("closing");
    expect(v.paypal.voidStatus).toBe("failed");
    await svc.sweep();
    v = view(tabId);
    expect(v.status).toBe("closed");
    expect(v.paypal.voidStatus).toBe("voided");
  });

  it("a payout that fails with a 503 is retried with the same batch id", async () => {
    const { tabId } = await openTab();
    pay(tabId, "news", 200_000);
    await settleCaptures();
    rail.failNext.payout = new PayPalError("down", 503, "SERVICE_UNAVAILABLE");
    let v: any = await svc.close(tabId, "closed_by_user");
    expect(v.status).toBe("closing");
    await svc.sweep();
    v = view(tabId);
    expect(v.status).toBe("closed");
    expect(rail.payouts).toHaveLength(1);
    expect(rail.payouts[0]!.batchId).toBe(`${tabId}-payout`);
  });
});

describe("refunds", () => {
  it("are proposed, executed only on confirm, and come out of that seller's payout", async () => {
    const { tabId } = await openTab();
    pay(tabId, "news", 100_000);
    pay(tabId, "data", 100_000);
    await settleCaptures();
    const proposal = svc.proposeRefund(tabId, 1, "wrong article");
    expect(proposal).toMatchObject({ status: "proposed", seller: "news", amountCents: 10 });
    expect(rail.captures.some((c) => c.refundedCents > 0)).toBe(false); // nothing moved yet
    expect(() => svc.proposeRefund(tabId, 1, "again")).toThrow(/already/);
    const done = await svc.confirmRefund(tabId, proposal.id);
    expect(done.status).toBe("completed");
    expect(rail.captures.reduce((s, c) => s + c.refundedCents, 0)).toBe(10);
    const v: any = await svc.close(tabId, "closed_by_user");
    expect(v.payout.lines).toEqual([{ seller: "data", amountCents: 9, amount: "0.09" }]);
  });

  it("cannot refund a call that has not been captured yet", async () => {
    const { tabId } = await openTab({ captureThresholdUsd: "1.00" });
    pay(tabId, "news", 100_000);
    expect(() => svc.proposeRefund(tabId, 1, "x")).toThrow(/not been captured/);
  });
});
