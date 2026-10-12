import { randomBytes } from "node:crypto";
import { DAY_MS } from "@agent-tab/core";
import {
  PayPalError,
  type AuthorizedOrder,
  type CaptureInput,
  type CaptureResult,
  type CreateAuthorizeOrderInput,
  type CreatedOrder,
  type PayoutInput,
  type PayoutResult,
  type PayPalRail,
} from "./rail.ts";

interface SimOrder {
  id: string;
  amountCents: number;
  status: "PAYER_ACTION_REQUIRED" | "APPROVED" | "COMPLETED";
  returnUrl: string;
  authorizationId?: string;
}

interface SimAuthorization {
  id: string;
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
      const order: SimOrder = { id: id("ORDER"), amountCents: input.amountCents, status: "PAYER_ACTION_REQUIRED", returnUrl: input.returnUrl };
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
      const auth: SimAuthorization = { id: id("AUTH"), amountCents: order.amountCents, capturedCents: 0, status: "CREATED", expiresAt: this.now() + 29 * DAY_MS };
      this.authorizations.set(auth.id, auth);
      order.status = "COMPLETED";
      order.authorizationId = auth.id;
      return { orderId, authorizationId: auth.id, expiresAt: auth.expiresAt, status: auth.status };
    });
  }

  async captureAuthorization(input: CaptureInput): Promise<CaptureResult> {
    this.takeFailure("capture");
    return this.once(input.requestId, () => {
      const auth = this.authorizations.get(input.authorizationId);
      if (!auth) throw new PayPalError("authorization not found", 404, "RESOURCE_NOT_FOUND");
      if (auth.status === "VOIDED" || auth.status === "CAPTURED") throw new PayPalError(`authorization is ${auth.status}`, 422, "AUTHORIZATION_ALREADY_COMPLETED");
      if (this.now() > auth.expiresAt) throw new PayPalError("authorization expired", 422, "AUTHORIZATION_EXPIRED");
      if (!(input.amountCents > 0)) throw new PayPalError("amount must be positive", 422, "INVALID_PARAMETER_VALUE");
      if (auth.capturedCents + input.amountCents > auth.amountCents) throw new PayPalError("capture exceeds authorized amount", 422, "MAX_CAPTURE_AMOUNT_EXCEEDED");
      auth.capturedCents += input.amountCents;
      auth.status = input.final ? "CAPTURED" : "PARTIALLY_CAPTURED";
      return { captureId: id("CAPTURE"), status: "COMPLETED" };
    });
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

  async createPayouts(input: PayoutInput): Promise<PayoutResult> {
    this.takeFailure("payout");
    return this.once(input.batchId, () => {
      this.payouts.push(input);
      return { payoutBatchId: id("PAYOUT"), status: "SUCCESS" };
    });
  }
}
