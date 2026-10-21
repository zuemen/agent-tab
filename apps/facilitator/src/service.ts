import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  HOUR_MS,
  MAX_TAB_LIFETIME_MS,
  activateTab,
  beginCapture,
  beginClose,
  checkCharge,
  planRefund,
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
  type RefundRecord,
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
  /** sha256 of the owner key. The key itself is only ever given to the human. */
  ownerKeyHash: string;
}

interface TabRecord {
  request: TabRequest;
  state?: TabState;
  cancelled?: boolean;
  /** Payout emails fixed when the human approved, so config changes cannot redirect them. */
  payoutReceivers?: Record<string, string>;
  /** Shown to the owner, e.g. why PayPal did not open the tab. */
  notice?: string;
  /**
   * sha256 of a secret held in a cookie by the browser that sent the owner to
   * PayPal. Only that browser receives the new owner key when PayPal sends it back.
   */
  approvalBindingHash?: string;
}

/** PayPal errors after which retrying the same capture cannot succeed. */
const DEFINITIVE_CAPTURE_ERRORS = new Set([
  "AUTHORIZATION_EXPIRED",
  "AUTHORIZATION_VOIDED",
  "AUTHORIZATION_ALREADY_CAPTURED",
  "AUTHORIZATION_ALREADY_COMPLETED",
  "PREVIOUSLY_CAPTURED",
  "PREVIOUSLY_VOIDED",
  "MAX_CAPTURE_AMOUNT_EXCEEDED",
  "MAX_CAPTURE_COUNT_EXCEEDED",
  "DECLINED",
  "FAILED",
]);
/** Void errors that mean there is nothing left to release. */
const NOTHING_TO_VOID = new Set([
  "PREVIOUSLY_CAPTURED",
  "AUTHORIZATION_ALREADY_CAPTURED",
  "AUTHORIZATION_VOIDED",
  "PREVIOUSLY_VOIDED",
  "AUTHORIZATION_EXPIRED",
  "AUTHORIZATION_ALREADY_COMPLETED",
]);

/** Capture statuses after which PayPal will not collect the money. */
const FAILED_CAPTURE_STATUSES = new Set(["DECLINED", "FAILED"]);

/** Closing steps (void, payout) are retried this many times with backoff, then given up for manual follow-up. */
export const MAX_CLOSE_ATTEMPTS = 8;
const RETRY_BASE_MS = 60 * 1000;
const RETRY_MAX_MS = 60 * 60 * 1000;
const backoff = (attempts: number) => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));

/** Worth retrying later: network, 5xx, 429, and auth or conflict problems on our side. */
function isTemporary(e: unknown): boolean {
  if (!(e instanceof PayPalError)) return true;
  return e.retryable || e.httpStatus === 401 || e.httpStatus === 403 || e.httpStatus === 409;
}

function isDefinitive(e: unknown): boolean {
  return e instanceof PayPalError && (e.httpStatus === 422 || DEFINITIVE_CAPTURE_ERRORS.has(e.code));
}

const hashKey = (key: string) => createHash("sha256").update(key).digest();

/** A problem with the caller's request; safe to show to them. */
export class UserError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "UserError";
  }
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
  requestTab(input: { agentPublicKey: string; purpose: string; agentName?: string; suggested?: Partial<TabTerms> }): { tabId: string; reviewUrl: string; ownerKey: string } {
    if (!/^[A-Za-z0-9_-]{43}$/.test(String(input.agentPublicKey))) throw new UserError("agentPublicKey must be a base64url Ed25519 key");
    const tabId = `tab_${randomBytes(9).toString("base64url")}`;
    const ownerKey = randomBytes(24).toString("base64url");
    const s = input.suggested ?? {};
    const str = (v: unknown, d: string) => (typeof v === "string" && v.length <= 16 ? v : d);
    const suggested: TabTerms = {
      budgetUsd: str(s.budgetUsd, DEFAULT_TERMS.budgetUsd),
      perCallCapUsd: str(s.perCallCapUsd, DEFAULT_TERMS.perCallCapUsd),
      captureThresholdUsd: str(s.captureThresholdUsd, DEFAULT_TERMS.captureThresholdUsd),
      expiresInHours: Number.isFinite(Number(s.expiresInHours)) ? Number(s.expiresInHours) : DEFAULT_TERMS.expiresInHours,
      sellers: Array.isArray(s.sellers) ? s.sellers.filter((x): x is string => typeof x === "string" && this.sellers.has(x)).slice(0, 20) : [],
    };
    if (!suggested.sellers.length) suggested.sellers = this.config.sellers.map((x) => x.id);
    const request: TabRequest = {
      tabId,
      agentPublicKey: input.agentPublicKey,
      purpose: String(input.purpose ?? "").slice(0, 500),
      agentName: String(input.agentName ?? "AI agent").slice(0, 80),
      suggested,
      createdAt: this.now(),
      ownerKeyHash: hashKey(ownerKey).toString("base64url"),
    };
    this.tabs.set(tabId, { request });
    this.persist();
    this.emit(tabId, "tab_requested", { purpose: request.purpose });
    // The owner key rides in the URL fragment: browsers never send it to servers or in Referer.
    return { tabId, reviewUrl: `${this.config.publicUrl}/tab/${tabId}#owner=${ownerKey}`, ownerKey };
  }

  /** Only the holder of the owner key may set terms, close, revoke, ask, or refund. */
  isOwner(tabId: string, key: string | undefined): boolean {
    const rec = this.tabs.get(tabId);
    // Records saved before owner keys existed have no hash: nobody owns them.
    if (!rec || !key || typeof rec.request.ownerKeyHash !== "string") return false;
    const want = Buffer.from(rec.request.ownerKeyHash, "base64url");
    const got = hashKey(key);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  termsToMandate(request: TabRequest, terms: TabTerms): Mandate {
    if (!Array.isArray(terms.sellers) || terms.sellers.length > 20) throw new UserError("sellers must be a list");
    const unknown = terms.sellers.filter((s) => !this.sellers.has(s));
    if (unknown.length) throw new UserError(`unknown sellers: ${unknown.join(", ")}`);
    const hours = Number(terms.expiresInHours);
    if (!(hours > 0)) throw new UserError("expiresInHours must be positive");
    const usd = (v: unknown, field: string) => {
      try {
        return parseUsd(String(v));
      } catch {
        throw new UserError(`${field} must be a dollar amount like 1.50`);
      }
    };
    const budgetMicros = usd(terms.budgetUsd, "budget");
    return {
      tabId: request.tabId,
      currency: "USD",
      budgetMicros,
      perCallCapMicros: usd(terms.perCallCapUsd, "per-call cap"),
      // A threshold above the budget just means "capture once, at close".
      captureThresholdMicros: Math.min(usd(terms.captureThresholdUsd, "capture threshold"), budgetMicros),
      allowedSellers: terms.sellers,
      expiresAt: this.now() + Math.round(hours * HOUR_MS),
      agentPublicKey: request.agentPublicKey,
      purpose: request.purpose,
    };
  }

  /**
   * Step 2 (human): accept or tighten the terms, then go to PayPal to authorize the budget.
   * `binding` goes into a cookie in the owner's browser (see onApproved).
   */
  async approveTerms(tabId: string, terms: TabTerms): Promise<{ approveUrl: string; binding: string }> {
    return this.withLock(tabId, async () => {
      const rec = this.mustGet(tabId);
      if (rec.state || rec.cancelled) throw new UserError("this tab already has terms");
      const mandate = this.termsToMandate(rec.request, terms);
      const problems = validateMandate(mandate, this.now());
      if (problems.length) throw new UserError(problems.join("; "));
      const state = createTab(mandate, this.now());
      // The terms also appear on PayPal's own approval page, so the human sees them where they approve.
      const n = mandate.allowedSellers.length;
      const order = await this.rail.createAuthorizeOrder({
        tabId,
        amountCents: mandate.budgetMicros / 10_000,
        description: `AgentTab: max $${formatUsd(mandate.perCallCapMicros)}/call, ${n} seller${n === 1 ? "" : "s"}, ${Math.round(Number(terms.expiresInHours))}h`,
        returnUrl: `${this.config.publicUrl}/paypal/return`,
        cancelUrl: `${this.config.publicUrl}/paypal/cancel`,
        requestId: `${tabId}-order`,
      });
      state.paypalOrderId = order.orderId;
      rec.state = state;
      const binding = randomBytes(24).toString("base64url");
      rec.approvalBindingHash = hashKey(binding).toString("base64url");
      rec.payoutReceivers = Object.fromEntries(mandate.allowedSellers.map((id) => [id, this.sellers.get(id)!.payoutReceiver]));
      this.persist();
      this.emit(tabId, "order_created", { orderId: order.orderId });
      return { approveUrl: order.approveUrl, binding };
    });
  }

  findByOrder(orderId: string): TabRecord | undefined {
    return [...this.tabs.values()].find((r) => r.state?.paypalOrderId === orderId);
  }

  /**
   * Step 3 (PayPal redirect): the human approved; authorize the order and open the tab.
   * If the redirect arrives in the browser that went to PayPal (it holds the
   * binding cookie), the owner key is replaced and the new one returned for that
   * browser only. The key in the review link, which the requesting agent also
   * saw, then stops working.
   */
  async onApproved(orderId: string, binding?: string): Promise<{ tabId: string; ownerKey?: string }> {
    const rec = this.findByOrder(orderId);
    if (!rec?.state) throw new UserError("unknown PayPal order");
    const tabId = rec.request.tabId;
    return this.withLock(tabId, async () => {
      const state = rec.state!;
      if (state.status !== "awaiting_approval") return { tabId }; // repeated redirect
      const auth = await this.rail.authorizeOrder(orderId, `${tabId}-authorize`);
      if (auth.status !== "CREATED") {
        // DENIED or PENDING (under review): funds are not guaranteed, so the tab never opens.
        if (auth.status === "PENDING") await this.rail.voidAuthorization(auth.authorizationId, `${tabId}-void`).catch(() => undefined);
        beginClose(state, "closed_by_user");
        rec.cancelled = true;
        rec.notice = `PayPal returned authorization status ${auth.status}; the tab was not opened and nothing will be charged.`;
        this.persist();
        this.emit(tabId, "tab_cancelled", { authorizationStatus: auth.status });
        return { tabId };
      }
      activateTab(state, { paypalOrderId: orderId, authorizationId: auth.authorizationId, authorizationExpiresAt: auth.expiresAt });
      let ownerKey: string | undefined;
      if (binding && rec.approvalBindingHash && timingSafeEqual(hashKey(binding), Buffer.from(rec.approvalBindingHash, "base64url"))) {
        ownerKey = randomBytes(24).toString("base64url");
        rec.request.ownerKeyHash = hashKey(ownerKey).toString("base64url");
        delete rec.approvalBindingHash;
      }
      this.persist();
      this.emit(tabId, "tab_active", { authorizationId: auth.authorizationId, budget: formatUsd(state.mandate.budgetMicros), ownerKeyRotated: !!ownerKey });
      return ownerKey ? { tabId, ownerKey } : { tabId };
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
    this.maybeCapture(tab.mandate.tabId).catch((err) => console.error("capture", tab.mandate.tabId, err));
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
   * Ask PayPal what it actually captured on this order and adopt any capture
   * our records missed (matched by invoice id). PayPal is the source of truth:
   * a capture it later declines stops counting and freezes an open tab.
   * Returns false when PayPal could not be asked, so callers judge nothing.
   */
  private async reconcile(tab: TabState): Promise<boolean> {
    if (!tab.paypalOrderId) return true;
    let found;
    try {
      found = await this.rail.getOrderCaptures(tab.paypalOrderId);
    } catch {
      return false; // keep local state; try again later
    }
    const tabId = tab.mandate.tabId;
    for (const rec of tab.captures) {
      const pp = found.find((c) => c.invoiceId === `${tabId}-${rec.id}`);
      if (!pp) continue;
      const counts = pp.status === "COMPLETED" || pp.status === "PENDING";
      if (counts && rec.status !== "completed") {
        rec.status = "completed";
        delete rec.error;
        this.emit(tabId, "capture_reconciled", { id: rec.id, captureId: pp.captureId, status: pp.status });
      }
      if (counts) {
        rec.paypalCaptureId = pp.captureId;
        rec.paypalStatus = pp.status;
      } else if (FAILED_CAPTURE_STATUSES.has(pp.status) && rec.status !== "failed") {
        rec.status = "failed";
        rec.paypalCaptureId = pp.captureId;
        rec.paypalStatus = pp.status;
        rec.error = `PayPal reported the capture ${pp.status}`;
        if (tab.status === "active") beginClose(tab, "capture_failed");
        this.emit(tabId, "capture_failed", { id: rec.id, captureId: pp.captureId, status: pp.status, frozen: true });
      }
    }
    this.persist();
    return true;
  }

  /**
   * One capture attempt. The capture record (with its PayPal-Request-Id) is
   * persisted before PayPal is called. Unclear failures (network, 5xx, auth
   * problems on our side) keep the record pending and are retried with the same
   * Request-Id after checking PayPal, so nothing is captured twice. Only a
   * definitive refusal, confirmed against PayPal's records, freezes the tab.
   */
  private async runCapture(tab: TabState, final: boolean): Promise<void> {
    const tabId = tab.mandate.tabId;
    let rec = tab.captures.find((c) => c.status === "pending");
    if (rec) {
      await this.reconcile(tab);
      if (rec.status !== "pending") return;
    } else {
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
        // Fixed per record: a retry must send the same body as the first attempt.
        noteToPayer: `AgentTab usage capture ${rec.id}`,
      });
      if (result.status !== "COMPLETED" && result.status !== "PENDING") {
        throw new PayPalError(`capture returned status ${result.status}`, 422, result.status);
      }
      completeCapture(tab, rec.id, result.captureId);
      rec.paypalStatus = result.status;
      this.persist();
      this.emit(tabId, "capture_completed", { id: rec.id, captureId: result.captureId, status: result.status, amount: formatUsd(rec.amountCents * 10_000) });
    } catch (err) {
      if (isDefinitive(err)) {
        // Did PayPal take the money anyway? If we cannot find out, judge nothing:
        // the record stays pending and is retried with the same PayPal-Request-Id.
        const asked = await this.reconcile(tab);
        if (rec.status !== "pending") return;
        if (!asked) {
          this.emit(tabId, "capture_retry_pending", { id: rec.id, error: "PayPal refused the capture and its records could not be checked" });
          return;
        }
        const e = err as PayPalError;
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
   * the rest of the authorization, then pay sellers their share. Any step that
   * fails for a temporary reason leaves the tab "closing"; sweep() resumes it.
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

      // 1. Capture: finish anything in flight, then the remainder.
      await this.reconcile(tab);
      if (tab.captures.some((c) => c.status === "pending")) await this.runCapture(tab, false);
      if (tab.captures.some((c) => c.status === "pending")) return this.view(tabId);
      await this.runCapture(tab, true);
      if (tab.captures.some((c) => c.status === "pending")) return this.view(tabId);

      // Wait until PayPal has settled every capture: one it declines must still be
      // retried against the authorization, so nothing is released or paid out before.
      if (tab.captures.some((c) => c.status === "completed" && c.paypalStatus === "PENDING")) {
        this.emit(tabId, "payout_waiting", { reason: "a capture is still PENDING at PayPal" });
        return this.view(tabId);
      }

      // 2. Release the unused part of the authorization. A failure here never holds up the sellers' payouts.
      if (!tab.voidStatus || tab.voidStatus === "retrying") {
        if (tab.captures.some((c) => c.final && c.status === "completed") || !tab.authorizationId) {
          tab.voidStatus = "not_needed";
        } else {
          try {
            await this.rail.voidAuthorization(tab.authorizationId, `${tabId}-void`);
            tab.voidStatus = "voided";
            tab.voided = true;
            this.emit(tabId, "authorization_voided");
          } catch (err) {
            if (err instanceof PayPalError && NOTHING_TO_VOID.has(err.code)) {
              tab.voidStatus = "not_needed";
            } else {
              tab.voidAttempts = (tab.voidAttempts ?? 0) + 1;
              const willRetry = isTemporary(err) && tab.voidAttempts < MAX_CLOSE_ATTEMPTS;
              tab.voidStatus = willRetry ? "retrying" : "failed";
              if (willRetry) tab.retryAt = this.now() + backoff(tab.voidAttempts);
              this.emit(tabId, "void_failed", { error: String((err as Error).message), willRetry });
            }
          }
        }
        this.persist();
      }

      // 3. Pay sellers, once confirmed refunds have gone through: they come out of the payout.
      if (!tab.payout) {
        for (const r of tab.refunds ?? []) await this.runRefund(tab, r);
        if (tab.refunds?.some((r) => r.status === "pending")) {
          this.emit(tabId, "payout_waiting", { reason: "a confirmed refund is still being processed" });
          return this.view(tabId);
        }
      }
      if (!tab.payout || tab.payout.status === "pending") {
        const payout = tab.payout ?? computePayouts(tab, this.config.platformFeeBps);
        tab.payout = payout;
        this.persist(); // write-ahead: a restart retries the same batch id
        if (payout.lines.length) {
          try {
            const res = await this.rail.createPayouts({
              batchId: `${tabId}-payout`,
              emailSubject: "You were paid by an AI agent via AgentTab",
              items: payout.lines.map((l) => ({
                receiver: rec.payoutReceivers?.[l.seller] ?? this.sellers.get(l.seller)?.payoutReceiver ?? "",
                amountCents: l.amountCents,
                note: `Paid tool calls on ${tabId}`,
                itemId: `${tabId}-${l.seller}`,
              })),
            });
            payout.status = "completed";
            payout.batchId = res.payoutBatchId;
            this.emit(tabId, "payout_sent", { batchId: res.payoutBatchId, lines: payout.lines });
          } catch (err) {
            payout.attempts = (payout.attempts ?? 0) + 1;
            if (isTemporary(err) && payout.attempts < MAX_CLOSE_ATTEMPTS) {
              tab.retryAt = this.now() + backoff(payout.attempts);
              this.persist();
              this.emit(tabId, "payout_retry_pending", { error: String((err as Error).message) });
              return this.view(tabId); // retried by sweep
            }
            payout.status = "failed";
            payout.error = String((err as Error).message);
            this.emit(tabId, "payout_failed", { error: payout.error });
          }
        } else {
          payout.status = "completed";
        }
      }
      if (tab.voidStatus === "retrying") {
        this.persist();
        return this.view(tabId); // sellers are paid; sweep keeps trying to release the rest
      }
      markClosed(tab, tab.voidStatus === "voided");
      this.persist();
      this.emit(tabId, "tab_closed", { reason: tab.closeReason });
      return this.view(tabId);
    });
  }

  // ---------- refunds (proposed by the assistant, confirmed by the owner) ----------

  proposeRefund(tabId: string, entrySeq: number, reason: string): RefundRecord {
    const tab = this.mustGet(tabId).state;
    if (!tab) throw new UserError("this tab has no charges");
    const plan = planRefund(tab, entrySeq);
    if (!plan.ok) throw new UserError(plan.message);
    tab.refunds ??= [];
    const n = tab.refunds.length + 1;
    const refund: RefundRecord = {
      id: `ref_${n}`,
      entrySeq,
      seller: plan.value.seller,
      amountCents: plan.value.amountCents,
      paypalCaptureId: plan.value.paypalCaptureId,
      requestId: `${tabId}-refund-${n}`,
      reason: String(reason ?? "").slice(0, 200),
      status: "proposed",
      createdAt: this.now(),
    };
    tab.refunds.push(refund);
    this.persist();
    this.emit(tabId, "refund_proposed", { id: refund.id, entrySeq, amount: formatUsd(refund.amountCents * 10_000) });
    return refund;
  }

  /** Execute a proposed refund. Re-confirming a pending one retries it. */
  confirmRefund(tabId: string, refundId: string): Promise<RefundRecord> {
    return this.withLock(tabId, async () => {
      const tab = this.mustGet(tabId).state;
      const refund = tab?.refunds?.find((r) => r.id === refundId);
      if (!tab || !refund) throw new UserError("unknown refund");
      if (refund.status === "completed" || refund.status === "failed") return refund;
      if (refund.status === "proposed") {
        refund.status = "pending";
        // Fixed at the first confirm: was this seller already paid when the owner decided?
        refund.afterPayout = !!tab.payout;
        this.persist();
      }
      await this.runRefund(tab, refund);
      return refund;
    });
  }

  /**
   * One attempt at a pending refund. A retry first asks PayPal whether the
   * refund already happened (matched by invoice id) instead of trusting
   * PayPal-Request-Id caching to stop a second refund.
   */
  private async runRefund(tab: TabState, refund: RefundRecord): Promise<void> {
    if (refund.status !== "pending") return;
    const tabId = tab.mandate.tabId;
    const invoiceId = `${tabId}-${refund.id}`;
    if (refund.attempts && tab.paypalOrderId) {
      let found;
      try {
        found = (await this.rail.getOrderRefunds(tab.paypalOrderId)).find((r) => r.invoiceId === invoiceId);
      } catch {
        // Cannot tell whether it happened: do not send it again yet. Bounded like any other retry.
        refund.attempts++;
        refund.error = "PayPal's records could not be checked";
        if (refund.attempts >= MAX_CLOSE_ATTEMPTS) {
          refund.status = "failed";
          refund.error += "; check the capture in PayPal before refunding by hand";
          this.emit(tabId, "refund_failed", { id: refund.id, error: refund.error });
        } else {
          tab.retryAt = this.now() + backoff(refund.attempts);
          this.emit(tabId, "refund_retry_pending", { id: refund.id, error: refund.error });
        }
        this.persist();
        return;
      }
      if (found && found.status !== "FAILED" && found.status !== "CANCELLED") {
        refund.status = "completed";
        refund.paypalRefundId = found.refundId;
        delete refund.error;
        this.persist();
        this.emit(tabId, "refund_completed", { id: refund.id, refundId: found.refundId, amount: formatUsd(refund.amountCents * 10_000) });
        return;
      }
    }
    refund.attempts = (refund.attempts ?? 0) + 1;
    this.persist(); // write-ahead: a crash after this point is resolved by the lookup above
    try {
      const res = await this.rail.refundCapture({
        captureId: refund.paypalCaptureId,
        amountCents: refund.amountCents,
        requestId: refund.requestId,
        invoiceId,
        noteToPayer: `AgentTab refund: paid call #${refund.entrySeq}`,
      });
      if (res.status === "FAILED" || res.status === "CANCELLED") throw new PayPalError(`refund returned status ${res.status}`, 422, res.status);
      refund.status = "completed";
      refund.paypalRefundId = res.refundId;
      delete refund.error;
      this.emit(tabId, "refund_completed", { id: refund.id, refundId: res.refundId, amount: formatUsd(refund.amountCents * 10_000) });
    } catch (err) {
      refund.error = String((err as Error).message);
      if (isDefinitive(err) || refund.attempts >= MAX_CLOSE_ATTEMPTS) {
        refund.status = "failed";
        this.emit(tabId, "refund_failed", { id: refund.id, error: refund.error });
      } else {
        tab.retryAt = this.now() + backoff(refund.attempts);
        this.emit(tabId, "refund_retry_pending", { id: refund.id, error: refund.error });
      }
    }
    this.persist();
  }

  /** Close expired tabs, resume interrupted closes, retry stuck captures, refresh PENDING captures. Call periodically. */
  async sweep(): Promise<void> {
    const now = this.now();
    for (const rec of this.tabs.values()) {
      const tab = rec.state;
      if (!tab) continue;
      const tabId = tab.mandate.tabId;
      try {
        const expiry = Math.min(tab.mandate.expiresAt, tab.authorizationExpiresAt ?? Infinity);
        if (tab.status === "closing" && (tab.retryAt ?? 0) > now) continue; // backing off
        if ((tab.status === "active" && now >= expiry) || tab.status === "closing") {
          await this.close(tabId, "expired");
        } else if (tab.status === "active" && tab.captures.some((c) => c.status === "pending")) {
          await this.maybeCapture(tabId);
        } else if (tab.captures.some((c) => c.paypalStatus === "PENDING")) {
          await this.withLock(tabId, () => this.reconcile(tab));
        }
        if (tab.status !== "closing" && (tab.retryAt ?? 0) <= now && tab.refunds?.some((r) => r.status === "pending")) {
          await this.withLock(tabId, async () => {
            for (const r of tab.refunds ?? []) await this.runRefund(tab, r);
          });
        }
      } catch (err) {
        console.error("sweep", tabId, err);
      }
    }
  }

  // ---------- views ----------

  private mustGet(tabId: string): TabRecord {
    const rec = this.tabs.get(tabId);
    if (!rec) throw new UserError("unknown tab", 404);
    return rec;
  }

  has(tabId: string): boolean {
    return this.tabs.has(tabId);
  }

  /** What anyone holding the tab id (agent, seller) may see. */
  publicView(tabId: string) {
    const rec = this.mustGet(tabId);
    const tab = rec.state;
    const status = rec.cancelled ? "cancelled" : tab ? tab.status : "requested";
    if (!tab) return { tabId, status };
    const t = totals(tab);
    return { tabId, status, remaining: formatUsd(Math.max(0, t.remainingMicros)), perCallCap: formatUsd(tab.mandate.perCallCapMicros), allowedSellers: tab.mandate.allowedSellers };
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
    if (!tab) return { ...base, status: rec.cancelled ? "cancelled" : "requested", ...(rec.notice ? { notice: rec.notice } : {}) };
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
        voidStatus: tab.voidStatus,
      },
      ...(rec.notice ? { notice: rec.notice } : {}),
      refunds: (tab.refunds ?? []).map((r) => ({ ...r, amount: formatUsd(r.amountCents * 10_000) })),
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
