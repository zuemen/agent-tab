import type Anthropic from "@anthropic-ai/sdk";

/**
 * Lets the agent and the tab assistant run on any OpenAI-compatible chat
 * completions endpoint (Gemini, Workers AI, Groq, a local server) without
 * changing their tool-use loops: it exposes the one Anthropic method they call,
 * `beta.messages.create`, and translates requests and replies.
 *
 * Anthropic-only request fields (thinking, effort, prompt caching, refusal
 * fallbacks) have no equivalent and are ignored. The configured model is used
 * whatever `model` the caller passes.
 */
export interface OpenAICompatConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Shown in the UI, e.g. "Gemini". */
  label: string;
  fetch?: typeof fetch;
  /** Retries on 429/5xx. Free tiers rate-limit per minute. */
  maxRetries?: number;
  retryDelayMs?: number;
  /** Per-request timeout; a hung request is retried like a 5xx. */
  timeoutMs?: number;
}

export interface ModelClient {
  client: Anthropic;
  label: string;
  model: string;
  /** False while every configured model is out of its daily quota. */
  available?: () => boolean;
}

/** Every configured model is out of its daily quota. */
export class ModelQuotaError extends Error {
  override name = "ModelQuotaError";
}

/** Gemini accepts this in place of a thought signature produced by a different model. */
const SKIP_SIGNATURE = "skip_thought_signature_validator";

interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  /** Provider fields on a tool call (e.g. Gemini thought signatures) that must be sent back. */
  _compat?: Record<string, unknown>;
  /** The model that produced this tool call. */
  _model?: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Record<string, unknown>[];
  tool_call_id?: string;
}

interface CreateParams {
  system?: string | { text: string }[];
  messages: { role: "user" | "assistant"; content: string | Block[] }[];
  tools?: { name: string; description?: string; input_schema: Record<string, unknown> }[];
  max_tokens?: number;
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: Block) => (c.type === "text" ? (c.text ?? "") : JSON.stringify(c))).join("\n");
  return JSON.stringify(content);
}

/** Drop JSON Schema keywords some OpenAI-compatible servers reject. */
export function cleanSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "$schema" || k === "additionalProperties") continue;
    out[k] = cleanSchema(v);
  }
  return out;
}

function compatFor(b: Block, model: string | undefined): Record<string, unknown> {
  const extra = b._compat ?? {};
  if (!model || !b._model || b._model === model) return extra;
  // A tool call made by another model: its thought signature is not valid for this one.
  const google = (extra.extra_content as { google?: Record<string, unknown> } | undefined)?.google;
  if (!google?.thought_signature) return extra;
  return { ...extra, extra_content: { ...(extra.extra_content as object), google: { ...google, thought_signature: SKIP_SIGNATURE } } };
}

export function toChatMessages(params: CreateParams, model?: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  const system = Array.isArray(params.system) ? params.system.map((s) => s.text).join("\n") : params.system;
  if (system) out.push({ role: "system", content: system });
  for (const m of params.messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const said = m.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
      const calls = m.content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ ...compatFor(b, model), id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: "assistant", content: said || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    const plain: string[] = [];
    for (const b of m.content) {
      if (b.type === "tool_result") {
        out.push({ role: "tool", tool_call_id: b.tool_use_id ?? "", content: `${b.is_error ? "ERROR: " : ""}${text(b.content)}` });
      } else if (b.type === "text") {
        plain.push(b.text ?? "");
      }
    }
    if (plain.length) out.push({ role: "user", content: plain.join("\n") });
  }
  return out;
}

interface ChatReply {
  choices?: {
    finish_reason?: string;
    message?: { content?: string | null; tool_calls?: (Record<string, unknown> & { id?: string; function?: { name?: string; arguments?: string } })[] };
  }[];
}

export function fromChatReply(reply: ChatReply, newId: () => string, model?: string): { stop_reason: string; content: Block[] } {
  const msg = reply.choices?.[0]?.message ?? {};
  const content: Block[] = [];
  if (msg.content && msg.content.trim()) content.push({ type: "text", text: msg.content });
  for (const call of msg.tool_calls ?? []) {
    const { id, function: fn, type: _type, index: _index, ...extra } = call;
    let input: unknown = {};
    try {
      input = fn?.arguments ? JSON.parse(fn.arguments) : {};
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: id || newId(), name: fn?.name ?? "", input, ...(Object.keys(extra).length ? { _compat: extra } : {}), ...(model ? { _model: model } : {}) });
  }
  const usesTools = content.some((b) => b.type === "tool_use");
  return { stop_reason: usesTools ? "tool_use" : reply.choices?.[0]?.finish_reason === "length" ? "max_tokens" : "end_turn", content };
}

/** Seconds from a "Please retry in 16h24m30.1s" / "retry in 12s" hint. */
export function retryHintSeconds(body: string): number | undefined {
  const m = /retry in ((?:\d+h)?(?:\d+m)?(?:[\d.]+s)?)/i.exec(body);
  if (!m?.[1]) return undefined;
  const h = /(\d+)h/.exec(m[1]), mi = /(\d+)m(?!s)/.exec(m[1]), sec = /([\d.]+)s/.exec(m[1]);
  const total = Number(h?.[1] ?? 0) * 3600 + Number(mi?.[1] ?? 0) * 60 + Number(sec?.[1] ?? 0);
  return total > 0 ? total : undefined;
}

/** A 429 that will not clear within minutes (a per-day quota). */
export function isDailyQuota(body: string): boolean {
  return /PerDay|per day/i.test(body) || (retryHintSeconds(body) ?? 0) > 600;
}

/**
 * `cfg.model` may list several models, comma-separated. They are tried in order;
 * a model whose daily quota is used up is skipped until its quota resets.
 */
export function createOpenAICompatClient(cfg: OpenAICompatConfig): ModelClient {
  const doFetch = cfg.fetch ?? fetch;
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const models = cfg.model.split(",").map((m) => m.trim()).filter(Boolean);
  const exhaustedUntil = new Map<string, number>();
  const usable = () => models.filter((m) => (exhaustedUntil.get(m) ?? 0) <= Date.now());
  let n = 0;
  const create = async (params: CreateParams) => {
    const tools = params.tools?.length
      ? { tools: params.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: cleanSchema(t.input_schema) } })) }
      : {};
    const retries = cfg.maxRetries ?? 3;
    let attempt = 0;
    for (;;) {
      const model = usable()[0];
      if (!model) throw new ModelQuotaError(`${cfg.label}: the free daily quota of every configured model is used up`);
      const body = { model, messages: toChatMessages(params, model), ...tools, ...(params.max_tokens ? { max_tokens: params.max_tokens } : {}) };
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(cfg.timeoutMs ?? 45_000),
        });
      } catch (err) {
        if (++attempt > retries) throw new Error(`${cfg.label} request failed: ${(err as Error).message}`);
        continue;
      }
      if (res.ok) return fromChatReply((await res.json()) as ChatReply, () => `call_${++n}`, model);
      const detail = await res.text().catch(() => "");
      if (res.status === 429 && isDailyQuota(detail)) {
        // Try the next model right away; this one is done until its quota resets.
        exhaustedUntil.set(model, Date.now() + (retryHintSeconds(detail) ?? 3600) * 1000);
        console.warn(`${cfg.label}: daily quota used up for ${model}; switching model`);
        continue;
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || ++attempt > retries) throw new Error(`${cfg.label} request failed: ${res.status} ${detail.slice(0, 300)}`);
      const after = Number(res.headers.get("retry-after")) || retryHintSeconds(detail);
      await new Promise((r) => setTimeout(r, after && after > 0 && after <= 60 ? after * 1000 : (cfg.retryDelayMs ?? 4000) * attempt));
    }
  };
  return {
    client: { beta: { messages: { create } } } as unknown as Anthropic,
    label: cfg.label,
    model: models.join(","),
    available: () => usable().length > 0,
  };
}

/** Gemini's OpenAI-compatible endpoint (free tier available from Google AI Studio). */
export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
// Free tier quotas are per model and per day (gemini-3.5-flash: 20 requests/day as of 2026-11-01),
// so the default rotates through models. Flash-Lite first: in testing it finished a run in ~5 s.
// gemini-flash-latest / gemini-3.8-flash hung on tool calls; gemini-2.5-flash is closed to new users.
export const GEMINI_DEFAULT_MODEL = "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.5-flash";

/**
 * Pick the model from the environment: ANTHROPIC_API_KEY (Claude) first, then
 * LLM_BASE_URL + LLM_API_KEY (any OpenAI-compatible server), then GEMINI_API_KEY.
 * Returns undefined when none is set (the demo then runs the scripted plan).
 */
export async function modelFromEnv(env: Record<string, string | undefined>): Promise<ModelClient | undefined> {
  if (env.ANTHROPIC_API_KEY) {
    const { default: AnthropicClient } = await import("@anthropic-ai/sdk");
    return { client: new AnthropicClient({ apiKey: env.ANTHROPIC_API_KEY.trim() }), label: "Claude", model: env.AGENT_MODEL ?? "claude-sonnet-5-5" };
  }
  if (env.LLM_BASE_URL && env.LLM_API_KEY) {
    return createOpenAICompatClient({ baseUrl: env.LLM_BASE_URL.trim(), apiKey: env.LLM_API_KEY.trim(), model: env.LLM_MODEL ?? "", label: env.LLM_LABEL ?? env.LLM_MODEL ?? "LLM" });
  }
  if (env.GEMINI_API_KEY) {
    return createOpenAICompatClient({ baseUrl: GEMINI_BASE_URL, apiKey: env.GEMINI_API_KEY.trim(), model: env.LLM_MODEL ?? GEMINI_DEFAULT_MODEL, label: env.LLM_LABEL ?? "Gemini" });
  }
  return undefined;
}
