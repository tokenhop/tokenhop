// YAN-729: editor edit predictions end-to-end through a combo on /v1/completions.
// Zed (open_ai_compatible_api, non-stream, qwen FIM tokens in `prompt`) and
// minuet-ai (openai_fim_compatible, prompt + suffix, stream) hit a combo whose
// first member rejects the request; the second serves. Only the executor is
// mocked: real DB, routing, combo fallback, translators and usage writes.
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
const { CAVEMAN_PROMPTS } = await import("../../open-sse/rtk/cavemanPrompts.js");
const { PONYTAIL_PROMPTS } = await import("../../open-sse/rtk/ponytailPrompt.js");

let COMBO;
let seq = 0;
const ANSWER = "return a + b";

const upstream = (response) => ({
  response,
  url: "https://fake.local/v1/chat/completions",
  headers: {},
  transformedBody: null,
});

const modelMissing = (model) =>
  upstream(
    new Response(JSON.stringify({ error: { message: `The model \`${model}\` does not exist` } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    }),
  );

function served({ stream, usage = { prompt_tokens: 40, completion_tokens: 6 } }) {
  if (!stream) {
    return upstream(
      new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          model: "good",
          choices: [
            // Chat models repeat the indentation the cursor already sits in (YAN-741).
            {
              index: 0,
              message: { role: "assistant", content: `    ${ANSWER}` },
              finish_reason: "stop",
            },
          ],
          ...(usage ? { usage } : {}),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }
  const chunk = (delta, finish_reason = null, extra = {}) =>
    `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", model: "good", choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`;
  const sse = [
    chunk({ role: "assistant", content: "" }),
    chunk({ content: "    return " }),
    chunk({ content: "a + b" }),
    chunk({}, "stop", { usage }),
    "data: [DONE]\n\n",
  ].join("");
  return upstream(
    new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
  );
}

const post = (body) =>
  handleChat(
    new Request("http://localhost/v1/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

// Zed `prompt_format: qwen` request: FIM tokens baked into prompt, no suffix, no stream.
const zedBody = () => ({
  model: COMBO,
  prompt: "<|fim_prefix|>def add(a, b):\n    <|fim_suffix|>\n\nprint(add(1, 2))<|fim_middle|>",
  max_tokens: 64,
  stop: ["<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>", "<|endoftext|>", "\n\n"],
});

const modelsTried = () => executeMock.mock.calls.map(([args]) => args.body?.model);

describe("edit predictions via combo on /v1/completions (YAN-729)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    global._fallbackHops = [];
    await db.updateSettings({ requireApiKey: false });
    // Fresh connection + combo per case: a failed member leaves a cooldown lock.
    seq += 1;
    COMBO = `predict-${seq}`;
    await db.createProviderConnectionUnscoped({
      provider: "openai",
      name: `conn-${seq}`,
      apiKey: `sk-test-${seq}`,
      isActive: true,
    });
    await db.createComboUnscoped({ name: COMBO, models: ["openai/chat-only", "openai/good"] });
    executeMock.mockImplementation(async (args) =>
      args.body?.model === "good"
        ? served({ stream: args.stream })
        : modelMissing(args.body?.model),
    );
  });

  it("Zed: falls back to the next member and returns a text_completion with usage", async () => {
    const before = (await getUsageHistory(null, { provider: "openai" })).length;
    const res = await post(zedBody());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const json = await res.json();
    expect(json.object).toBe("text_completion");
    expect(json.choices[0].text).toBe(ANSWER);
    // Upstream omits total_tokens; Zed needs all three counts.
    expect(json.usage).toMatchObject({ prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 });

    expect(modelsTried()).toEqual(["chat-only", "good"]);
    const goodCall = executeMock.mock.calls.find(([a]) => a.body?.model === "good")[0];
    expect(JSON.stringify(goodCall.body.messages)).toContain("<|cursor|>");

    await vi.waitFor(async () => {
      const rows = await getUsageHistory(null, { provider: "openai" });
      expect(rows.length).toBe(before + 1);
    });
    const rows = await getUsageHistory(null, { provider: "openai" });
    const row = rows.find((r) => r.model === "good" && r.endpoint === "/v1/completions");
    expect(row).toBeDefined();
    expect(row.comboName).toBe(COMBO);
  });

  it("skips caveman/ponytail style prompts on predictions (YAN-741)", async () => {
    await db.updateSettings({ cavemanEnabled: true, ponytailEnabled: true });
    try {
      await post(zedBody());
      const goodCall = executeMock.mock.calls.find(([a]) => a.body?.model === "good")[0];
      const sent = JSON.stringify(goodCall.body);
      for (const prompt of [CAVEMAN_PROMPTS.full, PONYTAIL_PROMPTS.full]) {
        expect(sent).not.toContain(JSON.stringify(prompt).slice(1, 60));
      }
    } finally {
      await db.updateSettings({ cavemanEnabled: false, ponytailEnabled: false });
    }
  });

  it("Zed: usage is always present, even when the upstream sends none", async () => {
    executeMock.mockImplementation(async (args) =>
      args.body?.model === "good"
        ? served({ stream: args.stream, usage: null })
        : modelMissing(args.body?.model),
    );
    const json = await (await post(zedBody())).json();
    expect(json.choices[0].text).toBe(ANSWER);
    expect(json.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  it("minuet-ai: prompt + suffix streamed through the combo, parsed the way minuet parses SSE", async () => {
    const res = await post({
      model: COMBO,
      prompt: "def add(a, b):\n    ",
      suffix: "\n\nprint(add(1, 2))",
      max_tokens: 32,
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const lines = (await res.text())
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.replace(/^data:\s?/, ""));
    expect(lines.at(-1)).toBe("[DONE]");
    // minuet: JSON-decode each data line, skip undecodable ones, concat choices[1].text.
    const text = lines
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      })
      .map((j) => j.choices?.[0]?.text ?? "")
      .join("");
    expect(text).toBe(ANSWER);
    expect(modelsTried()).toEqual(["chat-only", "good"]);
  });

  it("minuet-ai: prompt + suffix with stream off returns one JSON text_completion", async () => {
    const res = await post({
      model: COMBO,
      prompt: "def add(a, b):\n    ",
      suffix: "\n\nprint(add(1, 2))",
      max_tokens: 32,
      stream: false,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const json = await res.json();
    expect(json.object).toBe("text_completion");
    expect(json.choices[0].text).toBe(ANSWER);
    expect(modelsTried()).toEqual(["chat-only", "good"]);
  });

  it("errors are JSON when every member fails", async () => {
    executeMock.mockImplementation(async (args) => modelMissing(args.body?.model));
    const failed = await post(zedBody());
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(failed.headers.get("content-type")).toContain("application/json");
    expect((await failed.json()).error.message).toEqual(expect.any(String));
  });

  it("an invalid prompt is a JSON 400, not a fallback", async () => {
    const invalid = await post({ ...zedBody(), prompt: 42 });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("content-type")).toContain("application/json");
    expect((await invalid.json()).error.message).toEqual(expect.any(String));
  });
});
