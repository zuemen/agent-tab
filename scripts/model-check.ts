/**
 * Runs the demo once with the REAL model from .env (GEMINI_API_KEY / LLM_* /
 * ANTHROPIC_API_KEY) on the simulated PayPal rail: the agent buys under the tab,
 * then the tab assistant answers a question and proposes a refund.
 * No money moves. Usage: npx tsx scripts/model-check.ts
 */
import { serve } from "@hono/node-server";
import { SimulatedRail } from "@agent-tab/paypal";
import { modelFromEnv } from "@agent-tab/agent";
import { buildDemo } from "../apps/demo/src/app.ts";

if ((await import("node:fs")).existsSync(".env")) process.loadEnvFile(".env");
const model = await modelFromEnv({ ...process.env, ANTHROPIC_API_KEY: process.env.CHECK_ANTHROPIC === "1" ? process.env.ANTHROPIC_API_KEY : undefined });
if (!model) throw new Error("no model key in .env");
console.log(`model: ${model.label} (${model.model})`);

let base = "";
const rail = new SimulatedRail("http://pending/simulated/approve");
const demo = buildDemo({ rail, network: "paypal:simulated", publicUrl: "http://pending", internalUrl: () => base, payoutReceiver: (id) => `${id}@example.com`, dataDir: ".data/model-check", model });
const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
  const s = serve({ fetch: demo.app.fetch, port: 0 }, (info) => {
    base = `http://127.0.0.1:${info.port}`;
    resolve(s);
  });
});
(demo.service.config as { publicUrl: string }).publicUrl = base;
await demo.ready();

const j = (r: Response) => r.json() as Promise<any>;
const start = await fetch(`${base}/api/demo/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(j);
let owner = new URL(start.reviewUrl).hash.replace("#owner=", "");
const H = () => ({ "content-type": "application/json", "x-agenttab-owner": owner });
const view = await fetch(`${base}/api/tabs/${start.tabId}`, { headers: H() }).then(j);
const terms = await fetch(`${base}/api/tabs/${start.tabId}/terms`, { method: "POST", headers: H(), body: JSON.stringify(view.suggested) });
const cookie = terms.headers.get("set-cookie")!.split(";")[0]!;
const { approveUrl } = await terms.json();
const back = await fetch(rail.approve(new URL(approveUrl).searchParams.get("token")!), { redirect: "manual", headers: { cookie } });
owner = /#owner=([A-Za-z0-9_-]+)/.exec(back.headers.get("location") ?? "")![1]!;

const t0 = Date.now();
console.log("run:", await fetch(`${base}/api/demo/run`, { method: "POST", headers: H(), body: JSON.stringify({ tabId: start.tabId }) }).then(j));
let s: any;
do {
  await new Promise((r) => setTimeout(r, 1000));
  s = await fetch(`${base}/api/demo/runs/${start.tabId}`, { headers: H() }).then(j);
} while (s.running && Date.now() - t0 < 300_000);
for (const ev of s.log) {
  if (ev.type === "done") console.log(`\n[done mode=${ev.mode}]\n${ev.answer}\n`);
  else console.log(`- ${ev.type}`, ev.seller ?? "", ev.tool ?? "", ev.amount ?? ev.price ?? "", ev.reason ?? ev.message ?? (ev.text ? String(ev.text).slice(0, 120) : ""));
}
const after = await fetch(`${base}/api/tabs/${start.tabId}`, { headers: H() }).then(j);
console.log(`agent took ${Math.round((Date.now() - t0) / 1000)}s; spent ${after.totals?.spent} of ${after.totals?.budget ?? after.mandate?.budget}`);

const ask = await fetch(`${base}/api/tabs/${start.tabId}/ask`, { method: "POST", headers: H(), body: JSON.stringify({ question: "Which charge was least worth it? Propose a refund for it." }) }).then(j);
console.log("\nassistant:", ask.answer ?? ask.error);
console.log("assistant actions:", JSON.stringify(ask.actions ?? []));
server.close();
process.exit(0);
