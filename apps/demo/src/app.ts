import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { generateAgentKeyPair, type AgentKeyPair } from "@agent-tab/core";
import { SandboxRail, type PayPalRail } from "@agent-tab/paypal";
import { OWNER_HEADER, TabService, UserError, clientIp, createApp, rateLimiter, type SellerConfig } from "@agent-tab/facilitator";
import { SELLERS, facilitatorClientFor, prepareSeller, type PreparedSeller } from "@agent-tab/seller-mcp";
import { connectSeller, runClaudeAgent, runScriptedAgent, type AgentEvent } from "@agent-tab/agent";
import type { PayPalNetwork } from "@agent-tab/x402-paypal";
import { askAssistant, connectPayPalToolkit } from "./assistant.ts";

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
  /** See AppOptions.trustProxyHops. */
  trustProxyHops?: number;
}

interface AgentSession {
  keys: AgentKeyPair;
  runs: number;
  questions: number;
  running: boolean;
  log: AgentEvent[];
  mode?: "claude" | "scripted";
  note?: string;
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
      sessions.set(tabId, { keys, runs: 0, questions: 0, running: false, log: [] });
    }
  }
  const saveKeys = () => {
    if (!keyFile) return;
    mkdirSync(dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, JSON.stringify(Object.fromEntries([...sessions].map(([id, s]) => [id, s.keys]))));
  };

  const app = createApp(service, { ...(opts.webHtml ? { webHtml: opts.webHtml } : {}), trustProxyHops: opts.trustProxyHops ?? 0 });
  const ip = (c: Context) => clientIp(c, opts.trustProxyHops ?? 0);
  const prepared = new Map<string, PreparedSeller>();
  const startLimiter = rateLimiter(20, 3600_000);
  const claudePerIp = rateLimiter(10, 3600_000);
  const claudeRuns: number[] = [];
  /** Global Claude budget for the server's key, plus a per-IP share of it. */
  const allowClaude = (c: Context) => {
    const hourAgo = Date.now() - 3600_000;
    while (claudeRuns.length && claudeRuns[0]! < hourAgo) claudeRuns.shift();
    if (claudeRuns.length >= (opts.maxClaudeRunsPerHour ?? 20) || !claudePerIp(ip(c))) return false;
    claudeRuns.push(Date.now());
    return true;
  };
  const ownedSession = (c: Context): [string, AgentSession] => {
    const tabId = c.req.param("id") ?? "";
    if (!service.has(tabId)) throw new UserError("unknown tab", 404);
    if (!service.isOwner(tabId, c.req.header(OWNER_HEADER))) throw new UserError("only the tab owner can do this", 403);
    const session = sessions.get(tabId);
    if (!session) throw new UserError("this tab was not opened by the demo agent", 404);
    return [tabId, session];
  };

  // ---- seller MCP endpoints (stateless Streamable HTTP, POST only), for any MCP client ----
  app.post("/mcp/:seller", async (c) => {
    const p = prepared.get(c.req.param("seller"));
    if (!p) return c.json({ error: "unknown seller" }, 404);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await p.newServer().connect(transport);
    return transport.handleRequest(c.req.raw);
  });
  app.on(["GET", "DELETE"], "/mcp/:seller", (c) => c.json({ error: "stateless server: use POST" }, 405));

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
    if (!startLimiter(ip(c))) return c.json({ error: "too many demos started from here; try again later" }, 429);
    const keys = generateAgentKeyPair();
    const { tabId, reviewUrl } = service.requestTab({
      agentPublicKey: keys.publicKey,
      agentName: "Harbor Bean research agent",
      purpose: DEMO_TASK,
      suggested: { budgetUsd: "5.00", perCallCapUsd: "0.50", captureThresholdUsd: "0.50", sellers: DEMO_SELLERS, expiresInHours: 24 },
    });
    sessions.set(tabId, { keys, runs: 0, questions: 0, running: false, log: [] });
    saveKeys();
    // The browser that clicked Start is the owner; the demo agent itself only ever holds its signing key.
    return c.json({ tabId, reviewUrl }, 201);
  });

  app.get("/api/demo/runs/:id", (c) => {
    const [, s] = ownedSession(c);
    return c.json({ running: s.running, mode: s.mode, note: s.note, runs: s.runs, log: s.log });
  });

  // ---- step 4: run the agent against its open tab (owner only) ----
  app.post("/api/demo/run", async (c) => {
    const { tabId } = (await c.req.json().catch(() => ({}))) as { tabId?: string };
    const session = sessions.get(tabId ?? "");
    if (!tabId || !service.has(tabId)) return c.json({ error: "unknown tab" }, 404);
    if (!service.isOwner(tabId, c.req.header(OWNER_HEADER))) return c.json({ error: "only the tab owner can do this" }, 403);
    if (!session) return c.json({ error: "this tab was not opened by the demo agent" }, 404);
    if (session.running) return c.json({ error: "the agent is already running" }, 409);
    if (session.runs >= 3) return c.json({ error: "run limit for this tab reached" }, 429);
    const view = service.view(tabId) as { status: string };
    if (view.status !== "active") return c.json({ error: `tab is ${view.status}` }, 409);

    const wantClaude = !!opts.anthropicKey;
    const useClaude = wantClaude && allowClaude(c);
    session.running = true;
    session.runs++;
    session.mode = useClaude ? "claude" : "scripted";
    session.note = wantClaude && !useClaude ? "Claude quota for this hour is used up, so this run follows the scripted plan." : undefined;
    session.log = [];
    const emit = (ev: AgentEvent) => {
      if (session.log.length < 300) session.log.push(ev);
      service.events.emit("event", { tabId, type: "agent", at: Date.now(), detail: ev });
    };
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
        if (useClaude) await runClaudeAgent({ ...base, maxTurns: 12 });
        else await runScriptedAgent(base);
      } catch (err) {
        console.error("agent run", tabId, err);
        emit({ type: "done", answer: "The agent stopped because of an error. The tab is unaffected; you can close it.", mode: session.mode! });
      } finally {
        session.running = false;
        for (const conn of conns) await conn.client.close().catch(() => undefined);
      }
    })();
    return c.json({ started: true, mode: session.mode, ...(session.note ? { note: session.note } : {}) }, 202);
  });

  // ---- tab assistant (Claude + PayPal Agent Toolkit), owner only ----
  let toolkit: { client: Client; at: number } | undefined;
  app.post("/api/tabs/:id/ask", async (c) => {
    const tabId = c.req.param("id");
    if (!service.has(tabId)) return c.json({ error: "unknown tab" }, 404);
    if (!service.isOwner(tabId, c.req.header(OWNER_HEADER))) return c.json({ error: "only the tab owner can do this" }, 403);
    if (!opts.anthropicKey) return c.json({ error: "The tab assistant needs ANTHROPIC_API_KEY on the server." }, 503);
    const { question } = (await c.req.json().catch(() => ({}))) as { question?: string };
    if (typeof question !== "string" || !question.trim() || question.length > 500) return c.json({ error: "Ask a question (max 500 characters)." }, 400);
    const session = sessions.get(tabId);
    if (session && session.questions >= 8) return c.json({ error: "Question limit for this tab reached." }, 429);
    if (!allowClaude(c)) return c.json({ error: "The assistant is busy; try again later." }, 429);
    if (session) session.questions++;
    const view = service.view(tabId) as { paypal?: { orderId?: string } };
    if (opts.rail instanceof SandboxRail && (!toolkit || Date.now() - toolkit.at > 30 * 60_000)) {
      toolkit = { client: await connectPayPalToolkit(await opts.rail.getAccessToken()), at: Date.now() };
    }
    const actions: unknown[] = [];
    try {
      const answer = await askAssistant({
        question,
        facts: { tabId, ...(view.paypal?.orderId ? { orderId: view.paypal.orderId } : {}), view },
        proposeRefund: (n, reason) => service.proposeRefund(tabId, n, reason || "requested in the tab assistant"),
        ...(toolkit ? { toolkit: toolkit.client } : {}),
        onEvent: (ev) => {
          actions.push(ev);
          service.events.emit("event", { tabId, type: "assistant", at: Date.now(), detail: ev });
        },
      });
      return c.json({ answer, actions, paypalTools: !!toolkit });
    } catch (err) {
      console.error("assistant", tabId, err);
      return c.json({ error: "The assistant could not answer right now." }, 502);
    }
  });

  const ready = async () => {
    for (const s of SELLERS) {
      const cfg = sellerConfigs.find((x) => x.id === s.id)!;
      prepared.set(s.id, await prepareSeller(s, facilitatorClientFor(opts.internalUrl(), cfg.apiKey), opts.network));
    }
  };
  return { app, service, ready };
}
