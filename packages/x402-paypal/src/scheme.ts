import {
  MAX_CHARGE_TTL_MS,
  formatUsd,
  newNonce,
  parseUsd,
  signCharge,
  type AgentKeyPair,
  type SignedTabCharge,
  type TabCharge,
} from "@agent-tab/core";
import type {
  AssetAmount,
  Network,
  PaymentPayloadContext,
  PaymentPayloadResult,
  PaymentRequirements,
  Price,
  SchemeNetworkClient,
  SchemeNetworkServer,
  SupportedKind,
} from "@x402/core/types";

/**
 * `paypal-tab`: an x402-compatible custom scheme. The buyer's agent signs one
 * charge per call against a tab whose budget is a PayPal authorization; the
 * facilitator commits it to the tab ledger and captures from the
 * authorization in batches. Not an official x402 scheme.
 *
 * Wire format (x402 v2 PaymentRequirements):
 *   scheme  "paypal-tab"
 *   network "paypal:sandbox" | "paypal:simulated"
 *   asset   "USD" (ISO 4217, as the v2 spec allows for fiat)
 *   amount  integer micro-USD (1 USD = 1,000,000) so sub-cent prices are exact
 *   payTo   seller id registered with the facilitator
 *   extra   { amountUnit: "micro-USD", tabRequired: true }
 */
export const SCHEME = "paypal-tab";
export const ASSET = "USD";
export const AMOUNT_UNIT = "micro-USD";
export type PayPalNetwork = "paypal:sandbox" | "paypal:simulated";
export const NETWORKS: readonly PayPalNetwork[] = ["paypal:sandbox", "paypal:simulated"];

/** Scheme payload carried in PaymentPayload.payload. */
export interface PayPalTabPayload extends Record<string, unknown> {
  tabId: string;
  charge: TabCharge;
  signature: string;
}

export function isPayPalTabPayload(p: unknown): p is PayPalTabPayload {
  const x = p as PayPalTabPayload;
  return (
    !!x &&
    typeof x.tabId === "string" &&
    typeof x.signature === "string" &&
    !!x.charge &&
    typeof x.charge.tabId === "string" &&
    typeof x.charge.seller === "string" &&
    typeof x.charge.resource === "string" &&
    typeof x.charge.nonce === "string" &&
    Number.isSafeInteger(x.charge.amountMicros) &&
    Number.isSafeInteger(x.charge.issuedAt) &&
    Number.isSafeInteger(x.charge.expiresAt)
  );
}

export function toSignedCharge(p: PayPalTabPayload): SignedTabCharge {
  return { charge: p.charge, signature: p.signature };
}

/** Seller side: turns "$0.005" style prices into micro-USD requirements. */
export class PayPalTabServerScheme implements SchemeNetworkServer {
  readonly scheme = SCHEME;
  readonly defaultAssetTransferMethod = "default";
  // verify (read-only) before the tool runs, settle after it succeeded.
  readonly paymentFlows = { default: { supported: ["authorization"] as const, default: "authorization" as const } };

  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (!NETWORKS.includes(network as PayPalNetwork)) throw new Error(`paypal-tab does not support network ${network}`);
    if (typeof price === "object") {
      if (price.asset !== ASSET) throw new Error("paypal-tab prices must be in USD");
      return { asset: ASSET, amount: price.amount, extra: { amountUnit: AMOUNT_UNIT } };
    }
    const text = String(price).trim().replace(/^\$/, "").replace(/\s*USD$/i, "");
    return { asset: ASSET, amount: String(parseUsd(text)), extra: { amountUnit: AMOUNT_UNIT } };
  }

  getAssetDecimals(asset: string): number | undefined {
    return asset === ASSET ? 6 : undefined;
  }

  async enhancePaymentRequirements(req: PaymentRequirements, kind: SupportedKind): Promise<PaymentRequirements> {
    return { ...req, extra: { ...req.extra, ...(kind.extra ?? {}), amountUnit: AMOUNT_UNIT, tabRequired: true } };
  }
}

export interface TabSigner {
  tabId: string;
  keys: AgentKeyPair;
}

/**
 * Buyer side: signs a charge for exactly what the seller asked, against the
 * agent's current tab. `getTab` lets the agent switch tabs without rebuilding
 * the MCP client.
 */
export class PayPalTabClientScheme implements SchemeNetworkClient {
  readonly scheme = SCHEME;
  constructor(
    private readonly getTab: () => TabSigner | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  async createPaymentPayload(
    x402Version: number,
    req: PaymentRequirements,
    _context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    const tab = this.getTab();
    if (!tab) throw new Error("no open PayPal tab: ask the human to open one first");
    if (req.asset !== ASSET) throw new Error(`paypal-tab cannot pay in ${req.asset}`);
    const resource = typeof req.extra?.resource === "string" ? req.extra.resource : undefined;
    const issuedAt = this.now();
    const ttl = Math.min(MAX_CHARGE_TTL_MS, Math.max(1, req.maxTimeoutSeconds) * 1000);
    const charge: TabCharge = {
      tabId: tab.tabId,
      seller: req.payTo,
      resource: resource ?? `${req.payTo}`,
      amountMicros: Number(req.amount),
      nonce: newNonce(),
      issuedAt,
      expiresAt: issuedAt + ttl,
    };
    if (!Number.isSafeInteger(charge.amountMicros) || charge.amountMicros <= 0) throw new Error(`bad amount ${req.amount}`);
    const signed = signCharge(tab.keys, charge);
    const payload: PayPalTabPayload = { tabId: tab.tabId, charge: signed.charge, signature: signed.signature };
    return { x402Version, payload };
  }
}

export function describePrice(req: PaymentRequirements): string {
  return req.asset === ASSET ? `$${formatUsd(Number(req.amount))}` : `${req.amount} ${req.asset}`;
}
