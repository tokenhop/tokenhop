// Nested combo and solo capacity-adapter fallback tests (merge gate fix).
// Real traffic: records fallback hops in global._fallbackHops at outer and inner levels.
// Probe traffic: records nested timeline steps ({ role: "nested", via: ... })
// and NEVER writes to global._fallbackHops or usage stats.
import { describe, expect, it, vi, beforeEach } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ execute: executeMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    trackPendingRequest: vi.fn(),
    appendRequestLog: vi.fn(async () => {}),
    saveRequestDetail: vi.fn(async () => {}),
  };
});

const db = await import("@/lib/localDb.js");
const { handleChat } = await import("../../src/sse/handlers/chat.js");
const { runComboProbe, resetProbeRateLimit } = await import("../../src/sse/services/comboProbe.js");

function okUpstream(content = "ok") {
  return {
    response: new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 8, completion_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    url: "https://fake.local/v1/chat/completions",
    headers: {},
    transformedBody: null,
  };
}

function errUpstream(status = 429, message = "Rate limit exceeded") {
  return {
    response: new Response(JSON.stringify({ error: { message } }), {
      status,
      headers: { "content-type": "application/json" },
    }),
    url: "https://fake.local/v1/chat/completions",
    headers: {},
    transformedBody: null,
  };
}

const v1Request = (body) =>
  new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("nested combo fallback and probe isolation", () => {
  let outerCombo;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetProbeRateLimit();
    global._fallbackHops = [];
    await db.updateSettings({ requireApiKey: false });
    await db.createProviderConnection({
      provider: "openai",
      name: "conn-a",
      apiKey: "sk-a",
      isActive: true,
    });
    // inner combo: tries inner-fail then inner-ok
    if (!(await db.getComboByName("inner-combo"))) {
      await db.createCombo({
        name: "inner-combo",
        models: ["openai/inner-fail", "openai/inner-ok"],
      });
    }
    // outer combo: tries inner-combo (nested) then outer-backup
    if (!(await db.getComboByName("outer-combo"))) {
      outerCombo = await db.createCombo({
        name: "outer-combo",
        models: ["inner-combo", "openai/outer-backup"],
      });
    } else {
      outerCombo = await db.getComboByName("outer-combo");
    }
  });

  it("real traffic: records nested fallback hop in global._fallbackHops", async () => {
    executeMock.mockImplementation(async (args) => {
      const model = args.body?.model || "";
      if (model.includes("inner-fail")) return errUpstream(429, "inner rate limited");
      return okUpstream("served by inner-ok");
    });

    const res = await handleChat(
      v1Request({ model: "outer-combo", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(res.status).toBe(200);

    // Inner combo fallback happened (inner-fail -> inner-ok), hop recorded with comboName="inner-combo".
    // Note: combo converts 429 with no provider Retry-After into 503 status at leaf;
    // the ring records the leaf's final response status, not the raw upstream code.
    const hops = global._fallbackHops.filter((h) => h.comboName === "inner-combo");
    expect(hops).toHaveLength(1);
    expect(hops[0]).toMatchObject({
      comboName: "inner-combo",
      model: "inner-fail",
      status: 503,
    });
  });

  it("probe: nested fallback timeline includes inner steps tagged via; NEVER writes fallback ring", async () => {
    executeMock.mockImplementation(async (args) => {
      const model = args.body?.model || "";
      if (model.includes("inner-fail")) return errUpstream(429, "inner rate limited");
      return okUpstream("served by inner-ok");
    });

    const probeResult = await runComboProbe({ comboId: outerCombo.id });
    expect(probeResult.served?.outcome).toBe("served");

    // Timeline captured both inner attempts.
    expect(probeResult.attempts.map((a) => a.model)).toContain("openai/inner-fail");
    expect(probeResult.attempts.map((a) => a.model)).toContain("openai/inner-ok");

    // The inner failure is tagged as nested via inner-combo.
    const innerAttempt = probeResult.attempts.find((a) => a.model === "openai/inner-fail");
    expect(innerAttempt).toBeDefined();
    expect(innerAttempt.outcome).toBe("skipped");
    expect(innerAttempt).toMatchObject({ role: "nested", via: "inner-combo" });

    // PROBE MUST NEVER WRITE TO THE LIVE-ROUTES FALLBACK RING:
    expect(global._fallbackHops).toHaveLength(0);
  });

  // Adapter prepends the pool before the target: [openai/gpt-4o, openai/gpt-3.5-turbo].
  // gpt-4o fails (429) so a real fallback hop occurs; gpt-3.5-turbo serves.
  const setupAdapter = async () => {
    await db.updateSettings({
      capacityAdapter: {
        vision: { enabled: true, roundRobin: false, models: ["openai/gpt-4o"] },
      },
    });
    executeMock.mockImplementation(async (args) => {
      const model = args.body?.model || "";
      if (model.includes("gpt-4o")) return errUpstream(429, "gpt-4o 429");
      return okUpstream("turbo answered");
    });
  };
  const imageBody = {
    model: "openai/gpt-3.5-turbo",
    messages: [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,xxxx" } }],
      },
    ],
    stream: false,
  };

  it("solo capacity adapter: real traffic records the fallback hop", async () => {
    await setupAdapter();
    const res = await handleChat(v1Request(imageBody));
    expect(res.status).toBe(200);
    const hops = global._fallbackHops.filter((h) => h.comboName === "openai/gpt-3.5-turbo");
    expect(hops).toHaveLength(1);
    expect(hops[0].model).toBe("gpt-4o");
  });

  it("solo capacity adapter: probe observes both steps and never writes fallback hops", async () => {
    await setupAdapter();
    const probeAttempts = [];
    const res = await handleChat(
      {
        url: "http://localhost/api/combos/probe",
        headers: {
          get: (n) => (String(n).toLowerCase() === "user-agent" ? "9router-combo-probe/1.0" : null),
          entries: () => [][Symbol.iterator](),
        },
        json: async () => ({ ...imageBody }),
      },
      null,
      { onAttempt: (a) => probeAttempts.push(a), skipApiKeyCheck: true },
    );
    expect(res.status).toBe(200);
    expect(probeAttempts.map((a) => [a.model, a.outcome])).toEqual([
      ["openai/gpt-4o", "skipped"],
      ["openai/gpt-3.5-turbo", "served"],
    ]);
    expect(global._fallbackHops).toHaveLength(0);
  });
});
