import { randomBytes } from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import { signBytes, verifyBytes, type AgentKeyPair } from "./keys.ts";

/** Longest a signed charge may stay valid. Short, so a leaked charge is useless soon. */
export const MAX_CHARGE_TTL_MS = 5 * 60 * 1000;
/** Tolerated clock skew between agent and facilitator. */
export const CLOCK_SKEW_MS = 30 * 1000;

/** One per-call payment the agent authorizes against its tab. */
export interface TabCharge {
  tabId: string;
  seller: string;
  /** What is being bought, e.g. "mcp://newsroom/tools/get_article". */
  resource: string;
  amountMicros: number;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export interface SignedTabCharge {
  charge: TabCharge;
  /** base64url Ed25519 signature over canonicalJson(charge). */
  signature: string;
}

export function newNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function signCharge(keys: AgentKeyPair, charge: TabCharge): SignedTabCharge {
  return { charge, signature: signBytes(keys, canonicalJson(charge)) };
}

export function verifyChargeSignature(publicKey: string, signed: SignedTabCharge): boolean {
  return verifyBytes(publicKey, canonicalJson(signed.charge), signed.signature);
}
