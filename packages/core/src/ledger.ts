import { CLOCK_SKEW_MS, MAX_CHARGE_TTL_MS, verifyChargeSignature, type SignedTabCharge } from "./charge.ts";
import { validateMandate, type Mandate } from "./mandate.ts";
import { MICROS_PER_CENT } from "./money.ts";

// The tab ledger is a plain state object plus pure-ish functions that mutate it.
// The facilitator owns one TabState per tab and calls these from a single
// thread, so each function call is atomic.

export type TabStatus = "awaiting_approval" | "active" | "closing" | "closed";
export type CloseReason = "closed_by_user" | "revoked" | "expired" | "budget_exhausted" | "capture_failed";

export interface Reservation {
  nonce: string;
  seller: string;
  resource: string;
  amountMicros: number;
  createdAt: number;
  /** Reservation lapses with the signed charge that created it. */
  expiresAt: number;
}

export interface LedgerEntry {
  seq: number;
  nonce: string;
  seller: string;
  resource: string;
  amountMicros: number;
  settledAt: number;
}

export interface CaptureRecord {
  id: string;
  /** Sent as PayPal-Request-Id, so retrying the same record never double-captures. */
  requestId: string;
  amountCents: number;
  final: boolean;
  status: "pending" | "completed" | "failed";
  createdAt: number;
  paypalCaptureId?: string;
  error?: string;
}

export interface PayoutLine {
  seller: string;
  amountCents: number;
}

export interface PayoutRecord {
  status: "pending" | "completed" | "failed";
  lines: PayoutLine[];
  platformFeeCents: number;
  batchId?: string;
  error?: string;
}

export interface TabState {
  mandate: Mandate;
  status: TabStatus;
  createdAt: number;
  paypalOrderId?: string;
  authorizationId?: string;
  authorizationExpiresAt?: number;
  reservations: Record<string, Reservation>;
  /** nonce -> charge expiry; kept until the charge could no longer be replayed. */
  usedNonces: Record<string, number>;
  entries: LedgerEntry[];
  captures: CaptureRecord[];
  voided: boolean;
  closeReason?: CloseReason;
  payout?: PayoutRecord;
}

export type RejectCode =
  | "TAB_NOT_ACTIVE"
  | "TAB_EXPIRED"
  | "WRONG_TAB"
  | "INVALID_SIGNATURE"
  | "CHARGE_EXPIRED"
  | "REPLAYED_NONCE"
  | "SELLER_NOT_ALLOWED"
  | "INVALID_AMOUNT"
  | "OVER_PER_CALL_CAP"
  | "OVER_BUDGET"
  | "TERMS_MISMATCH"
  | "UNKNOWN_RESERVATION";

export type Result<T> = { ok: true; value: T } | { ok: false; code: RejectCode; message: string };

const reject = <T>(code: RejectCode, message: string): Result<T> => ({ ok: false, code, message });

export function createTab(mandate: Mandate, now: number): TabState {
  const problems = validateMandate(mandate, now);
  if (problems.length) throw new Error(`invalid mandate: ${problems.join("; ")}`);
  return {
    mandate,
    status: "awaiting_approval",
    createdAt: now,
    reservations: {},
    usedNonces: {},
    entries: [],
    captures: [],
    voided: false,
  };
}

export function activateTab(
  tab: TabState,
  auth: { paypalOrderId: string; authorizationId: string; authorizationExpiresAt: number },
): void {
  if (tab.status !== "awaiting_approval") throw new Error(`cannot activate tab in status ${tab.status}`);
  tab.paypalOrderId = auth.paypalOrderId;
  tab.authorizationId = auth.authorizationId;
  tab.authorizationExpiresAt = auth.authorizationExpiresAt;
  tab.status = "active";
}

export interface TabTotals {
  budgetMicros: number;
  settledMicros: number;
  reservedMicros: number;
  /** Budget the agent can still commit. */
  remainingMicros: number;
  /** Captured or being captured right now. */
  capturedCents: number;
  /** Settled but not yet captured. */
  uncapturedMicros: number;
  callCount: number;
}

export function totals(tab: TabState): TabTotals {
  const settledMicros = tab.entries.reduce((s, e) => s + e.amountMicros, 0);
  const reservedMicros = Object.values(tab.reservations).reduce((s, r) => s + r.amountMicros, 0);
  const capturedCents = tab.captures.filter((c) => c.status !== "failed").reduce((s, c) => s + c.amountCents, 0);
  return {
    budgetMicros: tab.mandate.budgetMicros,
    settledMicros,
    reservedMicros,
    remainingMicros: tab.mandate.budgetMicros - settledMicros - reservedMicros,
    capturedCents,
    uncapturedMicros: settledMicros - capturedCents * MICROS_PER_CENT,
    callCount: tab.entries.length,
  };
}

function hardExpiry(tab: TabState): number {
  return Math.min(tab.mandate.expiresAt, tab.authorizationExpiresAt ?? Infinity);
}

/** Drop lapsed reservations and nonces that can no longer be replayed. */
export function pruneExpired(tab: TabState, now: number): void {
  for (const [nonce, r] of Object.entries(tab.reservations)) {
    if (r.expiresAt <= now) delete tab.reservations[nonce];
  }
  for (const [nonce, exp] of Object.entries(tab.usedNonces)) {
    if (exp + CLOCK_SKEW_MS < now) delete tab.usedNonces[nonce];
  }
}

export interface ExpectedTerms {
  seller: string;
  resource: string;
  amountMicros: number;
}

/**
 * Check a signed charge against the mandate and hold its amount.
 * `expected` is what the seller is actually asking for; the charge must match it exactly.
 */
export function reserve(tab: TabState, signed: SignedTabCharge, now: number, expected?: ExpectedTerms): Result<Reservation> {
  pruneExpired(tab, now);
  const m = tab.mandate;
  const c = signed.charge;
  if (tab.status !== "active") return reject("TAB_NOT_ACTIVE", `tab is ${tab.status}`);
  if (now >= hardExpiry(tab)) return reject("TAB_EXPIRED", "tab or its PayPal authorization has expired");
  if (c.tabId !== m.tabId) return reject("WRONG_TAB", "charge is for a different tab");
  if (!verifyChargeSignature(m.agentPublicKey, signed)) return reject("INVALID_SIGNATURE", "signature does not match the agent key on the mandate");
  if (!Number.isSafeInteger(c.issuedAt) || !Number.isSafeInteger(c.expiresAt)) return reject("CHARGE_EXPIRED", "bad charge timestamps");
  if (c.issuedAt > now + CLOCK_SKEW_MS || c.expiresAt <= now || c.expiresAt - c.issuedAt > MAX_CHARGE_TTL_MS) {
    return reject("CHARGE_EXPIRED", "charge is expired, not yet valid, or valid for too long");
  }
  if (c.nonce in tab.usedNonces) return reject("REPLAYED_NONCE", "this charge was already used");
  if (!m.allowedSellers.includes(c.seller)) return reject("SELLER_NOT_ALLOWED", `seller ${c.seller} is not on the mandate`);
  if (!Number.isSafeInteger(c.amountMicros) || c.amountMicros <= 0) return reject("INVALID_AMOUNT", "amount must be a positive integer number of micros");
  if (c.amountMicros > m.perCallCapMicros) return reject("OVER_PER_CALL_CAP", "amount exceeds the per-call cap");
  if (expected && (expected.seller !== c.seller || expected.resource !== c.resource || expected.amountMicros !== c.amountMicros)) {
    return reject("TERMS_MISMATCH", "charge does not match the seller's price or resource");
  }
  if (c.amountMicros > totals(tab).remainingMicros) return reject("OVER_BUDGET", "charge would exceed the remaining budget");

  const reservation: Reservation = {
    nonce: c.nonce,
    seller: c.seller,
    resource: c.resource,
    amountMicros: c.amountMicros,
    createdAt: now,
    expiresAt: c.expiresAt,
  };
  tab.reservations[c.nonce] = reservation;
  tab.usedNonces[c.nonce] = c.expiresAt;
  return { ok: true, value: reservation };
}

/** The seller delivered: turn the hold into a ledger entry. */
export function settle(tab: TabState, nonce: string, now: number): Result<LedgerEntry> {
  const r = tab.reservations[nonce];
  if (!r || r.expiresAt <= now) {
    delete tab.reservations[nonce];
    return reject("UNKNOWN_RESERVATION", "no live reservation for this charge");
  }
  delete tab.reservations[nonce];
  const entry: LedgerEntry = {
    seq: tab.entries.length + 1,
    nonce,
    seller: r.seller,
    resource: r.resource,
    amountMicros: r.amountMicros,
    settledAt: now,
  };
  tab.entries.push(entry);
  return { ok: true, value: entry };
}

/** The seller failed: give the hold back. The nonce stays burned. */
export function release(tab: TabState, nonce: string): void {
  delete tab.reservations[nonce];
}

/** Stop accepting new charges. In-flight reservations may still settle. */
export function beginClose(tab: TabState, reason: CloseReason): void {
  if (tab.status === "closed") return;
  if (tab.status === "awaiting_approval") {
    tab.status = "closed";
    tab.closeReason = reason;
    return;
  }
  tab.status = "closing";
  tab.closeReason ??= reason;
}

/**
 * How many cents to capture now (0 = nothing to do).
 * Interim captures take whole cents once the threshold has accrued; the final
 * capture rounds the remainder half-up. Never exceeds the authorized budget.
 */
export function planCapture(tab: TabState, final: boolean): number {
  if (tab.captures.some((c) => c.status === "pending")) return 0;
  const t = totals(tab);
  const budgetCents = tab.mandate.budgetMicros / MICROS_PER_CENT;
  const headroom = budgetCents - t.capturedCents;
  let cents: number;
  if (final) {
    cents = Math.floor((t.uncapturedMicros + MICROS_PER_CENT / 2) / MICROS_PER_CENT);
  } else {
    if (tab.status !== "active" || t.uncapturedMicros < tab.mandate.captureThresholdMicros) return 0;
    cents = Math.floor(t.uncapturedMicros / MICROS_PER_CENT);
  }
  return Math.max(0, Math.min(cents, headroom));
}

export function beginCapture(tab: TabState, amountCents: number, final: boolean, now: number): CaptureRecord {
  if (!(amountCents > 0)) throw new Error("capture amount must be positive");
  if (tab.captures.some((c) => c.status === "pending")) throw new Error("a capture is already in flight");
  const n = tab.captures.length + 1;
  const record: CaptureRecord = {
    id: `cap_${n}`,
    requestId: `${tab.mandate.tabId}-capture-${n}`,
    amountCents,
    final,
    status: "pending",
    createdAt: now,
  };
  tab.captures.push(record);
  return record;
}

export function completeCapture(tab: TabState, id: string, paypalCaptureId: string): void {
  const c = findCapture(tab, id);
  c.status = "completed";
  c.paypalCaptureId = paypalCaptureId;
}

export function failCapture(tab: TabState, id: string, error: string): void {
  const c = findCapture(tab, id);
  c.status = "failed";
  c.error = error;
}

function findCapture(tab: TabState, id: string): CaptureRecord {
  const c = tab.captures.find((x) => x.id === id);
  if (!c) throw new Error(`unknown capture ${id}`);
  if (c.status !== "pending") throw new Error(`capture ${id} is already ${c.status}`);
  return c;
}

/** Ready to finish: closing, nothing in flight. */
export function readyToFinalize(tab: TabState, now: number): boolean {
  pruneExpired(tab, now);
  return (
    tab.status === "closing" &&
    Object.keys(tab.reservations).length === 0 &&
    !tab.captures.some((c) => c.status === "pending")
  );
}

export function markClosed(tab: TabState, voided: boolean): void {
  tab.status = "closed";
  tab.voided = voided;
}

/**
 * Split captured revenue between sellers. Each seller gets its settled amount
 * minus the platform fee, rounded down to cents; the platform keeps the fee and
 * the rounding dust. The sum never exceeds what was captured.
 */
export function computePayouts(tab: TabState, platformFeeBps: number): PayoutRecord {
  if (!Number.isInteger(platformFeeBps) || platformFeeBps < 0 || platformFeeBps > 10_000) throw new Error("fee must be 0..10000 bps");
  const capturedCents = tab.captures.filter((c) => c.status === "completed").reduce((s, c) => s + c.amountCents, 0);
  const bySeller = new Map<string, number>();
  for (const e of tab.entries) bySeller.set(e.seller, (bySeller.get(e.seller) ?? 0) + e.amountMicros);
  const lines: PayoutLine[] = [];
  for (const [seller, micros] of [...bySeller.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const net = Math.floor((micros * (10_000 - platformFeeBps)) / 10_000 / MICROS_PER_CENT);
    if (net > 0) lines.push({ seller, amountCents: net });
  }
  let paid = lines.reduce((s, l) => s + l.amountCents, 0);
  // Captures can fall short of settled value (budget headroom, failed capture); never pay out more than came in.
  while (paid > capturedCents && lines.length) {
    const biggest = lines.reduce((a, b) => (b.amountCents > a.amountCents ? b : a));
    const cut = Math.min(biggest.amountCents, paid - capturedCents);
    biggest.amountCents -= cut;
    paid -= cut;
    if (biggest.amountCents === 0) lines.splice(lines.indexOf(biggest), 1);
  }
  return { status: "pending", lines, platformFeeCents: capturedCents - paid };
}
