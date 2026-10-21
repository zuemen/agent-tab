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
/** Moves the facilitator's clock forward (retry backoff). Charges are still signed with the real clock. */
let skew = 0;

function setup() {
  rail = new SimulatedRail("http://x/approve");
  skew = 0;
  svc = new TabService(rail, { publicUrl: "http://x", network: "paypal:simulated", platformFeeBps: 1000, sellers: SELLERS, now: () => Date.now() + skew });
  keys = generateAgentKeyPair();
}

async function openTab(terms: Partial<{ budgetUsd: string; captureThresholdUsd: string; perCallCapUsd: string }> = {}) {
  const req = svc.requestTab({ agentPublicKey: keys.publicKey, purpose: "test" });
  const { approveUrl, binding } = await svc.approveTerms(req.tabId, {
    budgetUsd: "2.00",
    perCallCapUsd: "0.50",
    captureThresholdUsd: "0.10",
    sellers: ["news", "data"],
    expiresInHours: 2,
    ...terms,
  });
  const token = new URL(approveUrl).searchParams.get("token")!;
  rail.approve(token);
  await svc.onApproved(token, binding);
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
/** Past any retry backoff. Pay before calling this: charges are signed with the real clock. */
const later = () => {
  skew += 61 * 60 * 1000;
};

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
    const { approveUrl, binding } = await svc.approveTerms(req.tabId, { budgetUsd: "1.00", perCallCapUsd: "0.10", captureThresholdUsd: "0.10", sellers: ["news"], expiresInHours: 1 });
    const token = new URL(approveUrl).searchParams.get("token")!;
    rail.approve(token);
    rail.nextAuthorizationStatus = "DENIED";
    await svc.onApproved(token, binding);
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
    await svc.sweep(); // inside the backoff window: not retried yet
    expect(rail.requestIds.filter((r) => r.kind === "capture")).toHaveLength(1);
    later();
    await svc.sweep();
    v = view(tabId);
    expect(v.captures).toHaveLength(1);
    expect(v.captures[0]).toMatchObject({ status: "completed", requestId: `${tabId}-capture-1` });
    // Both attempts reached PayPal with the same PayPal-Request-Id.
    expect(rail.requestIds.filter((r) => r.kind === "capture").map((r) => r.requestId)).toEqual([`${tabId}-capture-1`, `${tabId}-capture-1`]);
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

describe("PayPal failures that must not cost the buyer twice or stall the close", () => {
  it("F1: a 422 on capture while the reconciliation lookup also fails keeps the capture pending instead of capturing again", async () => {
    const { tabId } = await openTab();
    rail.ghostNextCapture = new PayPalError("lost answer", 422, "UNPROCESSABLE_ENTITY");
    rail.failNext.lookup = new PayPalError("down", 503, "SERVICE_UNAVAILABLE");
    pay(tabId, "news", 300_000);
    await settleCaptures();
    let v: any = view(tabId);
    expect(v.status).toBe("active");
    expect(v.captures).toEqual([expect.objectContaining({ status: "pending" })]);
    v = await svc.close(tabId, "closed_by_user");
    expect(v.status).toBe("closed");
    // PayPal took 30 cents exactly once.
    expect(rail.captures.filter((c) => c.status === "COMPLETED").reduce((s, c) => s + c.amountCents, 0)).toBe(30);
    expect(v.captures).toEqual([expect.objectContaining({ status: "completed", amountCents: 30 })]);
  });

  it("F2: a PENDING capture that PayPal later declines fails, the authorization is kept until then, and the close captures again", async () => {
    const { tabId } = await openTab();
    rail.nextCaptureStatus = "PENDING";
    pay(tabId, "news", 200_000);
    await settleCaptures();
    let v: any = await svc.close(tabId, "closed_by_user");
    expect(v.status).toBe("closing");
    expect(v.paypal.voidStatus).toBeUndefined(); // not released while a capture is unsettled
    rail.captures[0]!.status = "DECLINED";
    await svc.sweep();
    v = view(tabId);
    expect(v.status).toBe("closed");
    expect(v.captures.map((c: any) => c.status)).toEqual(["failed", "completed"]);
    expect(v.totals.captured).toBe("0.20");
    expect(v.payout.lines).toEqual([{ seller: "news", amountCents: 18, amount: "0.18" }]);
  });

  it("F2: an open tab whose PENDING capture is declined is frozen", async () => {
    const { tabId } = await openTab();
    rail.nextCaptureStatus = "PENDING";
    pay(tabId, "news", 200_000);
    await settleCaptures();
    rail.captures[0]!.status = "FAILED";
    await svc.sweep();
    const v = view(tabId);
    expect(v.closeReason).toBe("capture_failed");
    expect(v.captures[0]).toMatchObject({ status: "failed" });
  });

  it("F3: a void refused for good does not block payouts and the tab still closes", async () => {
    const { tabId } = await openTab();
    pay(tabId, "news", 200_000);
    await settleCaptures();
    rail.failNext.void = new PayPalError("bad", 400, "INVALID_REQUEST");
    const v: any = await svc.close(tabId, "closed_by_user");
    expect(v.status).toBe("closed");
    expect(v.paypal.voidStatus).toBe("failed");
    expect(rail.payouts).toHaveLength(1);
  });

  it("F3: a temporarily failing void pays sellers first, then is retried with backoff until it works", async () => {
    const { tabId } = await openTab();
    pay(tabId, "news", 200_000);
    await settleCaptures();
    rail.failNext.void = new PayPalError("down", 503, "SERVICE_UNAVAILABLE");
    let v: any = await svc.close(tabId, "closed_by_user");
    expect(v.status).toBe("closing");
    expect(v.paypal.voidStatus).toBe("retrying");
    expect(rail.payouts).toHaveLength(1);
    rail.failNext.void = new PayPalError("down", 503, "SERVICE_UNAVAILABLE");
    await svc.sweep(); // inside the backoff window: not attempted
    expect(rail.failNext.void).toBeDefined();
    later();
    await svc.sweep();
    expect(view(tabId).paypal.voidStatus).toBe("retrying");
    later();
    await svc.sweep();
    v = view(tabId);
    expect(v.status).toBe("closed");
    expect(v.paypal.voidStatus).toBe("voided");
    expect(rail.payouts).toHaveLength(1);
  });

  it("F3: a payout that keeps failing with 401 gives up after a bounded number of attempts", async () => {
    const { tabId } = await openTab();
    pay(tabId, "news", 200_000);
    await settleCaptures();
    rail.failNext.payout = new PayPalError("auth", 401, "AUTHENTICATION_FAILURE");
    await svc.close(tabId, "closed_by_user");
    for (let i = 0; i < 20 && view(tabId).status === "closing"; i++) {
      rail.failNext.payout = new PayPalError("auth", 401, "AUTHENTICATION_FAILURE");
      later();
      await svc.sweep();
    }
    const v = view(tabId);
    expect(v.status).toBe("closed");
    expect(v.payout.status).toBe("failed");
    expect(rail.payouts).toHaveLength(0);
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
    expect(v.paypal.voidStatus).toBe("retrying");
    later();
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
    later();
    await svc.sweep();
    v = view(tabId);
    expect(v.status).toBe("closed");
    expect(rail.payouts).toHaveLength(1);
    // The failed attempt and the retry used the same batch id, so PayPal cannot pay twice.
    expect(rail.requestIds.filter((r) => r.kind === "payout").map((r) => r.requestId)).toEqual([`${tabId}-payout`, `${tabId}-payout`]);
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

describe("refunds that are in flight when the tab closes", () => {
  it("F4: sellers are paid only after a confirmed refund has gone through, and it comes out of their payout", async () => {
    const { tabId } = await openTab();
    pay(tabId, "news", 100_000);
    pay(tabId, "data", 100_000);
    await settleCaptures();
    const proposal = svc.proposeRefund(tabId, 1, "wrong article");
    rail.failNext.refund = new PayPalError("down", 503, "SERVICE_UNAVAILABLE");
    expect((await svc.confirmRefund(tabId, proposal.id)).status).toBe("pending");
    let v: any = await svc.close(tabId, "closed_by_user");
    expect(v.status).toBe("closing");
    expect(v.payout).toBeUndefined();
    later();
    await svc.sweep();
    v = view(tabId);
    expect(v.status).toBe("closed");
    expect(v.refunds[0]).toMatchObject({ status: "completed", afterPayout: false });
    expect(v.payout.lines).toEqual([{ seller: "data", amountCents: 9, amount: "0.09" }]);
  });

  it("F9: a retried refund whose first answer was lost is found on the order, not sent again", async () => {
    const { tabId } = await openTab();
    pay(tabId, "news", 100_000);
    await settleCaptures();
    const proposal = svc.proposeRefund(tabId, 1, "x");
    rail.ghostNextRefund = new PayPalError("lost answer", 503, "SERVICE_UNAVAILABLE");
    expect((await svc.confirmRefund(tabId, proposal.id)).status).toBe("pending");
    rail.forgetRequestIds(); // PayPal no longer remembers the request id
    later();
    expect((await svc.confirmRefund(tabId, proposal.id)).status).toBe("completed");
    expect(rail.refunds).toHaveLength(1);
    expect(rail.requestIds.filter((r) => r.kind === "refund")).toHaveLength(1); // the retry never reached the refund endpoint
  });
});

describe("F8: refunds never exceed what the call cost", () => {
  it("rounds down to whole cents and refuses calls under one cent", async () => {
    const { tabId } = await openTab({ captureThresholdUsd: "0.10" });
    pay(tabId, "news", 4_000); // $0.004
    pay(tabId, "news", 15_000); // $0.015
    pay(tabId, "data", 100_000);
    await settleCaptures();
    expect(() => svc.proposeRefund(tabId, 1, "x")).toThrow(/less than one cent/);
    expect(svc.proposeRefund(tabId, 2, "x").amountCents).toBe(1);
  });
});

describe("F5: the owner key in the review link stops working once the owner approves in PayPal", () => {
  async function throughPayPal(withCookie: boolean) {
    // withCookie=false: the redirect arrives from somewhere other than the browser that set the terms.
    const app = createApp(svc);
    const { tabId, ownerKey } = svc.requestTab({ agentPublicKey: keys.publicKey, purpose: "p" });
    const terms = await app.request(`/api/tabs/${tabId}/terms`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agenttab-owner": ownerKey },
      body: JSON.stringify({ budgetUsd: "1.00", perCallCapUsd: "0.10", captureThresholdUsd: "0.10", sellers: ["news"], expiresInHours: 1 }),
    });
    const cookie = terms.headers.get("set-cookie")!.split(";")[0]!;
    expect(terms.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    const { approveUrl } = (await terms.json()) as { approveUrl: string };
    const back = new URL(rail.approve(new URL(approveUrl).searchParams.get("token")!));
    const res = await app.request(back.pathname + back.search, withCookie ? { headers: { cookie } } : {});
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    const close = (key: string) => app.request(`/api/tabs/${tabId}/close`, { method: "POST", headers: { "content-type": "application/json", "x-agenttab-owner": key }, body: "{}" });
    const replay = () => app.request(back.pathname + back.search, { headers: { cookie } });
    return { tabId, ownerKey, location, close, replay };
  }

  it("the browser that went to PayPal gets a new key; the old one is refused", async () => {
    const { ownerKey, location, close, replay } = await throughPayPal(true);
    const fresh = /#owner=([A-Za-z0-9_-]+)$/.exec(location)?.[1];
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(ownerKey);
    expect((await close(ownerKey)).status).toBe(403);
    expect((await close(fresh!)).status).toBe(200);
    // Replaying the same redirect, even with the cookie, hands out nothing more.
    const again = await replay();
    expect(again.status).toBe(302);
    expect(again.headers.get("location")).toMatch(/approved=1$/);
  });

  it("a redirect without the owner's cookie (e.g. an agent racing the owner) opens nothing and cannot stop the owner's rotation", async () => {
    const { ownerKey, location, close, replay } = await throughPayPal(false);
    expect(location).toMatch(/finish=elsewhere/);
    expect(location).not.toMatch(/#owner=/);
    expect(view(new URL(location, "http://x").pathname.split("/")[2]!).status).toBe("awaiting_approval");
    // The owner's own redirect still wins and kills the review-link key.
    const res = await replay();
    expect(res.headers.get("location")).toMatch(/approved=1#owner=/);
    expect((await close(ownerKey)).status).toBe(403);
  });

  it("the owner's page can tell when someone else submitted the terms", async () => {
    const app = createApp(svc);
    const { tabId, ownerKey } = svc.requestTab({ agentPublicKey: keys.publicKey, purpose: "p" });
    const headers = { "content-type": "application/json", "x-agenttab-owner": ownerKey };
    // The agent, holding the review link, sets the terms itself and keeps the cookie.
    const terms = await app.request(`/api/tabs/${tabId}/terms`, {
      method: "POST",
      headers,
      body: JSON.stringify({ budgetUsd: "1.00", perCallCapUsd: "0.10", captureThresholdUsd: "0.10", sellers: ["news"], expiresInHours: 1 }),
    });
    const agentCookie = terms.headers.get("set-cookie")!.split(";")[0]!;
    const asOwner = await (await app.request(`/api/tabs/${tabId}`, { headers })).json();
    expect(asOwner).toMatchObject({ status: "awaiting_approval", termsSetHere: false });
    const asAgent = await (await app.request(`/api/tabs/${tabId}`, { headers: { ...headers, cookie: agentCookie } })).json();
    expect(asAgent.termsSetHere).toBe(true);
  });
});

describe("F6 and F7: robustness of the HTTP API", () => {
  it("F6: a tab saved before owner keys existed is readable and owned by nobody", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const file = join(mkdtempSync(join(tmpdir(), "agenttab-")), "tabs.json");
    const request = { tabId: "tab_legacy", agentPublicKey: keys.publicKey, purpose: "", agentName: "", suggested: {}, createdAt: 0 };
    writeFileSync(file, JSON.stringify({ network: "paypal:simulated", tabs: [{ request }] }));
    const legacy = new TabService(rail, { publicUrl: "http://x", network: "paypal:simulated", platformFeeBps: 1000, sellers: SELLERS, dataFile: file });
    const res = await createApp(legacy).request("/api/tabs/tab_legacy", { headers: { "x-agenttab-owner": "anything" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ owner: false });
  });

  it("F7: without a trusted proxy, a client cannot dodge the rate limit by forging X-Forwarded-For", async () => {
    const ask = (app: ReturnType<typeof createApp>, xff: string) =>
      app.request("/api/tab-requests", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": xff }, body: JSON.stringify({ agentPublicKey: keys.publicKey, purpose: "p" }) });
    const direct = createApp(svc, { tabRequestsPerHour: 2 });
    expect((await ask(direct, "1.1.1.1")).status).toBe(201);
    expect((await ask(direct, "2.2.2.2")).status).toBe(201);
    expect((await ask(direct, "3.3.3.3")).status).toBe(429);
    // Behind one proxy, the last entry is the address the proxy saw.
    const proxied = createApp(svc, { tabRequestsPerHour: 1, trustProxyHops: 1 });
    expect((await ask(proxied, "9.9.9.9, 1.1.1.1")).status).toBe(201);
    expect((await ask(proxied, "8.8.8.8, 1.1.1.1")).status).toBe(429);
    expect((await ask(proxied, "2.2.2.2")).status).toBe(201);
  });
});

describe("second review: money paths", () => {
  it("R1: a capture whose fate is unknown is never resent while PayPal's records cannot be read", async () => {
    const { tabId } = await openTab();
    rail.ghostNextCapture = new PayPalError("lost answer", 422, "UNPROCESSABLE_ENTITY");
    rail.lookupsDown = new PayPalError("down", 503, "SERVICE_UNAVAILABLE");
    pay(tabId, "news", 300_000);
    await settleCaptures();
    rail.forgetRequestIds(); // PayPal would treat a resend as a new capture
    for (let i = 0; i < 4; i++) {
      later();
      await svc.sweep();
    }
    expect(rail.requestIds.filter((r) => r.kind === "capture")).toHaveLength(1);
    expect(view(tabId).captures[0]).toMatchObject({ status: "pending" });
    delete rail.lookupsDown;
    later();
    await svc.sweep();
    expect(view(tabId).captures[0]).toMatchObject({ status: "completed" });
    expect(rail.captures.filter((c) => c.status === "COMPLETED").reduce((s, c) => s + c.amountCents, 0)).toBe(30);
  });

  it("R2: close waits for a PENDING capture before the final capture, so a later decline is collected again", async () => {
    const { tabId } = await openTab();
    rail.nextCaptureStatus = "PENDING";
    pay(tabId, "news", 200_000);
    await settleCaptures();
    pay(tabId, "news", 50_000); // below the threshold: left for the final capture
    let v: any = await svc.close(tabId, "closed_by_user");
    expect(v.status).toBe("closing");
    expect(v.captures).toHaveLength(1); // no final capture yet
    rail.captures[0]!.status = "DECLINED";
    later();
    await svc.sweep();
    v = view(tabId);
    expect(v.status).toBe("closed");
    expect(v.totals.captured).toBe("0.25");
    expect(v.captures.map((c: any) => [c.status, c.amountCents])).toEqual([["failed", 20], ["completed", 25]]);
  });

  it("R3: a refund cannot be confirmed while sellers' payouts are being sent", async () => {
    const { tabId } = await openTab();
    pay(tabId, "news", 100_000);
    pay(tabId, "data", 100_000);
    await settleCaptures();
    rail.failNext.payout = new PayPalError("down", 503, "SERVICE_UNAVAILABLE");
    await svc.close(tabId, "closed_by_user");
    const proposal = svc.proposeRefund(tabId, 1, "x");
    await expect(svc.confirmRefund(tabId, proposal.id)).rejects.toThrow(/being paid/);
    later();
    await svc.sweep();
    expect(view(tabId).payout.status).toBe("completed");
    // Afterwards it is allowed; the platform absorbs it because the seller was already paid.
    expect(await svc.confirmRefund(tabId, proposal.id)).toMatchObject({ status: "completed", afterPayout: true });
  });

  it("R6: a refund whose fate stays unknown is withheld from the seller's payout", async () => {
    const { tabId } = await openTab();
    pay(tabId, "news", 100_000);
    pay(tabId, "data", 100_000);
    await settleCaptures();
    const proposal = svc.proposeRefund(tabId, 1, "x");
    rail.ghostNextRefund = new PayPalError("lost answer", 503, "SERVICE_UNAVAILABLE");
    await svc.confirmRefund(tabId, proposal.id);
    rail.lookupsDown = new PayPalError("down", 503, "SERVICE_UNAVAILABLE");
    for (let i = 0; i < 10; i++) {
      later();
      await svc.sweep();
    }
    const r = view(tabId).refunds[0];
    expect(r).toMatchObject({ status: "failed", unverified: true });
    expect(() => svc.proposeRefund(tabId, 1, "again")).toThrow(/already/);
    delete rail.lookupsDown;
    const v: any = await svc.close(tabId, "closed_by_user");
    expect(v.payout.lines).toEqual([{ seller: "data", amountCents: 9, amount: "0.09" }]);
  });
});

describe("third review: nothing waits forever", () => {
  it("a tab never finished in the owner's browser is cancelled at its expiry", async () => {
    const req = svc.requestTab({ agentPublicKey: keys.publicKey, purpose: "p" });
    const { approveUrl } = await svc.approveTerms(req.tabId, { budgetUsd: "1.00", perCallCapUsd: "0.10", captureThresholdUsd: "0.10", sellers: ["news"], expiresInHours: 1 });
    rail.approve(new URL(approveUrl).searchParams.get("token")!);
    later(); // past the 1-hour expiry
    await svc.sweep();
    expect(view(req.tabId).status).toBe("closed");
  });

  it("a capture stuck behind unreadable PayPal records is flagged for a person, still never resent", async () => {
    const { tabId } = await openTab();
    rail.ghostNextCapture = new PayPalError("lost answer", 422, "UNPROCESSABLE_ENTITY");
    rail.lookupsDown = new PayPalError("down", 503, "SERVICE_UNAVAILABLE");
    pay(tabId, "news", 300_000);
    await settleCaptures();
    for (let i = 0; i < 9; i++) {
      later();
      await svc.sweep();
    }
    const cap = view(tabId).captures[0];
    expect(cap.status).toBe("pending");
    expect(cap.error).toMatch(/check this capture in PayPal/);
    expect(rail.requestIds.filter((r) => r.kind === "capture")).toHaveLength(1);
  });
});
