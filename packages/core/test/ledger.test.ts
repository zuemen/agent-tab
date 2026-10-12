import { beforeEach, describe, expect, it } from "vitest";
import {
  DAY_MS,
  activateTab,
  beginCapture,
  beginClose,
  completeCapture,
  computePayouts,
  createTab,
  failCapture,
  generateAgentKeyPair,
  newNonce,
  planCapture,
  readyToFinalize,
  release,
  reserve,
  settle,
  signCharge,
  totals,
  validateMandate,
  type AgentKeyPair,
  type Mandate,
  type TabCharge,
  type TabState,
} from "../src/index.ts";

const T0 = 1_800_000_000_000;
let keys: AgentKeyPair;
let tab: TabState;

function mandate(over: Partial<Mandate> = {}): Mandate {
  return {
    tabId: "tab_test",
    currency: "USD",
    budgetMicros: 1_000_000, // $1.00
    perCallCapMicros: 100_000, // $0.10
    allowedSellers: ["newsroom", "translate"],
    expiresAt: T0 + DAY_MS,
    captureThresholdMicros: 200_000, // $0.20
    agentPublicKey: keys.publicKey,
    ...over,
  };
}

function charge(over: Partial<TabCharge> = {}, k: AgentKeyPair = keys) {
  return signCharge(k, {
    tabId: "tab_test",
    seller: "newsroom",
    resource: "mcp://newsroom/tools/get_article",
    amountMicros: 50_000,
    nonce: newNonce(),
    issuedAt: T0,
    expiresAt: T0 + 60_000,
    ...over,
  });
}

function pay(amountMicros: number, seller = "newsroom", now = T0) {
  const r = reserve(tab, charge({ amountMicros, seller }), now);
  if (!r.ok) throw new Error(r.code);
  const s = settle(tab, r.value.nonce, now);
  if (!s.ok) throw new Error(s.code);
  return s.value;
}

beforeEach(() => {
  keys = generateAgentKeyPair();
  tab = createTab(mandate(), T0);
  activateTab(tab, { paypalOrderId: "ORDER1", authorizationId: "AUTH1", authorizationExpiresAt: T0 + 29 * DAY_MS });
});

describe("mandate validation", () => {
  it("accepts a sane mandate", () => {
    expect(validateMandate(mandate(), T0)).toEqual([]);
  });
  it("rejects budgets in fractional cents, caps above budget, long expiry, empty sellers", () => {
    const problems = validateMandate(
      mandate({ budgetMicros: 1_000_001, perCallCapMicros: 2_000_000, expiresAt: T0 + 30 * DAY_MS, allowedSellers: [] }),
      T0,
    );
    expect(problems.join("|")).toMatch(/budget/);
    expect(problems.join("|")).toMatch(/28 days/);
    expect(problems.join("|")).toMatch(/seller/);
  });
});

describe("reserve", () => {
  it("holds budget for a valid charge", () => {
    const r = reserve(tab, charge(), T0);
    expect(r.ok).toBe(true);
    expect(totals(tab).reservedMicros).toBe(50_000);
    expect(totals(tab).remainingMicros).toBe(950_000);
  });

  it("rejects a charge signed by another key", () => {
    const r = reserve(tab, charge({}, generateAgentKeyPair()), T0);
    expect(r).toMatchObject({ ok: false, code: "INVALID_SIGNATURE" });
  });

  it("rejects a tampered amount", () => {
    const signed = charge();
    signed.charge.amountMicros = 1;
    expect(reserve(tab, signed, T0)).toMatchObject({ ok: false, code: "INVALID_SIGNATURE" });
  });

  it("rejects a replayed charge even after it settled", () => {
    const signed = charge();
    const r = reserve(tab, signed, T0);
    expect(r.ok).toBe(true);
    if (r.ok) settle(tab, r.value.nonce, T0);
    expect(reserve(tab, signed, T0 + 1)).toMatchObject({ ok: false, code: "REPLAYED_NONCE" });
  });

  it("enforces seller allowlist, per-call cap, and budget", () => {
    expect(reserve(tab, charge({ seller: "casino" }), T0)).toMatchObject({ code: "SELLER_NOT_ALLOWED" });
    expect(reserve(tab, charge({ amountMicros: 100_001 }), T0)).toMatchObject({ code: "OVER_PER_CALL_CAP" });
    expect(reserve(tab, charge({ amountMicros: 0 }), T0)).toMatchObject({ code: "INVALID_AMOUNT" });
    for (let i = 0; i < 10; i++) pay(100_000);
    expect(totals(tab).remainingMicros).toBe(0);
    expect(reserve(tab, charge({ amountMicros: 1 }), T0)).toMatchObject({ code: "OVER_BUDGET" });
  });

  it("counts in-flight reservations against the budget", () => {
    for (let i = 0; i < 10; i++) expect(reserve(tab, charge({ amountMicros: 100_000 }), T0).ok).toBe(true);
    expect(reserve(tab, charge({ amountMicros: 1 }), T0)).toMatchObject({ code: "OVER_BUDGET" });
  });

  it("rejects stale, future-dated, and over-long charges", () => {
    expect(reserve(tab, charge({ issuedAt: T0 - 120_000, expiresAt: T0 - 1 }), T0)).toMatchObject({ code: "CHARGE_EXPIRED" });
    expect(reserve(tab, charge({ issuedAt: T0 + 60_000, expiresAt: T0 + 120_000 }), T0)).toMatchObject({ code: "CHARGE_EXPIRED" });
    expect(reserve(tab, charge({ expiresAt: T0 + 10 * 60_000 }), T0)).toMatchObject({ code: "CHARGE_EXPIRED" });
  });

  it("rejects when the seller's terms differ from what the agent signed", () => {
    const r = reserve(tab, charge(), T0, { seller: "newsroom", resource: "mcp://newsroom/tools/get_article", amountMicros: 60_000 });
    expect(r).toMatchObject({ code: "TERMS_MISMATCH" });
  });

  it("rejects after the mandate or authorization expires, and before activation", () => {
    expect(reserve(tab, charge({ issuedAt: T0 + DAY_MS, expiresAt: T0 + DAY_MS + 1000 }), T0 + DAY_MS)).toMatchObject({ code: "TAB_EXPIRED" });
    const fresh = createTab(mandate({ tabId: "tab_test" }), T0);
    expect(reserve(fresh, charge(), T0)).toMatchObject({ code: "TAB_NOT_ACTIVE" });
  });

  it("a lapsed reservation frees its budget and cannot be settled", () => {
    const r = reserve(tab, charge({ amountMicros: 100_000 }), T0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(settle(tab, r.value.nonce, T0 + 61_000)).toMatchObject({ code: "UNKNOWN_RESERVATION" });
    expect(totals(tab).reservedMicros).toBe(0);
  });

  it("release returns the hold but keeps the nonce burned", () => {
    const signed = charge();
    const r = reserve(tab, signed, T0);
    if (!r.ok) throw new Error();
    release(tab, r.value.nonce);
    expect(totals(tab).reservedMicros).toBe(0);
    expect(reserve(tab, signed, T0)).toMatchObject({ code: "REPLAYED_NONCE" });
  });
});

describe("batched capture", () => {
  it("waits for the threshold, then captures whole cents", () => {
    pay(50_000);
    pay(50_000);
    pay(50_000);
    expect(planCapture(tab, false)).toBe(0); // $0.15 < $0.20
    pay(55_000);
    expect(planCapture(tab, false)).toBe(20); // $0.205 -> 20 cents, 0.005 carried
    const cap = beginCapture(tab, 20, false, T0);
    expect(planCapture(tab, false)).toBe(0); // one capture in flight at a time
    completeCapture(tab, cap.id, "CAP1");
    expect(totals(tab).uncapturedMicros).toBe(5_000);
  });

  it("a failed capture puts the amount back", () => {
    for (let i = 0; i < 4; i++) pay(50_000);
    const cap = beginCapture(tab, planCapture(tab, false), false, T0);
    failCapture(tab, cap.id, "INTERNAL_SERVER_ERROR");
    expect(totals(tab).uncapturedMicros).toBe(200_000);
    expect(planCapture(tab, false)).toBe(20);
  });

  it("final capture rounds half-up and never exceeds the budget", () => {
    pay(5_000); // half a cent
    beginClose(tab, "closed_by_user");
    expect(planCapture(tab, true)).toBe(1);
  });

  it("capture ids are stable per attempt for idempotency", () => {
    for (let i = 0; i < 4; i++) pay(50_000);
    const cap = beginCapture(tab, 20, false, T0);
    expect(cap.requestId).toBe("tab_test-capture-1");
  });
});

describe("close and payouts", () => {
  it("closing blocks new charges but lets in-flight ones settle", () => {
    const r = reserve(tab, charge(), T0);
    beginClose(tab, "revoked");
    expect(reserve(tab, charge(), T0)).toMatchObject({ code: "TAB_NOT_ACTIVE" });
    expect(readyToFinalize(tab, T0)).toBe(false);
    if (r.ok) expect(settle(tab, r.value.nonce, T0).ok).toBe(true);
    expect(readyToFinalize(tab, T0)).toBe(true);
  });

  it("splits revenue by seller minus the platform fee and never pays out more than captured", () => {
    pay(100_000, "newsroom");
    pay(100_000, "newsroom");
    pay(50_000, "translate");
    beginClose(tab, "closed_by_user");
    const cap = beginCapture(tab, planCapture(tab, true), true, T0);
    completeCapture(tab, cap.id, "CAP1");
    const payout = computePayouts(tab, 1_000); // 10%
    expect(payout.lines).toEqual([
      { seller: "newsroom", amountCents: 18 },
      { seller: "translate", amountCents: 4 },
    ]);
    expect(payout.platformFeeCents).toBe(25 - 22);
  });

  it("caps payouts when capture fell short", () => {
    pay(100_000, "newsroom");
    beginClose(tab, "closed_by_user");
    const cap = beginCapture(tab, 5, true, T0); // pretend only 5 cents were captured
    completeCapture(tab, cap.id, "CAP1");
    const payout = computePayouts(tab, 0);
    expect(payout.lines.reduce((s, l) => s + l.amountCents, 0)).toBe(5);
  });
});
