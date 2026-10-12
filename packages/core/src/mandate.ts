import { MICROS_PER_CENT } from "./money.ts";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
/**
 * PayPal authorizations stay valid for 29 days, but funds are only honored for
 * the first 3 days. A tab must finish inside the honor period, with a 12-hour
 * margin for retries, so captures never depend on funds PayPal no longer guarantees.
 */
export const MAX_TAB_LIFETIME_MS = 60 * HOUR_MS;

/** What the human approves before the agent may spend anything. */
export interface Mandate {
  tabId: string;
  currency: "USD";
  /** Equals the PayPal authorization amount. Whole cents. */
  budgetMicros: number;
  perCallCapMicros: number;
  /** Seller ids the agent may pay. */
  allowedSellers: string[];
  /** Epoch ms. */
  expiresAt: number;
  /** Batch size: capture once this much has accrued. Whole cents. */
  captureThresholdMicros: number;
  /** base64url raw Ed25519 public key of the agent. */
  agentPublicKey: string;
  purpose?: string;
}

export function validateMandate(m: Mandate, now: number): string[] {
  const problems: string[] = [];
  const intOk = (n: number) => Number.isSafeInteger(n) && n > 0;
  if (!m.tabId) problems.push("tabId is required");
  if (m.currency !== "USD") problems.push("only USD is supported");
  if (!intOk(m.budgetMicros) || m.budgetMicros % MICROS_PER_CENT !== 0) problems.push("budget must be a positive whole-cent amount");
  if (!intOk(m.perCallCapMicros)) problems.push("per-call cap must be positive");
  else if (intOk(m.budgetMicros) && m.perCallCapMicros > m.budgetMicros) problems.push("per-call cap exceeds budget");
  if (!intOk(m.captureThresholdMicros) || m.captureThresholdMicros % MICROS_PER_CENT !== 0) problems.push("capture threshold must be a positive whole-cent amount");
  else if (intOk(m.budgetMicros) && m.captureThresholdMicros > m.budgetMicros) problems.push("capture threshold exceeds budget");
  if (m.allowedSellers.length === 0) problems.push("at least one seller must be allowed");
  if (new Set(m.allowedSellers).size !== m.allowedSellers.length) problems.push("duplicate sellers");
  if (!(m.expiresAt > now)) problems.push("expiry must be in the future");
  if (m.expiresAt - now > MAX_TAB_LIFETIME_MS) problems.push("expiry must be within 60 hours (PayPal honors authorized funds for 3 days)");
  if (!/^[A-Za-z0-9_-]{43}$/.test(m.agentPublicKey)) problems.push("agentPublicKey must be a base64url Ed25519 key");
  return problems;
}
