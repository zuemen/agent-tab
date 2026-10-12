import { randomBytes } from "node:crypto";
import { DAY_MS } from "@agent-tab/core";
import {
  PayPalError,
  type AuthorizedOrder,
  type CaptureInput,
  type CaptureResult,
  type CreateAuthorizeOrderInput,
  type CreatedOrder,
  type OrderCapture,
  type PayoutInput,
  type PayoutResult,
  type PayPalRail,
  type RefundInput,
  type RefundResult,
} from "./rail.ts";

interface SimOrder {
  id: string;
  amountCents: number;
  status: "PAYER_ACTION_REQUIRED" | "APPROVED" | "COMPLETED";
  returnUrl: string;
  description: string;
  authorizationId?: string;
}

interface SimAuthorization {
  id: string;
  orderId: string;
  amountCents: number;
  capturedCents: number;
  status: "CREATED" | "PARTIALLY_CAPTURED" | "CAPTURED" | "VOIDED";
  expiresAt: number;
}

const id = (prefix: string) => `${prefix}-SIM-${randomBytes(6).toString("hex").toUpperCase()}`;

/**
 * In-memory stand-in for PayPal with the rules that matter to us: approval
 * before authorization, captures bounded by the authorized amount, nothing
 * after a final capture or void, and idempotent retries by request id.
 * Never presented as real money movement.
 */
export class SimulatedRail implements PayPalRail {
  readonly mode = "simulated" as const;
  readonly orders = new Map<string, SimOrder>();
  readonly authorizations = new Map<string, SimAuthorization>();
  readonly payouts: PayoutInput[] = [];
  readonly captures: (OrderCapture & { authorizationId: string; refundedCents: number })[] = [];
  /** Tests: make the next capture report this status instead of COMPLETED. */
  nextCaptureStatus?: string;
  /** Tests: make the next authorization report this status instead of CREATED. */
  nextAuthorizationStatus?: string;
  /** Tests: apply the next capture, then answer with this error (PayPal took the money but we never heard). */
  ghostNextCapture?: PayPalError;
  private readonly replies = new Map<string, unknown>();
  /** Inject failures in tests: return an error to throw for the next call of that kind. */
  failNext: Partial<Record<"capture" | "authorize" | "void" | "payout", PayPalError>> = {};

  constructor(
    private readonly approveBaseUrl: string,
    private readonly now: () => number = Date.now,
  ) {}

  private once<T>(requestId: string, run: () => T): T {
    if (this.replies.has(requestId)) return this.replies.get(requestId) as T;
    const out = run();
    this.replies.set(requestId, out);
    return out;
  }

  private takeFailure(kind: keyof SimulatedRail["failNext"]): void {
    const err = this.failNext[kind];
    if (err) {
      delete this.failNext[kind];
      throw err;
    }
  }

  async createAuthorizeOrder(input: CreateAuthorizeOrderInput): Promise<CreatedOrder> {
    return this.once(input.requestId, () => {
      const order: SimOrder = { id: id("ORDER"), amountCents: input.amountCents, status: "PAYER_ACTION_REQUIRED", returnUrl: input.returnUrl, description: input.description };
      this.orders.set(order.id, order);
      return { orderId: order.id, approveUrl: `${this.approveBaseUrl}?token=${order.id}` };
    });
  }

  /** What the buyer's click on the approval page does. */
  approve(orderId: string): string {
    const order = this.orders.get(orderId);
    if (!order) throw new PayPalError("order not found", 404, "RESOURCE_NOT_FOUND");
    if (order.status === "PAYER_ACTION_REQUIRED") order.status = "APPROVED";
    const url = new URL(order.returnUrl);
    url.searchParams.set("token", orderId);
    return url.toString();
  }

  async authorizeOrder(orderId: string, requestId: string): Promise<AuthorizedOrder> {
    this.takeFailure("authorize");
    return this.once(requestId, () => {
      const order = this.orders.get(orderId);
      if (!order) throw new PayPalError("order not found", 404, "RESOURCE_NOT_FOUND");
      if (order.status !== "APPROVED") throw new PayPalError("payer has not approved the order", 422, "ORDER_NOT_APPROVED");
      const auth: SimAuthorization = { id: id("AUTH"), orderId, amountCents: order.amountCents, capturedCents: 0, status: "CREATED", expiresAt: this.now() + 29 * DAY_MS };
      this.authorizations.set(auth.id, auth);
      order.status = "COMPLETED";
      order.authorizationId = auth.id;
      const status = this.nextAuthorizationStatus ?? auth.status;
      delete this.nextAuthorizationStatus;
      return { orderId, authorizationId: auth.id, expiresAt: auth.expiresAt, status };
    });
  }

  async captureAuthorization(input: CaptureInput): Promise<CaptureResult> {
    this.takeFailure("capture");
    const result = this.once(input.requestId, () => {
      const auth = this.authorizations.get(input.authorizationId);
      if (!auth) throw new PayPalError("authorization not found", 404, "RESOURCE_NOT_FOUND");
      if (auth.status === "VOIDED" || auth.status === "CAPTURED") throw new PayPalError(`authorization is ${auth.status}`, 422, "AUTHORIZATION_ALREADY_COMPLETED");
      if (this.now() > auth.expiresAt) throw new PayPalError("authorization expired", 422, "AUTHORIZATION_EXPIRED");
      if (!(input.amountCents > 0)) throw new PayPalError("amount must be positive", 422, "INVALID_PARAMETER_VALUE");
      if (auth.capturedCents + input.amountCents > auth.amountCents) throw new PayPalError("capture exceeds authorized amount", 422, "MAX_CAPTURE_AMOUNT_EXCEEDED");
      const status = this.nextCaptureStatus ?? "COMPLETED";
      delete this.nextCaptureStatus;
      const captureId = id("CAPTURE");
      if (status === "COMPLETED" || status === "PENDING") {
        auth.capturedCents += input.amountCents;
        auth.status = input.final ? "CAPTURED" : "PARTIALLY_CAPTURED";
      }
      this.captures.push({ captureId, status, amountCents: input.amountCents, authorizationId: auth.id, refundedCents: 0, ...(input.invoiceId ? { invoiceId: input.invoiceId } : {}) });
      return { captureId, status };
    });
    // Like PayPal: the capture happened and is cached under the request id; only the answer got lost.
    const ghost = this.ghostNextCapture;
    if (ghost) {
      delete this.ghostNextCapture;
      throw ghost;
    }
    return result;
  }

  async voidAuthorization(authorizationId: string, requestId: string): Promise<void> {
    this.takeFailure("void");
    this.once(requestId, () => {
      const auth = this.authorizations.get(authorizationId);
      if (!auth) throw new PayPalError("authorization not found", 404, "RESOURCE_NOT_FOUND");
      if (auth.status === "CAPTURED") throw new PayPalError("authorization already captured", 422, "AUTHORIZATION_ALREADY_COMPLETED");
      auth.status = "VOIDED";
    });
  }

  async getOrderCaptures(orderId: string): Promise<OrderCapture[]> {
    const authIds = new Set([...this.authorizations.values()].filter((a) => a.orderId === orderId).map((a) => a.id));
    return this.captures.filter((c) => authIds.has(c.authorizationId)).map(({ captureId, status, amountCents, invoiceId }) => ({ captureId, status, amountCents, ...(invoiceId ? { invoiceId } : {}) }));
  }

  async refundCapture(input: RefundInput): Promise<RefundResult> {
    return this.once(input.requestId, () => {
      const cap = this.captures.find((c) => c.captureId === input.captureId);
      if (!cap) throw new PayPalError("capture not found", 404, "RESOURCE_NOT_FOUND");
      if (cap.refundedCents + input.amountCents > cap.amountCents) throw new PayPalError("refund exceeds capture", 422, "REFUND_AMOUNT_EXCEEDED");
      cap.refundedCents += input.amountCents;
      return { refundId: id("REFUND"), status: "COMPLETED" };
    });
  }

  async createPayouts(input: PayoutInput): Promise<PayoutResult> {
    this.takeFailure("payout");
    return this.once(input.batchId, () => {
      this.payouts.push(input);
      return { payoutBatchId: id("PAYOUT"), status: "SUCCESS" };
    });
  }
}
