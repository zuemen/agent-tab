import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { SandboxRail, SimulatedRail, type PayPalRail } from "@agent-tab/paypal";
import type { PayPalNetwork } from "@agent-tab/x402-paypal";
import { buildDemo } from "./app.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

const port = Number(process.env.PORT ?? 4020);
// Render sets RENDER_EXTERNAL_URL; PayPal must redirect back to a public URL, not localhost.
const publicUrl = (process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const hasPayPal = !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

let rail: PayPalRail;
let network: PayPalNetwork;
if (hasPayPal) {
  rail = new SandboxRail({ clientId: process.env.PAYPAL_CLIENT_ID!, clientSecret: process.env.PAYPAL_CLIENT_SECRET!, brandName: "AgentTab demo" });
  network = "paypal:sandbox";
} else {
  rail = new SimulatedRail(`${publicUrl}/simulated/approve`);
  network = "paypal:simulated";
}

const htmlPath = fileURLToPath(new URL("../public/index.html", import.meta.url));
const { app, service, ready } = buildDemo({
  rail,
  network,
  publicUrl,
  internalUrl: () => `http://127.0.0.1:${port}`,
  dataDir: process.env.DATA_DIR ?? ".data",
  platformFeeBps: Number(process.env.PLATFORM_FEE_BPS ?? 1000),
  payoutReceiver: (id) =>
    process.env[`PAYOUT_${id.toUpperCase().replace(/-/g, "_")}`] ?? process.env.PAYOUT_RECEIVER ?? `${id}@example.com`,
  ...(process.env.ANTHROPIC_API_KEY ? { anthropicKey: process.env.ANTHROPIC_API_KEY } : {}),
  maxClaudeRunsPerHour: Number(process.env.MAX_CLAUDE_RUNS_PER_HOUR ?? 20),
  webHtml: () => readFileSync(htmlPath, "utf8"),
  // Behind Render's proxy set TRUST_PROXY_HOPS=1; locally the socket address is used.
  trustProxyHops: Number(process.env.TRUST_PROXY_HOPS ?? 0),
});

serve({ fetch: app.fetch, port }, async () => {
  await ready();
  setInterval(() => void service.sweep().catch((e) => console.error("sweep", e)), 60_000);
  console.log(`AgentTab demo on ${publicUrl}  rail=${rail.mode}  agent=${process.env.ANTHROPIC_API_KEY ? "claude" : "scripted"}`);
  if (!hasPayPal) console.log("No PAYPAL_CLIENT_ID/SECRET: using the SIMULATED rail (no real PayPal calls).");
});
