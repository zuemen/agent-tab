// The only surface the facilitator uses to move money. Two implementations:
// SandboxRail (real PayPal REST against api-m.sandbox.paypal.com) and
// SimulatedRail (in-memory, for tests and keyless local runs; the UI labels it).

export type RailMode = "sandbox" | "simulated";

export interface CreateAuthorizeOrderInput {
  tabId: string;
  amountCents: number;
  description: string;
  returnUrl: string;
  cancelUrl: string;
  /** Idempotency key for order creation. */
  requestId: string;
}

export interface CreatedOrder {
  orderId: string;
  /** Where the human approves the authorization. */
  approveUrl: string;
}

export interface AuthorizedOrder {
  orderId: string;
  authorizationId: string;
  /** Epoch ms when PayPal says the authorization expires. */
  expiresAt: number;
  status: string;
}

export interface CaptureInput {
  authorizationId: string;
  amountCents: number;
  final: boolean;
  requestId: string;
  invoiceId?: string;
  noteToPayer?: string;
}

export interface CaptureResult {
  captureId: string;
  /** PayPal capture status, e.g. COMPLETED or PENDING. */
  status: string;
}

export interface PayoutItem {
  receiver: string;
  amountCents: number;
  note: string;
  itemId: string;
}

export interface PayoutInput {
  batchId: string;
  items: PayoutItem[];
  emailSubject: string;
}

export interface PayoutResult {
  payoutBatchId: string;
  status: string;
}

/** A capture as PayPal reports it on the order (for reconciliation). */
export interface OrderCapture {
  captureId: string;
  status: string;
  amountCents: number;
  invoiceId?: string;
}

export interface RefundInput {
  captureId: string;
  amountCents: number;
  requestId: string;
  /** Lets a later lookup find this refund on the order without relying on PayPal-Request-Id caching. */
  invoiceId?: string;
  noteToPayer?: string;
}

/** A refund as PayPal reports it on the order (for reconciliation). */
export interface OrderRefund {
  refundId: string;
  status: string;
  amountCents: number;
  invoiceId?: string;
}

export interface RefundResult {
  refundId: string;
  status: string;
}

export interface PayPalRail {
  readonly mode: RailMode;
  createAuthorizeOrder(input: CreateAuthorizeOrderInput): Promise<CreatedOrder>;
  authorizeOrder(orderId: string, requestId: string): Promise<AuthorizedOrder>;
  captureAuthorization(input: CaptureInput): Promise<CaptureResult>;
  voidAuthorization(authorizationId: string, requestId: string): Promise<void>;
  createPayouts(input: PayoutInput): Promise<PayoutResult>;
  /** What PayPal actually captured on this order; the source of truth after an unclear failure. */
  getOrderCaptures(orderId: string): Promise<OrderCapture[]>;
  refundCapture(input: RefundInput): Promise<RefundResult>;
  /** Refunds PayPal has recorded on this order. */
  getOrderRefunds(orderId: string): Promise<OrderRefund[]>;
}

/** A PayPal API failure, carrying PayPal's error name and debug id when present. */
export class PayPalError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    /** PayPal error name, e.g. AUTHORIZATION_EXPIRED. */
    readonly code: string = "PAYPAL_ERROR",
    readonly debugId?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "PayPalError";
  }
  /** Network blips and 5xx are worth retrying with the same PayPal-Request-Id. */
  get retryable(): boolean {
    return this.httpStatus === 0 || this.httpStatus === 429 || this.httpStatus >= 500;
  }
}
