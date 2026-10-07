// YAN-736: edit-prediction defaults. Client disconnect cancels the attempt (499),
// a hung upstream times out per attempt (504, no account cooldown) so a combo
// advances, and usage rows are tagged "completions" with latency.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, saveUsageSpy } = vi.hoisted(() => {
  process.env.FIM_ATTEMPT_TIMEOUT_MS = "200";
  return { executeMock: vi.fn(), saveUsageSpy: vi.fn() };
});

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
    saveRequestUsageUnscoped: async (entry) => {
      saveUsageSpy(entry);
      return actual.saveRequestUsageUnscoped(entry);
    },
  };
});

const db = await import("@/lib/localDb.js");
const { handleChat } = await import("../../src/sse/handlers/chat.js");

let seq = 0;
let conn;

const usage = { prompt_tokens: 20, completion_tokens: 3 };
const served = ({ stream }) => ({
  response: stream
    ? new Response(
        [
          `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "good", choices: [{ index: 0, delta: { role: "assistant", content: "a + b" }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "good", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )
    : new Response(
        JSON.stringify({
          id: "c1",
          object: "chat.completion",
          model: "good",
          choices: [
            { index: 0, message: { role: "assistant", content: "a + b" }, finish_reason: "stop" },
          ],
          usage,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  url: "https://fake.local/v1/chat/completions",
  headers: {},
  transformedBody: null,
});

// Hangs until the attempt signal aborts (a well-behaved executor).
const hang = ({ signal }) =>
  new Promise((_, reject) =>
    signal.addEventListener("abort", () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      reject(e);
    }),
  );

const post = (model, signal) =>
  handleChat(
    new Request("http://localhost/v1/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: "def add(a, b):\n    return ", suffix: "\n" }),
      signal,
    }),
  );

describe("edit prediction attempt defaults (YAN-736)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await db.updateSettings({ requireApiKey: false });
    seq += 1;
    conn = await db.createProviderConnectionUnscoped({
      provider: "openai",
      name: `fim-${seq}`,
      apiKey: `sk-fim-${seq}`,
      isActive: true,
    });
  });

  it("a client that already disconnected gets 499 and no upstream call", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    executeMock.mockImplementation(served);
    const res = await post("openai/good", ctrl.signal);
    expect(res.status).toBe(499);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("a hung upstream times out with 504, once, without cooling the account down", async () => {
    executeMock.mockImplementation(hang);
    const t0 = Date.now();
    const res = await post("openai/hang");
    expect(res.status).toBe(504);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(executeMock).toHaveBeenCalledTimes(1);
    const stored = await db.getProviderConnectionByIdUnscoped(conn.id);
    expect(stored.testStatus).not.toBe("unavailable");
  });

  it("a combo advances past a hung member; usage is tagged completions with latency", async () => {
    const combo = `fim-combo-${seq}`;
    await db.createComboUnscoped({ name: combo, models: ["openai/hang", "openai/good"] });
    executeMock.mockImplementation((args) =>
      args.body?.model === "good" ? served(args) : hang(args),
    );

    const res = await post(combo);
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].text).toBe("a + b");
    expect(executeMock.mock.calls.map(([a]) => a.body?.model)).toEqual(["hang", "good"]);

    await vi.waitFor(() => expect(saveUsageSpy).toHaveBeenCalled());
    const entry = saveUsageSpy.mock.calls.at(-1)[0];
    expect(entry.endpoint).toBe("completions");
    expect(entry.meta.latencyMs).toBeGreaterThanOrEqual(0);
    expect(entry.meta.empty).toBeUndefined();
  });
});
