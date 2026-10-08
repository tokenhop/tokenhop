// YAN-733: FIM-capable models on providers with a native prompt/suffix endpoint
// skip the chat wrapper (Mistral /v1/fim/completions, DeepSeek /beta/completions).
// Only the executor is mocked; the URL comes from the real DefaultExecutor.buildUrl
// with the credentials chatCore hands it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ execute: executeMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  notifyRequestLogsEnabled: vi.fn(),
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("@/lib/usageDb.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    trackPendingRequest: vi.fn(),
    appendRequestLog: vi.fn(async () => {}),
    saveRequestDetailUnscoped: vi.fn(async () => {}),
  };
});

const db = await import("@/lib/localDb.js");
const { getUsageHistory } = await import("@/lib/db/index.js");
const { handleChat } = await import("../../src/sse/handlers/chat.js");
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { getCapabilitiesForModel } = await import("../../open-sse/providers/capabilities.js");

const json = (body) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const sse = (chunks) =>
  new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
const reply = (response) => ({ response, url: "x", headers: {}, transformedBody: null });

// Mistral FIM replies are chat-shaped; DeepSeek /beta replies are text_completion.
const mistralBody = (content) => ({
  id: "fim-1",
  object: "chat.completion",
  model: "codestral-latest",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
});
const mistralStream = (parts) =>
  sse([
    ...parts.map((content) => ({
      id: "fim-1",
      object: "chat.completion.chunk",
      model: "codestral-latest",
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })),
    {
      id: "fim-1",
      object: "chat.completion.chunk",
      model: "codestral-latest",
      choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
    },
  ]);
const deepseekStream = (parts) =>
  sse([
    ...parts.map((text) => ({
      id: "c-1",
      object: "text_completion",
      model: "deepseek-v4-pro",
      choices: [{ index: 0, text, finish_reason: null }],
    })),
    {
      id: "c-1",
      object: "text_completion",
      model: "deepseek-v4-pro",
      choices: [{ index: 0, text: "", finish_reason: "stop" }],
      usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
    },
  ]);

let seq = 0;
const lastCall = () => executeMock.mock.calls.at(-1)[0];
const urlOf = (call, provider) =>
  new DefaultExecutor(provider).buildUrl(call.model, call.stream, 0, call.credentials);

const postTo = (path, body) =>
  handleChat(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

async function readSse(res) {
  const text = await res.text();
  const events = text
    .split("\n\n")
    .map((e) => e.replace(/^data: /, "").trim())
    .filter(Boolean);
  return {
    done: events.at(-1) === "[DONE]",
    chunks: events.filter((e) => e !== "[DONE]").map(JSON.parse),
  };
}

describe("fim capability", () => {
  it.each([
    ["deepseek", "deepseek-v4-pro", true],
    ["deepseek", "deepseek-v4-pro-max", true],
    ["deepseek", "deepseek-v4-pro-none", true],
    ["deepseek", "deepseek-v4.1-flash", false],
    ["deepseek", "deepseek-v4-flash", false],
    ["mistral", "codestral-latest", true],
    ["mistral", "mistral-large-latest", false],
  ])("%s/%s → fim %s", (provider, model, fim) => {
    expect(getCapabilitiesForModel(provider, model).fim).toBe(fim);
  });

  it("deepseek-v4-pro keeps its reasoning caps", () => {
    expect(getCapabilitiesForModel("deepseek", "deepseek-v4-pro")).toMatchObject({
      reasoning: true,
      thinkingFormat: "deepseek",
    });
  });
});

describe("native FIM passthrough (YAN-733)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await db.updateSettings({ requireApiKey: false });
    seq += 1;
    for (const provider of ["mistral", "deepseek"]) {
      await db.createProviderConnectionUnscoped({
        provider,
        name: `${provider}-fim-${seq}`,
        apiKey: `sk-${provider}-${seq}`,
        isActive: true,
      });
    }
  });

  it("Codestral non-stream hits /v1/fim/completions with prompt/suffix", async () => {
    executeMock.mockImplementation(async () => reply(json(mistralBody("return a + b"))));
    const res = await postTo("/v1/fim/completions", {
      model: "mistral/codestral-latest",
      prompt: "def add(a, b):\n    ",
      suffix: "\n",
      random_seed: 7,
    });
    expect(res.status).toBe(200);
    const call = lastCall();
    expect(urlOf(call, "mistral")).toBe("https://api.mistral.ai/v1/fim/completions");
    expect(call.body).toMatchObject({
      model: "codestral-latest",
      prompt: "def add(a, b):\n    ",
      suffix: "\n",
      random_seed: 7,
      max_tokens: 128,
    });
    expect(call.body.messages).toBeUndefined();
    const out = await res.json();
    expect(out.choices[0].message.content).toBe("return a + b");
  });

  it("Codestral stream via /v1/completions returns cleaned text chunks", async () => {
    executeMock.mockImplementation(async () => reply(mistralStream(["return ", "a + b"])));
    const res = await postTo("/v1/completions", {
      model: "mistral/codestral-latest",
      prompt: "def add(a, b):\n    ",
      suffix: "\n",
      stream: true,
    });
    expect(urlOf(lastCall(), "mistral")).toBe("https://api.mistral.ai/v1/fim/completions");
    const { done, chunks } = await readSse(res);
    expect(done).toBe(true);
    expect(chunks.map((c) => c.choices?.[0]?.text ?? "").join("")).toBe("return a + b");
  });

  it("DeepSeek stream hits /beta/completions, translates text chunks and saves usage", async () => {
    executeMock.mockImplementation(async () => reply(deepseekStream(["return ", "a + b"])));
    const before = (await getUsageHistory(null, { provider: "deepseek" })).length;
    const res = await postTo("/v1/completions", {
      model: "deepseek/deepseek-v4-pro",
      prompt: "def add(a, b):\n    ",
      suffix: "\n",
      stream: true,
    });
    const call = lastCall();
    expect(urlOf(call, "deepseek")).toBe("https://api.deepseek.com/beta/completions");
    expect(call.body).toMatchObject({ suffix: "\n", stream_options: { include_usage: true } });
    const { done, chunks } = await readSse(res);
    expect(done).toBe(true);
    expect(chunks[0].object).toBe("text_completion");
    expect(chunks.map((c) => c.choices?.[0]?.text ?? "").join("")).toBe("return a + b");
    await vi.waitFor(async () => {
      const rows = await getUsageHistory(null, { provider: "deepseek" });
      expect(rows.length).toBe(before + 1);
    });
    const rows = await getUsageHistory(null, { provider: "deepseek" });
    expect(rows.some((r) => r.endpoint === "completions")).toBe(true);
  });

  it("DeepSeek -none alias sends the upstream id and no thinking knobs", async () => {
    executeMock.mockImplementation(async () =>
      reply(
        json({
          id: "c-1",
          object: "text_completion",
          model: "deepseek-v4-pro",
          choices: [{ index: 0, text: "return a + b", finish_reason: "stop" }],
          usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
        }),
      ),
    );
    const res = await postTo("/v1/completions", {
      model: "deepseek/deepseek-v4-pro-none",
      prompt: "def add(a, b):\n    ",
      suffix: "\n",
    });
    const body = lastCall().body;
    expect(body.model).toBe("deepseek-v4-pro");
    for (const key of ["extra_body", "reasoning_effort", "thinking", "messages"]) {
      expect(body[key]).toBeUndefined();
    }
    const out = await res.json();
    expect(out.object).toBe("text_completion");
    expect(out.choices[0].text).toBe("return a + b");
  });

  it("/infill to Codestral sends input_prefix+prompt / input_suffix natively", async () => {
    executeMock.mockImplementation(async () => reply(json(mistralBody("a + b"))));
    const res = await postTo("/infill", {
      model: "mistral/codestral-latest",
      input_prefix: "def add(a, b):\n",
      prompt: "    return ",
      input_suffix: "\n",
      n_predict: 16,
    });
    expect(lastCall().body).toMatchObject({
      prompt: "def add(a, b):\n    return ",
      suffix: "\n",
      max_tokens: 16,
    });
    const out = await res.json();
    expect(out.content).toBe("a + b");
  });

  it("chat-only models keep the chat wrapper", async () => {
    executeMock.mockImplementation(async () =>
      reply(
        json({
          id: "chatcmpl-1",
          object: "chat.completion",
          model: "mistral-large-latest",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "return a + b" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 40, completion_tokens: 6 },
        }),
      ),
    );
    await postTo("/v1/completions", {
      model: "mistral/mistral-large-latest",
      prompt: "def add(a, b):\n    ",
      suffix: "\n",
    });
    const call = lastCall();
    expect(call.body.messages).toBeDefined();
    expect(urlOf(call, "mistral")).toBe("https://api.mistral.ai/v1/chat/completions");
  });
});
