import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { SimulatedRail } from "@agent-tab/paypal";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { TabEvent, TabService, TabTerms } from "./service.ts";

export interface AppOptions {
  /** Static web UI (HTML string) served for / and /tab/:id. */
  webHtml?: () => string;
}

function bearer(header: string | undefined): string | undefined {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return m?.[1];
}

export function createApp(service: TabService, opts: AppOptions = {}): Hono {
  const app = new Hono();

  app.onError((err, c) => c.json({ error: err.message }, 400));

  // ---- x402 facilitator API (spec §7) ----
  app.get("/supported", (c) => c.json(service.supported()));

  app.post("/verify", async (c) => {
    const body = (await c.req.json()) as { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements };
    return c.json(service.verify(body.paymentPayload, body.paymentRequirements));
  });

  app.post("/settle", async (c) => {
    const body = (await c.req.json()) as { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements };
    const seller = service.sellerForKey(bearer(c.req.header("authorization")));
    return c.json(service.settle(body.paymentPayload, body.paymentRequirements, seller));
  });

  // ---- tab API ----
  app.get("/api/config", (c) =>
    c.json({ rail: service.rail.mode, network: service.config.network, sellers: service.publicSellers(), platformFeeBps: service.config.platformFeeBps }),
  );

  app.post("/api/tab-requests", async (c) => {
    const body = (await c.req.json()) as { agentPublicKey: string; purpose: string; agentName?: string; suggested?: Partial<TabTerms> };
    return c.json(service.requestTab(body), 201);
  });

  app.get("/api/tabs/:id", (c) => {
    const id = c.req.param("id");
    if (!service.has(id)) return c.json({ error: "unknown tab" }, 404);
    return c.json(service.view(id));
  });

  app.post("/api/tabs/:id/terms", async (c) => {
    const terms = (await c.req.json()) as TabTerms;
    return c.json(await service.approveTerms(c.req.param("id"), terms));
  });

  app.post("/api/tabs/:id/close", async (c) => c.json(await service.close(c.req.param("id"), "closed_by_user")));
  app.post("/api/tabs/:id/revoke", async (c) => c.json(await service.close(c.req.param("id"), "revoked")));

  app.get("/api/tabs/:id/events", (c) => {
    const id = c.req.param("id");
    return streamSSE(c, async (stream) => {
      const queue: TabEvent[] = [];
      let wake: (() => void) | undefined;
      const onEvent = (ev: TabEvent) => {
        if (ev.tabId !== id) return;
        queue.push(ev);
        wake?.();
      };
      service.events.on("event", onEvent);
      stream.onAbort(() => {
        service.events.off("event", onEvent);
        wake?.();
      });
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ tabId: id }) });
      while (!stream.aborted) {
        if (!queue.length) {
          await new Promise<void>((r) => {
            wake = r;
            setTimeout(r, 15_000); // keep-alive tick
          });
          wake = undefined;
        }
        const ev = queue.shift();
        if (ev) await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
        else if (!stream.aborted) await stream.writeSSE({ event: "ping", data: "{}" });
      }
      service.events.off("event", onEvent);
    });
  });

  // ---- PayPal redirects ----
  app.get("/paypal/return", async (c) => {
    const orderId = c.req.query("token");
    if (!orderId) return c.text("missing token", 400);
    try {
      const tabId = await service.onApproved(orderId);
      return c.redirect(`/tab/${tabId}?approved=1`);
    } catch (err) {
      const tabId = service.findByOrder(orderId)?.request.tabId;
      return c.redirect(tabId ? `/tab/${tabId}?error=${encodeURIComponent((err as Error).message)}` : "/");
    }
  });

  app.get("/paypal/cancel", async (c) => {
    const tabId = await service.onCancelled(c.req.query("token") ?? "");
    return c.redirect(tabId ? `/tab/${tabId}?cancelled=1` : "/");
  });

  // ---- simulated approval page (only exists with the simulated rail) ----
  if (service.rail instanceof SimulatedRail) {
    const rail = service.rail;
    app.get("/simulated/approve", (c) => {
      const token = c.req.query("token") ?? "";
      const order = rail.orders.get(token);
      if (!order) return c.text("unknown order", 404);
      return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Simulated approval</title>
<body style="font-family:system-ui;max-width:420px;margin:48px auto;padding:0 16px">
<p style="background:#fff3cd;padding:8px 12px;border-radius:6px"><b>SIMULATED</b> — no PayPal account is involved. Configure sandbox credentials for the real flow.</p>
<h1 style="font-size:20px">Authorize $${(order.amountCents / 100).toFixed(2)}</h1>
<form method="post"><input type="hidden" name="token" value="${token.replace(/[^A-Za-z0-9-]/g, "")}">
<button style="padding:10px 16px">Approve (simulated)</button></form>
<p><a href="/paypal/cancel?token=${encodeURIComponent(token)}">Cancel</a></p></body>`);
    });
    app.post("/simulated/approve", async (c) => {
      const form = await c.req.parseBody();
      return c.redirect(rail.approve(String(form.token ?? "")));
    });
  }

  // ---- web UI ----
  if (opts.webHtml) {
    const html = opts.webHtml;
    app.get("/", (c) => c.html(html()));
    app.get("/tab/:id", (c) => c.html(html()));
  }

  return app;
}
