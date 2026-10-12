// YAN-763 end-to-end: fastest combo with hedgeDelayMs through handleChat.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { executeMock, saveUsageSpy, releaseSpy, handles } = vi.hoisted(() => {
  process.env.FIM_ATTEMPT_TIMEOUT_MS = "200";
  return {
    executeMock: vi.fn(),
    saveUsageSpy: vi.fn(),
    releaseSpy: vi.fn(),
    // model -> fake grant reservation handle handed out by the auth wrapper
    handles: new Map(),
  };
});

// Real credential selection, plus a per-model reservation handle: stands in for
// a limited grant so the release plumbing is observable per connection.
vi.mock("../../src/sse/services/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getProviderCredentials: async (provider, exclude, model, opts) => {
      const creds = await actual.getProviderCredentials(provider, exclude, model, opts);
      if (!creds || creds.allRateLimited) return creds;
      const handle = {
        grantId: `grant-${model}`,
        connectionId: creds.connectionId,
        req: null,
        tok: null,
      };
      handles.set(model, handle);
      return { ...creds, grantReservation: handle };
    },
  };
});

vi.mock("../../src/sse/services/grantRateLimiter.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    releaseGrantReservation: (h) => {
      releaseSpy(h);
      return actual.releaseGrantReservation(h);
    },
  };
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
const { saveRequestDetailUnscoped } = await import("@/lib/usageDb.js");

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
          choices: [{ message: { role: "assistant", content: "a + b" } }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
});

const hang = ({ signal }) =>
  new Promise((_, reject) =>
    signal.addEventListener("abort", () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      reject(e);
    }),
  );

const post = (model) =>
  handleChat(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: "user", content: "x" }],
      }),
    }),
  );

describe("fastest hedging end-to-end (YAN-763)", () => {
  let seq = 0;
  beforeEach(async () => {
    vi.clearAllMocks();
    await db.updateSettings({ requireApiKey: false });
    seq += 1;
    await db.createProviderConnectionUnscoped({
      provider: "openai",
      name: `hedge-${seq}`,
      apiKey: `sk-hedge-${seq}`,
      isActive: true,
    });
  });

  it("non-stream loser abort: 499 localError, no cooldown, no latency sample", async () => {
    const combo = `hedge-ns-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await db.createComboUnscoped({ name: combo, models: ["openai/hang", "openai/good"] });
    await db.updateSettings({
      comboStrategies: { [combo]: { fallbackStrategy: "fastest", hedgeDelayMs: 30 } },
    });
    executeMock.mockImplementation((args) =>
      args.body?.model === "good" ? served(args) : hang(args),
    );
    const res = await handleChat(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: combo,
          stream: false,
          messages: [{ role: "user", content: "x" }],
        }),
      }),
    );
    expect(res.status).toBe(200);
    await res.text();
    await sleep(20);
    expect(executeMock.mock.calls[0][0].signal.aborted).toBe(true);
    const conns = await db.getProviderConnectionsUnscoped({ provider: "openai" });
    expect(conns.every((c) => c.testStatus !== "unavailable")).toBe(true);
    const { getFastestModels } = await import("../../open-sse/services/combo.js");
    // No loser sample: "hang" stays cold, so it still ranks first.
    expect(getFastestModels(["openai/hang", "openai/good"], combo, () => 0.5)[0]).toBe(
      "openai/hang",
    );
  });

  it("client abort after the winner keeps the winner's grant reservation (M4/L1)", async () => {
    const combo = `hedge-m4-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await db.createComboUnscoped({ name: combo, models: ["openai/hang", "openai/good"] });
    await db.updateSettings({
      comboStrategies: { [combo]: { fallbackStrategy: "fastest", hedgeDelayMs: 30 } },
    });
    executeMock.mockImplementation((args) =>
      args.body?.model === "good" ? served(args) : hang(args),
    );
    const ctrl = new AbortController();
    const res = await handleChat(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: combo,
          stream: false,
          messages: [{ role: "user", content: "x" }],
        }),
        signal: ctrl.signal,
      }),
    );
    expect(res.status).toBe(200);
    await res.text();
    await sleep(20);
    const afterRace = releaseSpy.mock.calls.length; // loser only
    ctrl.abort();
    await sleep(20);
    expect(releaseSpy.mock.calls.length).toBe(afterRace);
  });

  it("nested fusion under a hedged attempt logs an explicit downgrade (M3)", async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const inner = `hedge-fusion-${stamp}`;
    const outer = `hedge-outer-${stamp}`;
    await db.createComboUnscoped({ name: inner, models: ["openai/good", "openai/good"] });
    await db.createComboUnscoped({ name: outer, models: [inner, "openai/hang"] });
    await db.updateSettings({
      comboStrategies: {
        [outer]: { fallbackStrategy: "fastest", hedgeDelayMs: 30 },
        [inner]: { fallbackStrategy: "fusion" },
      },
    });
    executeMock.mockImplementation((args) =>
      args.body?.model === "good" ? served(args) : hang(args),
    );
    const warn = vi.spyOn(console, "warn");
    const info = vi.spyOn(console, "log");
    const res = await handleChat(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: outer,
          stream: false,
          messages: [{ role: "user", content: "x" }],
        }),
      }),
    );
    expect(res.status).toBe(200);
    await res.text();
    const logged = [...warn.mock.calls, ...info.mock.calls].flat().join("\n");
    warn.mockRestore();
    info.mockRestore();
    expect(logged).toMatch(/Nested fusion is sequential under an outermost hedge race/);
  });

  it("streamed loser abort releases exactly the loser's reservation (M4)", async () => {
    const combo = `hedge-stream-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await db.createComboUnscoped({ name: combo, models: ["openai/slow", "openai/good"] });
    await db.updateSettings({
      comboStrategies: { [combo]: { fallbackStrategy: "fastest", hedgeDelayMs: 30 } },
    });
    // Leader answers with SSE headers, then never sends a token: it reaches
    // handleStreamingResponse (so the stream-level hedge abort owns release).
    const silentStream = () => ({
      response: new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
      url: "https://fake.local/v1/chat/completions",
      headers: {},
      transformedBody: null,
    });
    executeMock.mockImplementation((args) =>
      args.body?.model === "good" ? served(args) : silentStream(),
    );
    handles.clear();
    releaseSpy.mockClear();

    const res = await post(combo);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("a + b");

    await vi.waitFor(() => expect(releaseSpy).toHaveBeenCalledTimes(1));
    // Settle: no late second release (winner keeps its reservation).
    await sleep(50);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    const released = releaseSpy.mock.calls[0][0];
    expect(released).toBe(handles.get("slow"));
    expect(released.grantId).toBe("grant-slow");
    expect(released).not.toBe(handles.get("good"));
    expect(executeMock.mock.calls[0][0].signal.aborted).toBe(true);
  });

  it("hedge wins, cancels loser, and keeps accounting honest", async () => {
    const combo = `hedge-combo-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await db.createComboUnscoped({ name: combo, models: ["openai/hang", "openai/good"] });
    await db.updateSettings({
      comboStrategy: "fallback",
      comboStrategies: { [combo]: { fallbackStrategy: "fastest", hedgeDelayMs: 30 } },
    });
    executeMock.mockImplementation((args) =>
      args.body?.model === "good" ? served(args) : hang(args),
    );

    const res = await post(combo);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("a + b");
    await vi.waitFor(() => expect(saveUsageSpy).toHaveBeenCalled());
    const calls = executeMock.mock.calls.map(([a]) => a.body?.model);
    expect(calls).toContain("good");
    expect(calls).toEqual(["hang", "good"]);
    expect(executeMock.mock.calls[0][0].signal.aborted).toBe(true);
    const connections = await db.getProviderConnectionsUnscoped({ provider: "openai" });
    expect(connections.every((c) => c.testStatus !== "unavailable")).toBe(true);
    // Only the served model reports observed usage; no fictional zero-cost
    // usage row from the cancelled leader.
    expect(saveUsageSpy.mock.calls.map(([entry]) => entry.model)).toEqual(["good"]);
    // The loser's request detail is a cancellation with unknown billed cost,
    // never an error row.
    const loserDetail = saveRequestDetailUnscoped.mock.calls
      .map(([d]) => d)
      .find((d) => d.model === "hang");
    expect(loserDetail.status).toBe("cancelled");
    expect(loserDetail.response.billedCost).toBe("unknown");
    expect(loserDetail.response.status).toBe(499);
  });
});
