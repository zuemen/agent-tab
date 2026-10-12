import { describe, expect, it } from "vitest";
import { PayPalError, SimulatedRail } from "../src/index.ts";

async function authorized(rail: SimulatedRail, cents = 1000) {
  const order = await rail.createAuthorizeOrder({ tabId: "t", amountCents: cents, description: "d", returnUrl: "http://x/return", cancelUrl: "http://x/cancel", requestId: "r1" });
  rail.approve(order.orderId);
  return rail.authorizeOrder(order.orderId, "r2");
}

describe("SimulatedRail", () => {
  it("requires approval before authorization", async () => {
    const rail = new SimulatedRail("http://x/approve");
    const order = await rail.createAuthorizeOrder({ tabId: "t", amountCents: 100, description: "d", returnUrl: "http://x/r", cancelUrl: "http://x/c", requestId: "a" });
    await expect(rail.authorizeOrder(order.orderId, "b")).rejects.toMatchObject({ code: "ORDER_NOT_APPROVED" });
    expect(rail.approve(order.orderId)).toContain(`token=${order.orderId}`);
  });

  it("allows partial captures up to the authorized amount, then a final one", async () => {
    const rail = new SimulatedRail("http://x/approve");
    const auth = await authorized(rail);
    await rail.captureAuthorization({ authorizationId: auth.authorizationId, amountCents: 400, final: false, requestId: "c1" });
    await rail.captureAuthorization({ authorizationId: auth.authorizationId, amountCents: 400, final: false, requestId: "c2" });
    await expect(rail.captureAuthorization({ authorizationId: auth.authorizationId, amountCents: 300, final: true, requestId: "c3" })).rejects.toMatchObject({ code: "MAX_CAPTURE_AMOUNT_EXCEEDED" });
    await rail.captureAuthorization({ authorizationId: auth.authorizationId, amountCents: 200, final: true, requestId: "c4" });
    await expect(rail.captureAuthorization({ authorizationId: auth.authorizationId, amountCents: 1, final: false, requestId: "c5" })).rejects.toBeInstanceOf(PayPalError);
  });

  it("replays the same answer for a repeated request id", async () => {
    const rail = new SimulatedRail("http://x/approve");
    const auth = await authorized(rail);
    const a = await rail.captureAuthorization({ authorizationId: auth.authorizationId, amountCents: 100, final: false, requestId: "same" });
    const b = await rail.captureAuthorization({ authorizationId: auth.authorizationId, amountCents: 100, final: false, requestId: "same" });
    expect(b).toEqual(a);
    expect(rail.authorizations.get(auth.authorizationId)?.capturedCents).toBe(100);
  });

  it("void stops further captures", async () => {
    const rail = new SimulatedRail("http://x/approve");
    const auth = await authorized(rail);
    await rail.voidAuthorization(auth.authorizationId, "v");
    await expect(rail.captureAuthorization({ authorizationId: auth.authorizationId, amountCents: 1, final: false, requestId: "c" })).rejects.toMatchObject({ code: "AUTHORIZATION_ALREADY_COMPLETED" });
  });
});
