import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import {
  HOUR_MS,
  MAX_TAB_LIFETIME_MS,
  activateTab,
  beginCapture,
  beginClose,
  checkCharge,
  completeCapture,
  computePayouts,
  createTab,
  failCapture,
  formatUsd,
  markClosed,
  parseUsd,
  planCapture,
  reserve,
  settle,
  totals,
  validateMandate,
  type CloseReason,
  type ExpectedTerms,
  type Mandate,
  type RejectCode,
  type TabState,
} from "@agent-tab/core";
import { PayPalError, type PayPalRail } from "@agent-tab/paypal";
import { ASSET, SCHEME, isPayPalTabPayload, toSignedCharge, type PayPalNetwork } from "@agent-tab/x402-paypal";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";

export interface SellerConfig {
  id: string;
  name: string;
  description: string;
  /** PayPal email that receives this seller's payout. */
  payoutReceiver: string;
  /** Shared secret the seller's server presents on /settle. */
  apiKey: string;
}

export interface FacilitatorConfig {
  /** Public base URL of this server, used for PayPal return/cancel links. */
  publicUrl: string;
  network: PayPalNetwork;
  platformFeeBps: number;
  sellers: SellerConfig[];
  dataFile?: string;
  now?: () => number;
}

/** What the agent asks for; the human may tighten it before approving. */
export interface TabTerms {
  budgetUsd: string;
  perCallCapUsd: string;
  captureThresholdUsd: string;
  sellers: string[];
  expiresInHours: number;
}

export interface TabRequest {
  tabId: string;
  agentPublicKey: string;
  purpose: string;
  agentName: string;
  suggested: TabTerms;
  createdAt: number;
}

interface TabRecord {
  request: TabRequest;
  state?: TabState;
  cancelled?: boolean;
}

export type TabEvent = { tabId: string; type: string; at: number; detail?: Record<string, unknown> };

const DEFAULT_TERMS: TabTerms = {
  budgetUsd: "5.00",
  perCallCapUsd: "0.50",
  captureThresholdUsd: "10.00",
  sellers: [],
  expiresInHours: 24,
};

function reasonCode(code: RejectCode): string {
  return code === "OVER_BUDGET" ? "insufficient_funds" : `invalid_paypal_tab_${code.toLowerCase()}`;
}

export class TabService {
  readonly events = new EventEmitter();
  private readonly tabs = new Map<string, TabRecord>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private readonly sellers: Map<string, SellerConfig>;

  constructor(
    readonly rail: PayPalRail,
    readonly config: FacilitatorConfig,
  ) {
    this.now = config.now ?? Date.now;
    this.sellers = new Map(config.sellers.map((s) => [s.id, s]));
    if (rail.mode === "sandbox" && config.network !== "paypal:sandbox") throw new Error("sandbox rail must use network paypal:sandbox");
    if (rail.mode === "simulated" && config.network !== "paypal:simulated") throw new Error("simulated rail must use network paypal:simulated");
    this.events.setMaxListeners(100);
    this.load();
  }

  // ---------- persistence: every state change is written before PayPal is called ----------

  private load(): void {
    const file = this.config.dataFile;
    if (!file || !existsSync(file)) return;
    const saved = JSON.parse(readFileSync(file, "utf8")) as { network: string; tabs: TabRecord[] };
    if (saved.network !== this.config.network) throw new Error(`${file} belongs to ${saved.network}, not ${this.config.network}`);
    for (const rec of saved.tabs) this.tabs.set(rec.request.tabId, rec);
  }

  private persist(): void {
    const file = this.config.dataFile;
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ network: this.config.network, tabs: [...this.tabs.values()] }, null, 1));
    renameSync(tmp, file);
  }

  private emit(tabId: string, type: string, detail?: Record<string, unknown>): void {
    const ev: TabEvent = { tabId, type, at: this.now(), ...(detail ? { detail } : {}) };
    this.events.emit("event", ev);
  }

  /** Serialize async work per tab (captures, close) so two flows never interleave. */
  private withLock<T>(tabId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(tabId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(tabId, next.catch(() => undefined));
    return next;
  }

  // ---------- sellers ----------

  publicSellers() {
    return this.config.sellers.map(({ id, name, description }) => ({ id, name, description }));
  }

  sellerForKey(apiKey: string | undefined): SellerConfig | undefined {
    if (!apiKey) return undefined;
    return this.config.sellers.find((s) => s.apiKey === apiKey);
  }

  // ---------- tab lifecycle ----------

  /** Step 1 (agent): ask for a tab. Nothing is authorized yet. */
  requestTab(input: { agentPublicKey: string; purpose: string; agentName?: string; suggested?: Partial<TabTerms> }): { tabId: string; reviewUrl: string } {
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.agentPublicKey)) throw new Error("agentPublicKey must be a base64url Ed25519 key");
    const tabId = `tab_${randomBytes(9).toString("base64url")}`;
    const suggested: TabTerms = { ...DEFAULT_TERMS, ...input.suggested };
    if (!suggested.sellers.length) suggested.sellers = this.config.sellers.map((s) => s.id);
    const request: TabRequest = {
      tabId,
      agentPublicKey: input.agentPublicKey,
      purpose: String(input.purpose ?? "").slice(0, 500),
      agentName: String(input.agentName ?? "AI agent").slice(0, 80),
      suggested,
      createdAt: this.now(),
    };
    this.tabs.set(tabId, { request });
    this.persist();
    this.emit(tabId, "tab_requested", { purpose: request.purpose });
    return { tabId, reviewUrl: `${this.config.publicUrl}/tab/${tabId}` };
  }

  termsToMandate(request: TabRequest, terms: TabTerms): Mandate {
    const unknown = terms.sellers.filter((s) => !this.sellers.has(s));
    if (unknown.length) throw new Error(`unknown sellers: ${unknown.join(", ")}`);
    const hours = Number(terms.expiresInHours);
    if (!(hours > 0)) throw new Error("expiresInHours must be positive");
    const budgetMicros = parseUsd(terms.budgetUsd);
    return {
      tabId: request.tabId,
      currency: "USD",
      budgetMicros,
      perCallCapMicros: parseUsd(terms.perCallCapUsd),
      // A threshold above the budget just means "capture once, at close".
      captureThresholdMicros: Math.min(parseUsd(terms.captureThresholdUsd), budgetMicros),
      allowedSellers: terms.sellers,
      expiresAt: this.now() + Math.round(hours * HOUR_MS),
      agentPublicKey: request.agentPublicKey,
      purpose: request.purpose,
    };
  }

  /** Step 2 (human): accept or tighten the terms, then go to PayPal to authorize the budget. */
  async approveTerms(tabId: string, terms: TabTerms): Promise<{ approveUrl: string }> {
    return this.withLock(tabId, async () => {
      const rec = this.mustGet(tabId);
      if (rec.state || rec.cancelled) throw new Error("this tab already has terms");
      const mandate = this.termsToMandate(rec.request, terms);
      const problems = validateMandate(mandate, this.now());
      if (problems.length) throw new Error(problems.join("; "));
      const state = createTab(mandate, this.now());
      const order = await this.rail.createAuthorizeOrder({
        tabId,
        amountCents: mandate.budgetMicros / 10_000,
        description: `AgentTab budget for ${rec.request.agentName}`,
        returnUrl: `${this.config.publicUrl}/paypal/return`,
        cancelUrl: `${this.config.publicUrl}/paypal/cancel`,
        requestId: `${tabId}-order`,
      });
      state.paypalOrderId = order.orderId;
      rec.state = state;
      this.persist();
      this.emit(tabId, "order_created", { orderId: order.orderId });
      return { approveUrl: order.approveUrl };
    });
  }

  findByOrder(orderId: string): TabRecord | undefined {
    return [...this.tabs.values()].find((r) => r.state?.paypalOrderId === orderId);
  }

  /** Step 3 (PayPal redirect): the human approved; authorize the order and open the tab. */
  async onApproved(orderId: string): Promise<string> {
    const rec = this.findByOrder(orderId);
    if (!rec?.state) throw new Error("unknown PayPal order");
    const tabId = rec.request.tabId;
    return this.withLock(tabId, async () => {
      const state = rec.state!;
      if (state.status !== "awaiting_approval") return tabId; // repeated redirect
      const auth = await this.rail.authorizeOrder(orderId, `${tabId}-authorize`);
      activateTab(state, { paypalOrderId: orderId, authorizationId: auth.authorizationId, authorizationExpiresAt: auth.expiresAt });
      this.persist();
      this.emit(tabId, "tab_active", { authorizationId: auth.authorizationId, budget: formatUsd(state.mandate.budgetMicros) });
      return tabId;
    });
  }

  async onCancelled(orderId: string): Promise<string | undefined> {
    const rec = this.findByOrder(orderId);
    if (!rec?.state) return undefined;
    if (rec.state.status === "awaiting_approval") {
      beginClose(rec.state, "closed_by_user");
      rec.cancelled = true;
      this.persist();
      this.emit(rec.request.tabId, "tab_cancelled");
    }
    return rec.request.tabId;
  }

  // ---------- x402 facilitator ----------

  supported(): SupportedResponse {
    return {
      kinds: [{ x402Version: 2, scheme: SCHEME, network: this.config.network, extra: { amountUnit: "micro-USD" } }],
      extensions: [],
      signers: {},
    };
  }

  private precheck(
    payload: PaymentPayload,
    req: PaymentRequirements,
  ): { ok: true; rec: TabRecord & { state: TabState }; expected: ExpectedTerms } | { ok: false; reason: string; message: string; payer?: string } {
    if (payload?.x402Version !== 2) return { ok: false, reason: "invalid_x402_version", message: "x402Version must be 2" };
    if (req?.scheme !== SCHEME) return { ok: false, reason: "unsupported_scheme", message: `only ${SCHEME} is supported` };
    if (req.network !== this.config.network) return { ok: false, reason: "invalid_network", message: `this facilitator settles on ${this.config.network}` };
    if (req.asset !== ASSET) return { ok: false, reason: "invalid_payment_requirements", message: "asset must be USD" };
    const a = payload.accepted;
    if (!a || a.scheme !== req.scheme || a.network !== req.network || a.amount !== req.amount || a.payTo !== req.payTo || a.asset !== req.asset) {
      return { ok: false, reason: "invalid_payment_requirements", message: "accepted requirements do not match" };
    }
    if (!this.sellers.has(req.payTo)) return { ok: false, reason: "invalid_payment_requirements", message: "payTo is not a registered seller" };
    if (!isPayPalTabPayload(payload.payload)) return { ok: false, reason: "invalid_payload", message: "malformed paypal-tab payload" };
    const p = payload.payload;
    const rec = this.tabs.get(p.tabId);
    if (!rec?.state || p.charge.tabId !== p.tabId) return { ok: false, reason: "invalid_paypal_tab_unknown_tab", message: "no such tab", payer: p.tabId };
    const resource = typeof req.extra?.resource === "string" ? req.extra.resource : req.payTo;
    return { ok: true, rec: rec as TabRecord & { state: TabState }, expected: { seller: req.payTo, resource, amountMicros: Number(req.amount) } };
  }

  /** Read-only, as the x402 spec requires of /verify. */
  verify(payload: PaymentPayload, req: PaymentRequirements): VerifyResponse {
    const pre = this.precheck(payload, req);
    if (!pre.ok) return { isValid: false, invalidReason: pre.reason, invalidMessage: pre.message, ...(pre.payer ? { payer: pre.payer } : {}) };
    const signed = toSignedCharge(payload.payload as never);
    const r = checkCharge(pre.rec.state, signed, this.now(), pre.expected);
    const payer = pre.rec.request.tabId;
    return r.ok ? { isValid: true, payer } : { isValid: false, invalidReason: reasonCode(r.code), invalidMessage: r.message, payer };
  }

  /**
   * Commit one paid call to the tab ledger (atomic check + record). Money moves
   * later, when the batch threshold is reached or the tab closes.
   */
  settle(payload: PaymentPayload, req: PaymentRequirements, seller: SellerConfig | undefined): SettleResponse {
    const network = this.config.network;
    const fail = (reason: string, message: string, payer?: string): SettleResponse => ({
      success: false,
      errorReason: reason,
      errorMessage: message,
      transaction: "",
      network,
      ...(payer ? { payer } : {}),
    });
    if (!seller || seller.id !== req?.payTo) return fail("invalid_paypal_tab_seller_auth", "settle must be called by the seller being paid");
    const pre = this.precheck(payload, req);
    if (!pre.ok) return fail(pre.reason, pre.message, pre.payer);
    const tab = pre.rec.state;
    const now = this.now();
    const held = reserve(tab, toSignedCharge(payload.payload as never), now, pre.expected);
    if (!held.ok) return fail(reasonCode(held.code), held.message, tab.mandate.tabId);
    const entry = settle(tab, held.value.nonce, now);
    if (!entry.ok) return fail(reasonCode(entry.code), entry.message, tab.mandate.tabId);
    this.persist();
    const t = totals(tab);
    this.emit(tab.mandate.tabId, "charge", {
      seq: entry.value.seq,
      seller: entry.value.seller,
      resource: entry.value.resource,
      amount: formatUsd(entry.value.amountMicros),
      spent: formatUsd(t.settledMicros),
      remaining: formatUsd(t.remainingMicros),
    });
    void this.maybeCapture(tab.mandate.tabId);
    return {
      success: true,
      transaction: `${tab.mandate.tabId}:${entry.value.seq}`,
      network,
      payer: tab.mandate.tabId,
      amount: String(entry.value.amountMicros),
      extra: { settlement: "ledger", captureMode: "batched", remainingMicros: t.remainingMicros },
    };
  }

  // ---------- captures ----------

  /** Capture once the threshold has accrued (or retry an in-flight capture). */
  maybeCapture(tabId: string): Promise<void> {
    return this.withLock(tabId, async () => {
      const tab = this.tabs.get(tabId)?.state;
      if (!tab || tab.status !== "active") return;
      await this.runCapture(tab, false);
    });
  }

  /**
   * One capture attempt. The capture record (with its PayPal-Request-Id) is
   * persisted before PayPal is called. Ambiguous failures (network, 5xx) keep
   * the record pending and are retried with the same Request-Id, so PayPal's
   * idempotency guarantees no double capture. Definitive failures freeze the tab.
   */
  private async runCapture(tab: TabState, final: boolean): Promise<void> {
    const tabId = tab.mandate.tabId;
    let rec = tab.captures.find((c) => c.status === "pending");
    if (!rec) {
      const cents = planCapture(tab, final);
      if (!cents) return;
      rec = beginCapture(tab, cents, final, this.now());
      this.persist();
    }
    this.emit(tabId, "capture_started", { id: rec.id, amount: formatUsd(rec.amountCents * 10_000), final: rec.final });
    try {
      const result = await this.rail.captureAuthorization({
        authorizationId: tab.authorizationId!,
        amountCents: rec.amountCents,
        final: rec.final,
        requestId: rec.requestId,
        invoiceId: `${tabId}-${rec.id}`,
        noteToPayer: `AgentTab: ${tab.entries.length} paid tool calls so far`,
      });
      completeCapture(tab, rec.id, result.captureId);
      this.persist();
      this.emit(tabId, "capture_completed", { id: rec.id, captureId: result.captureId, status: result.status, amount: formatUsd(rec.amountCents * 10_000) });
    } catch (err) {
      const e = err as PayPalError;
      if (e instanceof PayPalError && !e.retryable) {
        failCapture(tab, rec.id, `${e.code}: ${e.message}`);
        beginClose(tab, "capture_failed");
        this.persist();
        this.emit(tabId, "capture_failed", { id: rec.id, code: e.code, debugId: e.debugId, frozen: true });
      } else {
        this.emit(tabId, "capture_retry_pending", { id: rec.id, error: String((err as Error).message) });
      }
    }
  }

  // ---------- close ----------

  /**
   * Close (or revoke) the tab: stop new charges, capture what was used, release
   * the rest of the authorization, then pay sellers their share.
   */
  close(tabId: string, reason: CloseReason): Promise<ReturnType<TabService["view"]>> {
    return this.withLock(tabId, async () => {
      const rec = this.mustGet(tabId);
      const tab = rec.state;
      if (!tab) {
        rec.cancelled = true;
        this.persist();
        this.emit(tabId, "tab_cancelled");
        return this.view(tabId);
      }
      if (tab.status === "closed") return this.view(tabId);
      beginClose(tab, reason);
      this.persist();
      this.emit(tabId, "tab_closing", { reason });
      if ((tab.status as TabState["status"]) === "closed") return this.view(tabId); // was never authorized

      if (tab.captures.some((c) => c.status === "pending")) await this.runCapture(tab, false);
      if (tab.captures.some((c) => c.status === "pending")) return this.view(tabId); // retry later

      await this.runCapture(tab, true);
      if (tab.captures.some((c) => c.status === "pending")) return this.view(tabId);

      const finalDone = tab.captures.some((c) => c.final && c.status === "completed");
      let voided = false;
      if (!finalDone && tab.authorizationId) {
        try {
          await this.rail.voidAuthorization(tab.authorizationId, `${tabId}-void`);
          voided = true;
          this.emit(tabId, "authorization_voided");
        } catch (err) {
          this.emit(tabId, "void_failed", { error: String((err as Error).message) });
        }
      }

      if (!tab.payout) {
        const payout = computePayouts(tab, this.config.platformFeeBps);
        tab.payout = payout;
        this.persist();
        if (payout.lines.length) {
          try {
            const res = await this.rail.createPayouts({
              batchId: `${tabId}-payout`,
              emailSubject: "You were paid by an AI agent via AgentTab",
              items: payout.lines.map((l) => ({
                receiver: this.sellers.get(l.seller)?.payoutReceiver ?? "",
                amountCents: l.amountCents,
                note: `Paid tool calls on ${tabId}`,
                itemId: `${tabId}-${l.seller}`,
              })),
            });
            payout.status = "completed";
            payout.batchId = res.payoutBatchId;
            this.emit(tabId, "payout_sent", { batchId: res.payoutBatchId, lines: payout.lines });
          } catch (err) {
            payout.status = "failed";
            payout.error = String((err as Error).message);
            this.emit(tabId, "payout_failed", { error: payout.error });
          }
        } else {
          payout.status = "completed";
        }
      }
      markClosed(tab, voided);
      this.persist();
      this.emit(tabId, "tab_closed", { reason: tab.closeReason });
      return this.view(tabId);
    });
  }

  /** Close tabs whose mandate expired; retry stuck captures. Call periodically. */
  async sweep(): Promise<void> {
    const now = this.now();
    for (const rec of this.tabs.values()) {
      const tab = rec.state;
      if (!tab) continue;
      const expiry = Math.min(tab.mandate.expiresAt, tab.authorizationExpiresAt ?? Infinity);
      if ((tab.status === "active" && now >= expiry) || tab.status === "closing") {
        await this.close(tab.mandate.tabId, "expired");
      } else if (tab.status === "active" && tab.captures.some((c) => c.status === "pending")) {
        await this.maybeCapture(tab.mandate.tabId);
      }
    }
  }

  // ---------- views ----------

  private mustGet(tabId: string): TabRecord {
    const rec = this.tabs.get(tabId);
    if (!rec) throw new Error("unknown tab");
    return rec;
  }

  has(tabId: string): boolean {
    return this.tabs.has(tabId);
  }

  view(tabId: string) {
    const rec = this.mustGet(tabId);
    const tab = rec.state;
    const base = {
      tabId,
      rail: this.rail.mode,
      network: this.config.network,
      agentName: rec.request.agentName,
      purpose: rec.request.purpose,
      suggested: rec.request.suggested,
      sellers: this.publicSellers(),
      maxLifetimeHours: MAX_TAB_LIFETIME_MS / HOUR_MS,
    };
    if (!tab) return { ...base, status: rec.cancelled ? "cancelled" : "requested" };
    const t = totals(tab);
    return {
      ...base,
      status: rec.cancelled ? "cancelled" : tab.status,
      closeReason: tab.closeReason,
      mandate: {
        budget: formatUsd(tab.mandate.budgetMicros),
        perCallCap: formatUsd(tab.mandate.perCallCapMicros),
        captureThreshold: formatUsd(tab.mandate.captureThresholdMicros),
        allowedSellers: tab.mandate.allowedSellers,
        expiresAt: new Date(tab.mandate.expiresAt).toISOString(),
      },
      paypal: {
        orderId: tab.paypalOrderId,
        authorizationId: tab.authorizationId,
        authorizationExpiresAt: tab.authorizationExpiresAt ? new Date(tab.authorizationExpiresAt).toISOString() : undefined,
        voided: tab.voided,
      },
      totals: {
        spent: formatUsd(t.settledMicros),
        remaining: formatUsd(Math.max(0, t.remainingMicros)),
        captured: formatUsd(t.capturedCents * 10_000),
        uncaptured: formatUsd(Math.max(0, t.uncapturedMicros)),
        calls: t.callCount,
      },
      entries: tab.entries.map((e) => ({ ...e, amount: formatUsd(e.amountMicros) })),
      captures: tab.captures.map((c) => ({ ...c, amount: formatUsd(c.amountCents * 10_000) })),
      payout: tab.payout
        ? { ...tab.payout, lines: tab.payout.lines.map((l) => ({ ...l, amount: formatUsd(l.amountCents * 10_000) })), platformFee: formatUsd(tab.payout.platformFeeCents * 10_000) }
        : undefined,
    };
  }
}
