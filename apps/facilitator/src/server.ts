import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { PayPalError, SimulatedRail } from "@agent-tab/paypal";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { UserError, type TabEvent, type TabService, type TabTerms } from "./service.ts";

export interface AppOptions {
  /** Static web UI (HTML string) served for / and /tab/:id. */
  webHtml?: () => string;
  /** Max tab requests per client IP per hour (default 30). */
  tabRequestsPerHour?: number;
  /** Reverse proxies in front of this server that append to X-Forwarded-For (default 0: use the socket address). */
  trustProxyHops?: number;
}

export const OWNER_HEADER = "x-agenttab-owner";

function bearer(header: string | undefined): string | undefined {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return m?.[1];
}

/**
 * Client IP for rate limiting. With no trusted proxy, X-Forwarded-For is
 * whatever the client sent, so only the socket address counts. Behind
 * `trustProxyHops` proxies (Render: 1), each appends one entry, so the real
 * client is that many entries from the end; anything earlier is client-supplied.
 */
export function clientIp(c: Context, trustProxyHops = 0): string {
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? "local";
  if (trustProxyHops <= 0) return socket;
  const parts = (c.req.header("x-forwarded-for") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return parts.at(-trustProxyHops) ?? socket;
}

/** Cookie that ties PayPal's redirect back to the browser that went to PayPal. */
const bindingCookie = (tabId: string) => `agenttab_bind_${tabId}`;

/** Fixed-window limiter keyed by an arbitrary string. */
export function rateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { n: number; until: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.until < now) hits.delete(k);
    const h = hits.get(key);
    if (!h || h.until < now) {
      hits.set(key, { n: 1, until: now + windowMs });
      return true;
    }
    h.n++;
    return h.n <= limit;
  };
}

export function createApp(service: TabService, opts: AppOptions = {}): Hono {
  const app = new Hono();
  const tabLimiter = rateLimiter(opts.tabRequestsPerHour ?? 30, 3600_000);
  const sseTickets = new Map<string, { tabId: string; until: number }>();

  app.onError((err, c) => {
    if (err instanceof UserError) return c.json({ error: err.message }, err.status as 400);
    if (err instanceof PayPalError) return c.json({ error: `PayPal error: ${err.code}`, debugId: err.debugId }, 502);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  // Small JSON bodies only; mutating API calls must be JSON (blocks simple cross-site form posts).
  app.use("*", bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ error: "request body too large" }, 413) }));
  app.use("/api/*", async (c, next) => {
    if (c.req.method === "POST" && !(c.req.header("content-type") ?? "").includes("application/json")) {
      return c.json({ error: "content-type must be application/json" }, 415);
    }
    await next();
  });

  const json = async <T>(c: Context): Promise<T> => {
    try {
      return (await c.req.json()) as T;
    } catch {
      throw new UserError("body must be valid JSON");
    }
  };
  const tabOf = (c: Context): string => {
    const id = c.req.param("id") ?? "";
    if (!service.has(id)) throw new UserError("unknown tab", 404);
    return id;
  };
  const isOwner = (c: Context, tabId: string) => service.isOwner(tabId, c.req.header(OWNER_HEADER));
  const requireOwner = (c: Context): string => {
    const id = tabOf(c);
    if (!isOwner(c, id)) throw new UserError("only the tab owner can do this (owner key missing or wrong)", 403);
    return id;
  };

  // ---- x402 facilitator API (spec §7) ----
  app.get("/supported", (c) => c.json(service.supported()));

  app.post("/verify", async (c) => {
    const body = await json<{ paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements }>(c);
    return c.json(service.verify(body.paymentPayload, body.paymentRequirements));
  });

  app.post("/settle", async (c) => {
    const body = await json<{ paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements }>(c);
    const seller = service.sellerForKey(bearer(c.req.header("authorization")));
    return c.json(service.settle(body.paymentPayload, body.paymentRequirements, seller));
  });

  // ---- tab API ----
  app.get("/api/config", (c) =>
    c.json({ rail: service.rail.mode, network: service.config.network, sellers: service.publicSellers(), platformFeeBps: service.config.platformFeeBps }),
  );

  /** An agent asks for a tab. The response's reviewUrl (with the owner key in its fragment) is for the human. */
  app.post("/api/tab-requests", async (c) => {
    if (!tabLimiter(clientIp(c, opts.trustProxyHops))) return c.json({ error: "too many tab requests; try again later" }, 429);
    const body = await json<{ agentPublicKey: string; purpose: string; agentName?: string; suggested?: Partial<TabTerms> }>(c);
    const { tabId, reviewUrl } = service.requestTab(body);
    return c.json({ tabId, reviewUrl }, 201);
  });

  app.get("/api/tabs/:id", (c) => {
    const id = tabOf(c);
    if (!isOwner(c, id)) return c.json({ ...service.publicView(id), owner: false });
    // Whether this browser set the terms: if not, someone else holding the review link did.
    return c.json({ ...service.view(id), owner: true, termsSetHere: service.bindingMatches(id, getCookie(c, bindingCookie(id))) });
  });

  app.post("/api/tabs/:id/terms", async (c) => {
    const id = requireOwner(c);
    const { approveUrl, binding } = await service.approveTerms(id, await json<TabTerms>(c));
    setCookie(c, bindingCookie(id), binding, {
      httpOnly: true,
      sameSite: "Lax", // sent on PayPal's top-level redirect back to us
      path: "/",
      maxAge: 60 * 3600, // as long as a tab can live (MAX_TAB_LIFETIME_MS)
      secure: service.config.publicUrl.startsWith("https:"),
    });
    return c.json({ approveUrl });
  });
  app.post("/api/tabs/:id/close", async (c) => c.json(await service.close(requireOwner(c), "closed_by_user")));
  app.post("/api/tabs/:id/revoke", async (c) => c.json(await service.close(requireOwner(c), "revoked")));

  app.post("/api/tabs/:id/refunds", async (c) => {
    const id = requireOwner(c);
    const body = await json<{ entrySeq: number; reason?: string }>(c);
    return c.json(service.proposeRefund(id, Number(body.entrySeq), body.reason ?? "requested by the tab owner"), 201);
  });
  app.post("/api/tabs/:id/refunds/:rid/confirm", async (c) => {
    const id = requireOwner(c);
    return c.json(await service.confirmRefund(id, c.req.param("rid")));
  });

  // EventSource cannot send headers, so the owner trades the key for a one-time ticket.
  app.post("/api/tabs/:id/events-ticket", (c) => {
    const id = requireOwner(c);
    const now = Date.now();
    for (const [t, v] of sseTickets) if (v.until < now) sseTickets.delete(t);
    const ticket = randomBytes(18).toString("base64url");
    sseTickets.set(ticket, { tabId: id, until: now + 60_000 });
    return c.json({ ticket });
  });

  app.get("/api/tabs/:id/events", (c) => {
    const id = tabOf(c);
    const ticket = sseTickets.get(c.req.query("ticket") ?? "");
    if (!ticket || ticket.tabId !== id || ticket.until < Date.now()) return c.json({ error: "missing or expired ticket" }, 403);
    sseTickets.delete(c.req.query("ticket")!);
    return streamSSE(c, async (stream) => {
      const queue: TabEvent[] = [];
      let wake: (() => void) | undefined;
      const onEvent = (ev: TabEvent) => {
        if (ev.tabId !== id) return;
        if (queue.length < 500) queue.push(ev);
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
          let timer: ReturnType<typeof setTimeout> | undefined;
          await new Promise<void>((r) => {
            wake = r;
            timer = setTimeout(r, 15_000); // keep-alive tick
          });
          clearTimeout(timer);
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
    const tabId = service.findByOrder(orderId)?.request.tabId;
    if (!tabId) return c.redirect("/");
    try {
      const { ownerKey, needsOwnerBrowser } = await service.onApproved(orderId, getCookie(c, bindingCookie(tabId)));
      if (needsOwnerBrowser) return c.redirect(`/tab/${tabId}?finish=elsewhere`);
      deleteCookie(c, bindingCookie(tabId), { path: "/" });
      // The fresh owner key travels in the fragment, which the browser keeps across the redirect and never sends to a server.
      return c.redirect(`/tab/${tabId}?approved=1${ownerKey ? `#owner=${ownerKey}` : ""}`);
    } catch (err) {
      console.error("authorize", tabId, err);
      const msg = err instanceof PayPalError ? `PayPal could not authorize the payment (${err.code}).` : "Could not open the tab.";
      return c.redirect(`/tab/${tabId}?error=${encodeURIComponent(msg)}`);
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
      try {
        return c.redirect(rail.approve(String(form.token ?? "")));
      } catch {
        return c.text("unknown order", 404);
      }
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
