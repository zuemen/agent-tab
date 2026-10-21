import { centsToValue, valueToCents } from "@agent-tab/core";
import {
  PayPalError,
  type AuthorizedOrder,
  type CaptureInput,
  type CaptureResult,
  type CreateAuthorizeOrderInput,
  type CreatedOrder,
  type OrderCapture,
  type OrderRefund,
  type PayoutInput,
  type PayoutResult,
  type PayPalRail,
  type RefundInput,
  type RefundResult,
} from "./rail.ts";

export const SANDBOX_API_BASE = "https://api-m.sandbox.paypal.com";

export interface SandboxRailOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  brandName?: string;
}

interface PayPalLink {
  href: string;
  rel: string;
}

/**
 * PayPal REST (Orders v2, Payments v2, Payouts v1) against the sandbox.
 * Every money-moving call carries PayPal-Request-Id so a retry with the same
 * id is answered from PayPal's idempotency cache instead of moving money twice.
 */
export class SandboxRail implements PayPalRail {
  readonly mode = "sandbox" as const;
  private token?: { value: string; expiresAt: number };
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: SandboxRailOptions) {
    if (!opts.clientId || !opts.clientSecret) throw new Error("PayPal sandbox client id and secret are required");
    this.baseUrl = opts.baseUrl ?? SANDBOX_API_BASE;
    if (!/sandbox/.test(this.baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(this.baseUrl)) {
      throw new Error("SandboxRail refuses to talk to a non-sandbox PayPal host");
    }
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** OAuth access token for this app (shared with the PayPal Agent Toolkit). */
  getAccessToken(): Promise<string> {
    return this.accessToken();
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString("base64");
    const res = await this.send("/v1/oauth2/token", {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (err) {
      throw new PayPalError(`network error calling PayPal ${path}: ${(err as Error).message}`, 0, "NETWORK_ERROR");
    }
    if (!res.ok) {
      let body: { name?: string; message?: string; debug_id?: string; details?: unknown; error?: string; error_description?: string } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        /* non-JSON error body */
      }
      const issue = Array.isArray(body.details) ? (body.details[0] as { issue?: string } | undefined)?.issue : undefined;
      throw new PayPalError(
        `PayPal ${path} failed: ${res.status} ${issue ?? body.name ?? body.error ?? ""} ${body.message ?? body.error_description ?? ""}`.trim(),
        res.status,
        issue ?? body.name ?? body.error ?? "PAYPAL_ERROR",
        body.debug_id,
        body.details,
      );
    }
    return res;
  }

  private async api<T>(method: string, path: string, requestId?: string, payload?: unknown): Promise<T | undefined> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    const res = await this.send(path, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
    if (res.status === 204) return undefined;
    return (await res.json()) as T;
  }

  async createAuthorizeOrder(input: CreateAuthorizeOrderInput): Promise<CreatedOrder> {
    const order = await this.api<{ id: string; links: PayPalLink[] }>("POST", "/v2/checkout/orders", input.requestId, {
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: input.tabId,
          custom_id: input.tabId,
          description: input.description.slice(0, 127),
          amount: { currency_code: "USD", value: centsToValue(input.amountCents) },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: this.opts.brandName ?? "AgentTab",
            shipping_preference: "NO_SHIPPING",
            user_action: "CONTINUE",
            return_url: input.returnUrl,
            cancel_url: input.cancelUrl,
          },
        },
      },
    });
    if (!order) throw new PayPalError("empty create-order response", 500);
    const approve = order.links.find((l) => l.rel === "payer-action" || l.rel === "approve");
    if (!approve) throw new PayPalError("PayPal returned no approval link", 500, "NO_APPROVAL_LINK");
    return { orderId: order.id, approveUrl: approve.href };
  }

  async authorizeOrder(orderId: string, requestId: string): Promise<AuthorizedOrder> {
    const order = await this.api<{
      id: string;
      purchase_units: { payments?: { authorizations?: { id: string; status: string; expiration_time?: string }[] } }[];
    }>("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, requestId, {});
    const auth = order?.purchase_units[0]?.payments?.authorizations?.[0];
    if (!auth) throw new PayPalError("authorize response had no authorization", 500, "NO_AUTHORIZATION");
    const expiresAt = auth.expiration_time ? Date.parse(auth.expiration_time) : Date.now() + 29 * 24 * 3600 * 1000;
    return { orderId, authorizationId: auth.id, expiresAt, status: auth.status };
  }

  async captureAuthorization(input: CaptureInput): Promise<CaptureResult> {
    const cap = await this.api<{ id: string; status: string }>(
      "POST",
      `/v2/payments/authorizations/${encodeURIComponent(input.authorizationId)}/capture`,
      input.requestId,
      {
        amount: { currency_code: "USD", value: centsToValue(input.amountCents) },
        final_capture: input.final,
        ...(input.invoiceId ? { invoice_id: input.invoiceId } : {}),
        ...(input.noteToPayer ? { note_to_payer: input.noteToPayer.slice(0, 255) } : {}),
      },
    );
    if (!cap) throw new PayPalError("empty capture response", 500);
    return { captureId: cap.id, status: cap.status };
  }

  async voidAuthorization(authorizationId: string, requestId: string): Promise<void> {
    await this.api("POST", `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`, requestId);
  }

  private async orderPayments(orderId: string) {
    type Payment = { id: string; status: string; amount: { value: string }; invoice_id?: string };
    const order = await this.api<{ purchase_units?: { payments?: { captures?: Payment[]; refunds?: Payment[] } }[] }>(
      "GET",
      `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
    );
    const units = order?.purchase_units ?? [];
    const norm = (p: Payment) => ({ id: p.id, status: p.status, amountCents: valueToCents(p.amount.value), ...(p.invoice_id ? { invoiceId: p.invoice_id } : {}) });
    return { captures: units.flatMap((u) => u.payments?.captures ?? []).map(norm), refunds: units.flatMap((u) => u.payments?.refunds ?? []).map(norm) };
  }

  async getOrderCaptures(orderId: string): Promise<OrderCapture[]> {
    return (await this.orderPayments(orderId)).captures.map(({ id, ...c }) => ({ captureId: id, ...c }));
  }

  async getOrderRefunds(orderId: string): Promise<OrderRefund[]> {
    return (await this.orderPayments(orderId)).refunds.map(({ id, ...r }) => ({ refundId: id, ...r }));
  }

  async refundCapture(input: RefundInput): Promise<RefundResult> {
    const res = await this.api<{ id: string; status: string }>("POST", `/v2/payments/captures/${encodeURIComponent(input.captureId)}/refund`, input.requestId, {
      amount: { currency_code: "USD", value: centsToValue(input.amountCents) },
      ...(input.invoiceId ? { invoice_id: input.invoiceId } : {}),
      ...(input.noteToPayer ? { note_to_payer: input.noteToPayer.slice(0, 255) } : {}),
    });
    if (!res) throw new PayPalError("empty refund response", 500);
    return { refundId: res.id, status: res.status };
  }

  async createPayouts(input: PayoutInput): Promise<PayoutResult> {
    const res = await this.api<{ batch_header: { payout_batch_id: string; batch_status: string } }>("POST", "/v1/payments/payouts", input.batchId, {
      sender_batch_header: { sender_batch_id: input.batchId, email_subject: input.emailSubject },
      items: input.items.map((i) => ({
        recipient_type: "EMAIL",
        receiver: i.receiver,
        amount: { value: centsToValue(i.amountCents), currency: "USD" },
        note: i.note,
        sender_item_id: i.itemId,
      })),
    });
    if (!res) throw new PayPalError("empty payouts response", 500);
    return { payoutBatchId: res.batch_header.payout_batch_id, status: res.batch_header.batch_status };
  }
}
