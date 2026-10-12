import { describe, expect, it } from "vitest";
import { SandboxRail } from "../src/index.ts";

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Record<string, unknown>, calls: Call[]): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const key = Object.keys(responses).find((k) => u.endsWith(k));
    if (!key) return new Response(JSON.stringify({ name: "RESOURCE_NOT_FOUND", message: "nope", debug_id: "dbg" }), { status: 404 });
    const body = responses[key];
    if (body === null) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

const token = { "/v1/oauth2/token": { access_token: "TOKEN", expires_in: 3600 } };

describe("SandboxRail", () => {
  it("refuses non-sandbox hosts", () => {
    expect(() => new SandboxRail({ clientId: "a", clientSecret: "b", baseUrl: "https://api-m.paypal.com" })).toThrow(/sandbox/);
  });

  it("creates an AUTHORIZE order with an idempotency key and returns the payer-action link", async () => {
    const calls: Call[] = [];
    const rail = new SandboxRail({
      clientId: "id",
      clientSecret: "secret",
      fetch: fakeFetch({ ...token, "/v2/checkout/orders": { id: "O1", links: [{ rel: "payer-action", href: "https://sandbox.paypal.com/approve?token=O1" }] } }, calls),
    });
    const order = await rail.createAuthorizeOrder({ tabId: "tab1", amountCents: 500, description: "Agent budget", returnUrl: "http://r", cancelUrl: "http://c", requestId: "req-1" });
    expect(order).toEqual({ orderId: "O1", approveUrl: "https://sandbox.paypal.com/approve?token=O1" });
    const create = calls[1]!;
    const headers = create.init.headers as Record<string, string>;
    expect(headers["PayPal-Request-Id"]).toBe("req-1");
    expect(headers.Authorization).toBe("Bearer TOKEN");
    const body = JSON.parse(String(create.init.body));
    expect(body.intent).toBe("AUTHORIZE");
    expect(body.purchase_units[0].amount).toEqual({ currency_code: "USD", value: "5.00" });
  });

  it("sends partial captures with final_capture=false", async () => {
    const calls: Call[] = [];
    const rail = new SandboxRail({
      clientId: "id",
      clientSecret: "secret",
      fetch: fakeFetch({ ...token, "/v2/payments/authorizations/A1/capture": { id: "C1", status: "COMPLETED" } }, calls),
    });
    const cap = await rail.captureAuthorization({ authorizationId: "A1", amountCents: 37, final: false, requestId: "tab1-capture-1" });
    expect(cap).toEqual({ captureId: "C1", status: "COMPLETED" });
    const body = JSON.parse(String(calls[1]!.init.body));
    expect(body).toEqual({ amount: { currency_code: "USD", value: "0.37" }, final_capture: false });
  });

  it("surfaces PayPal error names", async () => {
    const rail = new SandboxRail({ clientId: "id", clientSecret: "secret", fetch: fakeFetch(token, []) });
    await expect(rail.voidAuthorization("NOPE", "v1")).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND", httpStatus: 404, debugId: "dbg" });
  });
});
