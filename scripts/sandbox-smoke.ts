/**
 * PayPal sandbox smoke test for the money path AgentTab depends on:
 *   create AUTHORIZE order -> buyer approves -> authorize
 *   -> partial capture (final_capture=false) -> retry with same PayPal-Request-Id
 *   -> second partial capture -> order lookup (captures by invoice id)
 *   -> [final path] refund + idempotent retry + order lookup (refunds by invoice id)
 *   -> final capture | void remainder
 *   -> (optional) payout
 *
 * Usage:  npx tsx scripts/sandbox-smoke.ts [final|void|both]
 * Needs PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (sandbox app) in .env.
 * Optional PAYOUT_RECEIVER = a sandbox personal account email.
 * Writes a JSON record (ids, statuses, debug ids; no secrets) to .data/.
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { PayPalError, SandboxRail } from "@agent-tab/paypal";

if (existsSync(".env")) process.loadEnvFile(".env");
const clientId = process.env.PAYPAL_CLIENT_ID;
const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox REST app) in .env first.");
  process.exit(2);
}
const rail = new SandboxRail({ clientId, clientSecret, brandName: "AgentTab smoke test" });
const run = `smoke-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
const record: { run: string; steps: Record<string, unknown>[] } = { run, steps: [] };
const PORT = 4021;

function log(step: string, data: Record<string, unknown>) {
  const entry = { step, at: new Date().toISOString(), ...data };
  record.steps.push(entry);
  console.log(`- ${step}:`, JSON.stringify(data));
}

async function attempt(step: string, fn: () => Promise<Record<string, unknown> | void>, expectError = false) {
  try {
    const out = (await fn()) ?? {};
    log(step, { ok: true, ...out });
    if (expectError) log(`${step}:UNEXPECTED_SUCCESS`, {});
    return out;
  } catch (err) {
    const e = err as PayPalError;
    log(step, { ok: false, code: e.code, httpStatus: e.httpStatus, debugId: e.debugId, message: e.message });
    if (!expectError) throw err;
    return undefined;
  }
}

/** Wait for PayPal to redirect the buyer back to our local return URL. */
function waitForApproval(): Promise<string> {
  return new Promise((resolve, reject) => {
    const srv = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
      const token = url.searchParams.get("token");
      res.writeHead(200, { "content-type": "text/plain" });
      if (url.pathname === "/return" && token) {
        res.end("Approved. You can close this window and return to the terminal.");
        srv.close();
        resolve(token);
      } else {
        res.end("Cancelled.");
        srv.close();
        reject(new Error("buyer cancelled"));
      }
    });
    srv.listen(PORT);
    setTimeout(() => {
      srv.close();
      reject(new Error("timed out waiting for approval (10 min)"));
    }, 600_000);
  });
}

async function scenario(path: "final" | "void") {
  console.log(`\n=== ${path} path ===`);
  const order = await attempt(`${path}:create_order`, async () => {
    const o = await rail.createAuthorizeOrder({
      tabId: `${run}-${path}`,
      amountCents: 100,
      description: `AgentTab smoke test (${path})`,
      returnUrl: `http://localhost:${PORT}/return`,
      cancelUrl: `http://localhost:${PORT}/cancel`,
      requestId: `${run}-${path}-order`,
    });
    return { orderId: o.orderId, approveUrl: o.approveUrl };
  });
  console.log(`\nOpen this link, log in with a SANDBOX PERSONAL account, and approve $1.00:\n  ${order!.approveUrl}\n`);
  const token = await waitForApproval();
  const auth = await attempt(`${path}:authorize`, async () => {
    const a = await rail.authorizeOrder(token, `${run}-${path}-authorize`);
    return { authorizationId: a.authorizationId, status: a.status, expiresAt: new Date(a.expiresAt).toISOString() };
  });
  const authorizationId = String(auth!.authorizationId);

  const cap1 = await attempt(`${path}:partial_capture_1 ($0.25, final=false)`, async () => {
    const c = await rail.captureAuthorization({ authorizationId, amountCents: 25, final: false, requestId: `${run}-${path}-cap1`, invoiceId: `${run}-${path}-1` });
    return { captureId: c.captureId, status: c.status };
  }, false).catch(() => undefined);
  if (!cap1) {
    log(`${path}:VERDICT`, { partialCapture: "FAILED — check whether partial capture must be enabled on the sandbox business account" });
    return;
  }
  await attempt(`${path}:retry_capture_1_same_request_id`, async () => {
    const c = await rail.captureAuthorization({ authorizationId, amountCents: 25, final: false, requestId: `${run}-${path}-cap1`, invoiceId: `${run}-${path}-1` });
    return { captureId: c.captureId, sameAsFirst: c.captureId === cap1.captureId, status: c.status };
  }, false).catch(() => undefined);
  await attempt(`${path}:partial_capture_2 ($0.30, final=false)`, async () => {
    const c = await rail.captureAuthorization({ authorizationId, amountCents: 30, final: false, requestId: `${run}-${path}-cap2`, invoiceId: `${run}-${path}-2` });
    return { captureId: c.captureId, status: c.status };
  }, false).catch(() => undefined);

  // Reconciliation reads captures and refunds back from the order and matches them by invoice id.
  await attempt(`${path}:order_lists_captures_with_invoice_ids`, async () => {
    const caps = await rail.getOrderCaptures(token);
    return { captures: caps.map((c) => ({ captureId: c.captureId, status: c.status, invoiceId: c.invoiceId ?? null })), cap1Found: caps.some((c) => c.invoiceId === `${run}-${path}-1`) };
  }).catch(() => undefined);
  if (path === "final") {
    await attempt("final:refund_5c_of_capture_1", async () => {
      const r = await rail.refundCapture({ captureId: String(cap1.captureId), amountCents: 5, requestId: `${run}-refund-1`, invoiceId: `${run}-refund-1` });
      return { refundId: r.refundId, status: r.status };
    }).catch(() => undefined);
    await attempt("final:retry_refund_same_request_id", async () => {
      const r = await rail.refundCapture({ captureId: String(cap1.captureId), amountCents: 5, requestId: `${run}-refund-1`, invoiceId: `${run}-refund-1` });
      return { refundId: r.refundId, status: r.status };
    }).catch(() => undefined);
    await attempt("final:order_lists_refunds_with_invoice_ids", async () => {
      const refunds = await rail.getOrderRefunds(token);
      return { refunds: refunds.map((r) => ({ refundId: r.refundId, status: r.status, invoiceId: r.invoiceId ?? null })), refundFound: refunds.some((r) => r.invoiceId === `${run}-refund-1`), count: refunds.length };
    }).catch(() => undefined);
  }

  if (path === "final") {
    await attempt(`final:final_capture ($0.10, final=true)`, async () => {
      const c = await rail.captureAuthorization({ authorizationId, amountCents: 10, final: true, requestId: `${run}-final-cap3`, invoiceId: `${run}-final-3` });
      return { captureId: c.captureId, status: c.status };
    }).catch(() => undefined);
    await attempt("final:capture_after_final_should_fail", async () => {
      const c = await rail.captureAuthorization({ authorizationId, amountCents: 1, final: false, requestId: `${run}-final-cap4`, invoiceId: `${run}-final-4` });
      return { captureId: c.captureId };
    }, true);
  } else {
    await attempt("void:void_remainder", async () => {
      await rail.voidAuthorization(authorizationId, `${run}-void-void`);
    }).catch(() => undefined);
    await attempt("void:capture_after_void_should_fail", async () => {
      const c = await rail.captureAuthorization({ authorizationId, amountCents: 1, final: false, requestId: `${run}-void-cap4`, invoiceId: `${run}-void-4` });
      return { captureId: c.captureId };
    }, true);
  }
}

async function main() {
  const which = (process.argv[2] ?? "both") as "final" | "void" | "both";
  if (which === "final" || which === "both") await scenario("final");
  if (which === "void" || which === "both") await scenario("void");
  const receiver = process.env.PAYOUT_RECEIVER;
  if (receiver) {
    await attempt("payout ($0.05)", async () => {
      const p = await rail.createPayouts({ batchId: `${run}-payout`, emailSubject: "AgentTab smoke test payout", items: [{ receiver, amountCents: 5, note: "smoke test", itemId: `${run}-item` }] });
      return { payoutBatchId: p.payoutBatchId, status: p.status };
    }).catch(() => undefined);
  } else {
    log("payout", { skipped: "set PAYOUT_RECEIVER to a sandbox personal email to test payouts" });
  }
}

main()
  .catch((err) => log("aborted", { message: (err as Error).message }))
  .finally(() => {
    mkdirSync(".data", { recursive: true });
    const file = `.data/${run}.json`;
    writeFileSync(file, JSON.stringify(record, null, 2));
    console.log(`\nRecord written to ${file}`);
  });
