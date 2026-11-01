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
}

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

export function toChatMessages(params: CreateParams): ChatMessage[] {
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
        .map((b) => ({ ...(b._compat ?? {}), id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
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

export function fromChatReply(reply: ChatReply, newId: () => string): { stop_reason: string; content: Block[] } {
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
    content.push({ type: "tool_use", id: id || newId(), name: fn?.name ?? "", input, ...(Object.keys(extra).length ? { _compat: extra } : {}) });
  }
  const usesTools = content.some((b) => b.type === "tool_use");
  return { stop_reason: usesTools ? "tool_use" : reply.choices?.[0]?.finish_reason === "length" ? "max_tokens" : "end_turn", content };
}

export function createOpenAICompatClient(cfg: OpenAICompatConfig): ModelClient {
  const doFetch = cfg.fetch ?? fetch;
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
  let n = 0;
  const create = async (params: CreateParams) => {
    const body = {
      model: cfg.model,
      messages: toChatMessages(params),
      ...(params.tools?.length
        ? { tools: params.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: cleanSchema(t.input_schema) } })) }
        : {}),
      ...(params.max_tokens ? { max_tokens: params.max_tokens } : {}),
    };
    const retries = cfg.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(cfg.timeoutMs ?? 45_000),
        });
      } catch (err) {
        if (attempt >= retries) throw new Error(`${cfg.label} request failed: ${(err as Error).message}`);
        continue;
      }
      if (res.ok) return fromChatReply((await res.json()) as ChatReply, () => `call_${++n}`);
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= retries) {
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        throw new Error(`${cfg.label} request failed: ${res.status} ${detail}`);
      }
      const after = Number(res.headers.get("retry-after"));
      await new Promise((r) => setTimeout(r, Number.isFinite(after) && after > 0 ? after * 1000 : (cfg.retryDelayMs ?? 4000) * (attempt + 1)));
    }
  };
  return { client: { beta: { messages: { create } } } as unknown as Anthropic, label: cfg.label, model: cfg.model };
}

/** Gemini's OpenAI-compatible endpoint (free tier available from Google AI Studio). */
export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
// gemini-flash-latest / gemini-3.8-flash hung on tool calls in testing (2026-11-01); 3.5 answered in ~1 s.
export const GEMINI_DEFAULT_MODEL = "gemini-3.5-flash";

/**
 * Pick the model from the environment: ANTHROPIC_API_KEY (Claude) first, then
 * LLM_BASE_URL + LLM_API_KEY (any OpenAI-compatible server), then GEMINI_API_KEY.
 * Returns undefined when none is set (the demo then runs the scripted plan).
 */
export async function modelFromEnv(env: Record<string, string | undefined>): Promise<ModelClient | undefined> {
  if (env.ANTHROPIC_API_KEY) {
    const { default: AnthropicClient } = await import("@anthropic-ai/sdk");
    return { client: new AnthropicClient({ apiKey: env.ANTHROPIC_API_KEY }), label: "Claude", model: env.AGENT_MODEL ?? "claude-sonnet-5-5" };
  }
  if (env.LLM_BASE_URL && env.LLM_API_KEY) {
    return createOpenAICompatClient({ baseUrl: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL ?? "", label: env.LLM_LABEL ?? env.LLM_MODEL ?? "LLM" });
  }
  if (env.GEMINI_API_KEY) {
    return createOpenAICompatClient({ baseUrl: GEMINI_BASE_URL, apiKey: env.GEMINI_API_KEY, model: env.LLM_MODEL ?? GEMINI_DEFAULT_MODEL, label: env.LLM_LABEL ?? "Gemini" });
  }
  return undefined;
}
