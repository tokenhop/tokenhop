// YAN-1211/1213 end-to-end: conversation cache affinity through handleChat.
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
    saveRequestUsageUnscoped: vi.fn(async () => {}),
  };
});

const db = await import("@/lib/localDb.js");
const { handleChat } = await import("../../src/sse/handlers/chat.js");
const { resetComboRotation } = await import("../../open-sse/services/combo.js");
const { resetAccountSelection } = await import("../../src/sse/services/auth.js");
const { comboPins, accountPins, comboPinKey } = await import(
  "../../open-sse/services/cacheAffinity.js"
);

const okResponse = () =>
  new Response(
    JSON.stringify({
      id: "c1",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const failResponse = () =>
  new Response(JSON.stringify({ error: { message: "boom" } }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });

const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Which upstream model / api key served each executor call, in order.
const servedModels = () => executeMock.mock.calls.map(([a]) => a.body?.model);
const servedKeys = () => executeMock.mock.calls.map(([a]) => a.credentials?.apiKey);

const post = (model, session, options = null) =>
  handleChat(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(session ? { "x-session-id": session } : {}),
      },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
    null,
    options,
  );

async function turn(model, session) {
  const res = await post(model, session);
  await res.text();
  return res;
}

async function resetConnections() {
  await db.deleteProviderConnectionsByProviderUnscoped("openai");
}

describe("conversation cache affinity end-to-end", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    executeMock.mockReset();
    executeMock.mockImplementation(async () => ({
      response: okResponse(),
      url: "https://fake.local/v1/chat/completions",
      headers: {},
      transformedBody: null,
    }));
    resetComboRotation();
    resetAccountSelection();
    comboPins.clear();
    accountPins.clear();
    await resetConnections();
    await db.updateSettings({
      requireApiKey: false,
      fallbackStrategy: "fill-first",
      providerStrategies: {},
      comboStrategies: {},
      comboStickyRoundRobinLimit: 1,
    });
    await db.createProviderConnectionUnscoped({
      provider: "openai",
      name: "aff-main",
      apiKey: "sk-aff-main",
      isActive: true,
    });
  });

  async function makeRoundRobinCombo(extra = {}) {
    const stamp = unique();
    const combo = `aff-${stamp}`;
    const a = `openai/a-${stamp}`;
    const b = `openai/b-${stamp}`;
    await db.createComboUnscoped({ name: combo, models: [a, b] });
    await db.updateSettings({
      comboStrategies: { [combo]: { fallbackStrategy: "round-robin", ...extra } },
    });
    return { combo, a, b };
  }

  it("keeps a session on one combo model; another session gets the other", async () => {
    const { combo, a, b } = await makeRoundRobinCombo();
    const strip = (m) => m.slice("openai/".length);

    for (let i = 0; i < 4; i++) expect((await turn(combo, "s1")).status).toBe(200);
    const s1 = servedModels();
    expect(s1).toHaveLength(4);
    expect(new Set(s1).size).toBe(1);

    executeMock.mockClear();
    await turn(combo, "s2");
    await turn(combo, "s2");
    const s2 = servedModels();
    expect(new Set(s2).size).toBe(1);
    expect(s2[0]).not.toBe(s1[0]);
    expect([strip(a), strip(b)]).toContain(s2[0]);
  });

  it("re-pins to the fallback member when the pinned model fails", async () => {
    const { combo, a, b } = await makeRoundRobinCombo();
    const strip = (m) => m.slice("openai/".length);

    await turn(combo, "s1");
    await turn(combo, "s1");
    const first = servedModels()[0];
    const other = first === strip(a) ? strip(b) : strip(a);
    executeMock.mockClear();

    // Turn 3: the pinned model fails once, the other member serves.
    executeMock.mockImplementation(async (args) => ({
      response: args.body?.model === first ? failResponse() : okResponse(),
      url: "https://fake.local/v1/chat/completions",
      headers: {},
      transformedBody: null,
    }));
    const res3 = await turn(combo, "s1");
    expect(res3.status).toBe(200);
    expect(servedModels()).toEqual([first, other]);

    // Turn 4: both healthy again, the conversation stays on the replacement.
    executeMock.mockClear();
    executeMock.mockImplementation(async () => ({
      response: okResponse(),
      url: "https://fake.local/v1/chat/completions",
      headers: {},
      transformedBody: null,
    }));
    await turn(combo, "s1");
    expect(servedModels()[0]).toBe(other);
  });

  it("nested combo: a conversation stays on the same inner model across turns", async () => {
    const stamp = unique();
    const inner = `aff-in-${stamp}`;
    const outer = `aff-out-${stamp}`;
    await db.createComboUnscoped({
      name: inner,
      models: [`openai/ia-${stamp}`, `openai/ib-${stamp}`],
    });
    await db.createComboUnscoped({ name: outer, models: [inner, `openai/o-${stamp}`] });
    await db.updateSettings({
      comboStrategies: {
        [inner]: { fallbackStrategy: "round-robin" },
        [outer]: { fallbackStrategy: "round-robin" },
      },
    });
    for (let i = 0; i < 4; i++) expect((await turn(outer, "s1")).status).toBe(200);
    const served = servedModels();
    expect(served).toHaveLength(4);
    expect(new Set(served).size).toBe(1);
  });

  it("cacheAffinity:false keeps today's per-turn rotation", async () => {
    const { combo } = await makeRoundRobinCombo({ cacheAffinity: false });
    for (let i = 0; i < 4; i++) await turn(combo, "s1");
    const models = servedModels();
    expect(models).toHaveLength(4);
    expect(models[0]).not.toBe(models[1]);
    expect(models[0]).toBe(models[2]);
    expect(models[1]).toBe(models[3]);
    expect(comboPins.size).toBe(0);
  });

  it("pins a direct-model conversation to one account (and not another)", async () => {
    await resetConnections();
    await db.createProviderConnectionUnscoped({
      provider: "openai",
      name: "aff-1",
      apiKey: "sk-aff-1",
      isActive: true,
    });
    await db.createProviderConnectionUnscoped({
      provider: "openai",
      name: "aff-2",
      apiKey: "sk-aff-2",
      isActive: true,
    });
    await db.updateSettings({
      fallbackStrategy: "round-robin",
      stickyRoundRobinLimit: 1,
      providerStrategies: {},
    });
    const model = `openai/solo-${unique()}`;

    for (let i = 0; i < 3; i++) expect((await turn(model, "s1")).status).toBe(200);
    const s1 = servedKeys();
    expect(new Set(s1).size).toBe(1);

    executeMock.mockClear();
    await turn(model, "s2");
    const s2 = servedKeys();
    expect(s2).toHaveLength(1);
    expect(s2[0]).not.toBe(s1[0]);
    expect(["sk-aff-1", "sk-aff-2"]).toContain(s2[0]);
  });

  it("probe path (onAttempt) neither reads nor writes pins", async () => {
    const { combo } = await makeRoundRobinCombo();
    const onAttempt = vi.fn();
    const before = comboPins.size;
    const accountsBefore = accountPins.size;

    const res = await post(combo, "s1", { skipApiKeyCheck: true, onAttempt });
    await res.text();
    expect(res.status).toBe(200);
    expect(comboPins.size).toBe(before);
    expect(accountPins.size).toBe(accountsBefore);
  });

  it("ignores a caller-supplied options.conversationKey", async () => {
    const { combo } = await makeRoundRobinCombo();
    const res = await post(combo, null, {
      skipApiKeyCheck: true,
      conversationKey: "p:forged",
    });
    await res.text();
    expect(res.status).toBe(200);
    // The real key is derived from the body (first user message), never the forged value.
    expect(comboPins.size).toBe(1);
    expect(comboPins.get(comboPinKey(null, combo, "p:forged"))).toBeUndefined();
  });

  describe("fusion panel account pins (YAN-1673)", () => {
    // Two openai accounts, round robin; a fusion panel of two models on openai.
    async function makeFusion() {
      await resetConnections();
      for (const n of ["1", "2"]) {
        await db.createProviderConnectionUnscoped({
          provider: "openai",
          name: `aff-${n}`,
          apiKey: `sk-aff-${n}`,
          isActive: true,
        });
      }
      const stamp = unique();
      const combo = `fus-${stamp}`;
      const judge = `j-${stamp}`;
      await db.createComboUnscoped({
        name: combo,
        models: [`openai/a-${stamp}`, `openai/b-${stamp}`],
      });
      await db.updateSettings({
        fallbackStrategy: "round-robin",
        stickyRoundRobinLimit: 1,
        providerStrategies: {},
        comboStrategies: {
          [combo]: {
            fallbackStrategy: "fusion",
            judgeModel: `openai/${judge}`,
            fusionTuning: { stragglerGraceMs: 50 },
          },
        },
      });
      return { combo, judge };
    }
    // Panels run non-streaming; streamed calls (if any) get a one-token SSE answer.
    const sse = () =>
      new Response(
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    const respond = (judge, judgeFor) =>
      executeMock.mockImplementation(async (args) => ({
        response: args.body?.model === judge ? judgeFor() : args.stream ? sse() : okResponse(),
        url: "https://fake.local/v1/chat/completions",
        headers: {},
        transformedBody: null,
      }));

    it("a failed judge leaves no account pin from the panel", async () => {
      const { combo, judge } = await makeFusion();
      respond(
        judge,
        () =>
          new Response(JSON.stringify({ error: { message: "bad request" } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
      );
      const res = await turn(combo, "s1");
      expect(res.status).toBe(400);
      expect(accountPins.size).toBe(0);
    });

    it("a served fusion pins the account that served it", async () => {
      const { combo, judge } = await makeFusion();
      respond(judge, () => okResponse());
      const res = await turn(combo, "s1");
      expect(res.status).toBe(200);
      expect(accountPins.size).toBe(1);
    });
  });
});
