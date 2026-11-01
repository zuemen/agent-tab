import { describe, expect, it } from "vitest";
import { cleanSchema, createOpenAICompatClient, fromChatReply, isDailyQuota, modelFromEnv, retryHintSeconds, toChatMessages } from "../src/openai-compat.ts";

describe("OpenAI-compatible adapter", () => {
  it("translates system, tool calls with provider extras, and tool results", () => {
    const msgs = toChatMessages({
      system: "sys",
      messages: [
        { role: "user", content: "task" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "tool_use", id: "c1", name: "tab_status", input: {}, _compat: { extra_content: { google: { thought_signature: "sig" } } } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "nope", is_error: true }] },
      ],
    });
    expect(msgs).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      {
        role: "assistant",
        content: "checking",
        tool_calls: [{ extra_content: { google: { thought_signature: "sig" } }, id: "c1", type: "function", function: { name: "tab_status", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "ERROR: nope" },
    ]);
  });

  it("turns tool calls into tool_use blocks and keeps provider extras", () => {
    const out = fromChatReply(
      {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [{ id: "", type: "function", extra_content: { google: { thought_signature: "s" } }, function: { name: "x", arguments: '{"a":1}' } }],
            },
          },
        ],
      },
      () => "gen1",
    );
    expect(out).toEqual({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "gen1", name: "x", input: { a: 1 }, _compat: { extra_content: { google: { thought_signature: "s" } } } }] });
    expect(fromChatReply({ choices: [{ finish_reason: "stop", message: { content: "done" } }] }, () => "z")).toEqual({ stop_reason: "end_turn", content: [{ type: "text", text: "done" }] });
  });

  it("strips schema keywords some servers reject", () => {
    expect(cleanSchema({ $schema: "x", type: "object", additionalProperties: false, properties: { a: { type: "string", additionalProperties: false } } })).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
    });
  });

  it("sends the configured model with bearer auth and retries on 429", async () => {
    const calls: { url: string; body: { model: string; tools?: unknown[] }; auth: string | undefined }[] = [];
    let first = true;
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization });
      if (first) {
        first = false;
        return new Response("slow down", { status: 429 });
      }
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: "hi" } }] });
    }) as typeof fetch;
    const m = createOpenAICompatClient({ baseUrl: "https://llm.test/v1/", apiKey: "k", model: "m1", label: "Test", fetch: fake, retryDelayMs: 1 });
    const res = await (m.client.beta.messages.create as unknown as (p: unknown) => Promise<unknown>)({
      model: "claude-ignored",
      system: "s",
      messages: [{ role: "user", content: "q" }],
      tools: [{ name: "t", description: "d", input_schema: { type: "object", properties: {} } }],
      thinking: { type: "adaptive" },
    });
    expect(res).toEqual({ stop_reason: "end_turn", content: [{ type: "text", text: "hi" }] });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://llm.test/v1/chat/completions");
    expect(calls[0]!.auth).toBe("Bearer k");
    expect(calls[0]!.body.model).toBe("m1");
    expect(calls[0]!.body.tools).toEqual([{ type: "function", function: { name: "t", description: "d", parameters: { type: "object", properties: {} } } }]);
  });

  it("does not retry other errors", async () => {
    let n = 0;
    const fake = (async () => {
      n++;
      return new Response("bad key", { status: 401 });
    }) as unknown as typeof fetch;
    const m = createOpenAICompatClient({ baseUrl: "https://llm.test", apiKey: "k", model: "m", label: "Test", fetch: fake, retryDelayMs: 1 });
    await expect((m.client.beta.messages.create as unknown as (p: unknown) => Promise<unknown>)({ messages: [{ role: "user", content: "q" }] })).rejects.toThrow(/Test request failed: 401/);
    expect(n).toBe(1);
  });

  it("picks the model from the environment", async () => {
    expect(await modelFromEnv({})).toBeUndefined();
    expect(await modelFromEnv({ GEMINI_API_KEY: "g" })).toMatchObject({ label: "Gemini", model: "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.5-flash" });
    expect(await modelFromEnv({ GEMINI_API_KEY: "g", LLM_MODEL: "gemini-x", LLM_LABEL: "Gemini X" })).toMatchObject({ label: "Gemini X", model: "gemini-x" });
    expect(await modelFromEnv({ LLM_BASE_URL: "https://x", LLM_API_KEY: "k", LLM_MODEL: "llama" })).toMatchObject({ label: "llama", model: "llama" });
    expect(await modelFromEnv({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g" })).toMatchObject({ label: "Claude", model: "claude-sonnet-5-5" });
  });
});

describe("OpenAI-compatible adapter timeouts", () => {
  it("retries a hung request, then reports it", async () => {
    let n = 0;
    const hang = ((_u: string, init: RequestInit) => {
      n++;
      return new Promise<Response>((_r, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
    }) as unknown as typeof fetch;
    const m = createOpenAICompatClient({ baseUrl: "https://llm.test", apiKey: "k", model: "m", label: "Test", fetch: hang, timeoutMs: 20, maxRetries: 1 });
    await expect((m.client.beta.messages.create as unknown as (p: unknown) => Promise<unknown>)({ messages: [{ role: "user", content: "q" }] })).rejects.toThrow(/Test request failed/);
    expect(n).toBe(2);
  });
});

describe("model rotation on daily quota", () => {
  const daily = JSON.stringify([{ error: { code: 429, message: "Quota exceeded ... quotaId GenerateRequestsPerDayPerProjectPerModel-FreeTier. Please retry in 16h24m30.19s." } }]);
  const create = (m: { client: unknown }) => (m.client as { beta: { messages: { create: (p: unknown) => Promise<unknown> } } }).beta.messages.create;

  it("parses retry hints and tells daily from per-minute quotas", () => {
    expect(retryHintSeconds("Please retry in 16h24m30.19s.")).toBeCloseTo(59070.19, 1);
    expect(retryHintSeconds("Please retry in 12.5s.")).toBe(12.5);
    expect(retryHintSeconds("no hint")).toBeUndefined();
    expect(isDailyQuota(daily)).toBe(true);
    expect(isDailyQuota("per minute limit. Please retry in 12s.")).toBe(false);
  });

  it("switches to the next model, swaps foreign thought signatures, and reports when all are used up", async () => {
    const sent: { model: string; messages: { tool_calls?: { extra_content?: { google?: { thought_signature?: string } } }[] }[] }[] = [];
    const fake = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      sent.push(body);
      if (body.model === "a") return new Response(daily, { status: 429 });
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] });
    }) as unknown as typeof fetch;
    const m = createOpenAICompatClient({ baseUrl: "https://llm.test", apiKey: "k", model: "a, b", label: "Test", fetch: fake, retryDelayMs: 1 });
    expect(m.model).toBe("a,b");
    const history = {
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "t", input: {}, _model: "a", _compat: { extra_content: { google: { thought_signature: "from-a" } } } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "r" }] },
      ],
    };
    expect(await create(m)(history)).toEqual({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] });
    expect(sent.map((b) => b.model)).toEqual(["a", "b"]);
    expect(sent[0]!.messages[1]!.tool_calls![0]!.extra_content!.google!.thought_signature).toBe("from-a");
    expect(sent[1]!.messages[1]!.tool_calls![0]!.extra_content!.google!.thought_signature).toBe("skip_thought_signature_validator");
    // "a" is now skipped without a request.
    await create(m)({ messages: [{ role: "user", content: "q" }] });
    expect(sent.map((b) => b.model)).toEqual(["a", "b", "b"]);
    expect(m.available!()).toBe(true);

    const allOut = createOpenAICompatClient({ baseUrl: "https://llm.test", apiKey: "k", model: "a", label: "Test", fetch: fake, retryDelayMs: 1 });
    await expect(create(allOut)({ messages: [{ role: "user", content: "q" }] })).rejects.toMatchObject({ name: "ModelQuotaError" });
    expect(allOut.available!()).toBe(false);
  });
});

describe("keys from the environment", () => {
  it("trims whitespace pasted around a key", async () => {
    let auth = "";
    const real = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      auth = (init.headers as Record<string, string>).authorization ?? "";
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] });
    }) as unknown as typeof fetch;
    try {
      const m = await modelFromEnv({ GEMINI_API_KEY: "  abc\r\n" });
      await (m!.client.beta.messages.create as unknown as (p: unknown) => Promise<unknown>)({ messages: [{ role: "user", content: "q" }] });
    } finally {
      globalThis.fetch = real;
    }
    expect(auth).toBe("Bearer abc");
  });
});
