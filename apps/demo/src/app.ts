import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { generateAgentKeyPair, type AgentKeyPair } from "@agent-tab/core";
import type { PayPalRail } from "@agent-tab/paypal";
import { TabService, createApp, type SellerConfig } from "@agent-tab/facilitator";
import { SELLERS, facilitatorClientFor, prepareSeller, type PreparedSeller } from "@agent-tab/seller-mcp";
import { connectSeller, runClaudeAgent, runScriptedAgent, type AgentEvent } from "@agent-tab/agent";
import type { PayPalNetwork } from "@agent-tab/x402-paypal";

export const DEMO_TASK =
  "I run Harbor Bean, a small café next to the Port Alder ferry terminal. Should I add an oat-milk cold brew this season, and at what price? Use the paid sources only where they help.";

/** Sellers the demo agent asks for. Velvet Insights is deliberately left out. */
export const DEMO_SELLERS = ["harbor-gazette", "openfield-data", "field-panel"];

export interface DemoOptions {
  rail: PayPalRail;
  network: PayPalNetwork;
  publicUrl: string;
  /** Where the in-process sellers reach the facilitator (loopback). */
  internalUrl: () => string;
  dataDir?: string;
  platformFeeBps?: number;
  payoutReceiver: (sellerId: string) => string;
  anthropicKey?: string;
  maxClaudeRunsPerHour?: number;
  webHtml?: () => string;
}

interface AgentSession {
  keys: AgentKeyPair;
  runs: number;
  running: boolean;
}

export function buildDemo(opts: DemoOptions): { app: Hono; service: TabService; ready: () => Promise<void> } {
  const sellerConfigs: SellerConfig[] = SELLERS.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    payoutReceiver: opts.payoutReceiver(s.id),
    apiKey: randomBytes(18).toString("base64url"),
  }));
  const service = new TabService(opts.rail, {
    publicUrl: opts.publicUrl,
    network: opts.network,
    platformFeeBps: opts.platformFeeBps ?? 1000,
    sellers: sellerConfigs,
    ...(opts.dataDir ? { dataFile: `${opts.dataDir}/tabs-${opts.network.replace(":", "-")}.json` } : {}),
  });

  // Demo agent keys live next to the tab data so a restart does not orphan open tabs.
  const keyFile = opts.dataDir ? `${opts.dataDir}/demo-agents-${opts.network.replace(":", "-")}.json` : undefined;
  const sessions = new Map<string, AgentSession>();
  if (keyFile && existsSync(keyFile)) {
    for (const [tabId, keys] of Object.entries(JSON.parse(readFileSync(keyFile, "utf8")) as Record<string, AgentKeyPair>)) {
      sessions.set(tabId, { keys, runs: 0, running: false });
    }
  }
  const saveKeys = () => {
    if (!keyFile) return;
    mkdirSync(dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, JSON.stringify(Object.fromEntries([...sessions].map(([id, s]) => [id, s.keys]))));
  };

  const app = createApp(service, opts.webHtml ? { webHtml: opts.webHtml } : {});
  const prepared = new Map<string, PreparedSeller>();
  const claudeRuns: number[] = [];

  // ---- seller MCP endpoints (stateless Streamable HTTP), for any MCP client ----
  app.all("/mcp/:seller", async (c) => {
    const p = prepared.get(c.req.param("seller"));
    if (!p) return c.json({ error: "unknown seller" }, 404);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await p.newServer().connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  app.get("/api/demo/info", (c) =>
    c.json({
      task: DEMO_TASK,
      agentMode: opts.anthropicKey ? "claude" : "scripted",
      rail: opts.rail.mode,
      sellers: SELLERS.map((s) => ({ id: s.id, name: s.name, description: s.description, tools: s.tools.map((t) => ({ name: t.name, title: t.title, price: t.price ?? null })) })),
      demoSellers: DEMO_SELLERS,
    }),
  );

  // ---- step 1: the demo agent asks the human for a tab ----
  app.post("/api/demo/start", async (c) => {
    const keys = generateAgentKeyPair();
    const { tabId, reviewUrl } = service.requestTab({
      agentPublicKey: keys.publicKey,
      agentName: "Harbor Bean research agent",
      purpose: DEMO_TASK,
      suggested: { budgetUsd: "3.00", perCallCapUsd: "0.50", captureThresholdUsd: "0.50", sellers: DEMO_SELLERS, expiresInHours: 24 },
    });
    sessions.set(tabId, { keys, runs: 0, running: false });
    saveKeys();
    return c.json({ tabId, reviewUrl }, 201);
  });

  // ---- step 4: run the agent against its open tab ----
  app.post("/api/demo/run", async (c) => {
    const { tabId, mode } = (await c.req.json()) as { tabId: string; mode?: "auto" | "scripted" };
    const session = sessions.get(tabId);
    if (!session) return c.json({ error: "this tab was not opened by the demo agent" }, 404);
    if (session.running) return c.json({ error: "the agent is already running" }, 409);
    if (session.runs >= 3) return c.json({ error: "run limit for this tab reached" }, 429);
    const view = service.view(tabId) as { status: string };
    if (view.status !== "active") return c.json({ error: `tab is ${view.status}` }, 409);

    let useClaude = mode !== "scripted" && !!opts.anthropicKey;
    if (useClaude) {
      const hourAgo = Date.now() - 3600_000;
      while (claudeRuns.length && claudeRuns[0]! < hourAgo) claudeRuns.shift();
      if (claudeRuns.length >= (opts.maxClaudeRunsPerHour ?? 20)) useClaude = false;
      else claudeRuns.push(Date.now());
    }
    session.running = true;
    session.runs++;
    const emit = (ev: AgentEvent) => service.events.emit("event", { tabId, type: "agent", at: Date.now(), detail: ev });
    void (async () => {
      const conns = [];
      try {
        const signer = { tabId, keys: session.keys };
        for (const p of prepared.values()) {
          const [clientT, serverT] = InMemoryTransport.createLinkedPair();
          await p.newServer().connect(serverT);
          conns.push(await connectSeller(p.seller.id, p.seller.name, clientT, opts.network, () => signer));
        }
        const base = { task: DEMO_TASK, sellers: conns, tabStatus: async () => service.view(tabId), onEvent: emit };
        if (useClaude) await runClaudeAgent(base);
        else await runScriptedAgent(base);
      } catch (err) {
        emit({ type: "done", answer: `Agent stopped: ${(err as Error).message}`, mode: useClaude ? "claude" : "scripted" });
      } finally {
        session.running = false;
        for (const conn of conns) await conn.client.close().catch(() => undefined);
      }
    })();
    return c.json({ started: true, mode: useClaude ? "claude" : "scripted" }, 202);
  });

  const ready = async () => {
    for (const s of SELLERS) {
      const cfg = sellerConfigs.find((x) => x.id === s.id)!;
      prepared.set(s.id, await prepareSeller(s, facilitatorClientFor(opts.internalUrl(), cfg.apiKey), opts.network));
    }
  };
  return { app, service, ready };
}
