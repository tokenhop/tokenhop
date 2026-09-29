import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(),
  getSettings: vi.fn(),
  snapshots: {},
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => ({ status: init?.status || 200, body, init }) },
}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getCombos: mocks.getCombos,
  getSettings: mocks.getSettings,
}));
vi.mock("@/sse/services/quotaSnapshotSync.js", () => ({
  buildQuotaSnapshotView: (id) => mocks.snapshots[id] ?? null,
}));

const { buildShellSummary, countLowQuota } = await import("@/lib/shellSummary");
const { applyShellSummary } = await import("@/shared/hooks/useShellStatus.js");
const { GET } = await import("../../src/app/api/shell/summary/route.js");

const gateway = { ok: true, uptimeSeconds: 5, startedAt: "2026-01-01T00:00:00.000Z", port: 20128 };
const connections = [
  { id: "a", provider: "openai", testStatus: "active" },
  { id: "b", provider: "codex", testStatus: "error" },
  { id: "c", provider: "gemini", testStatus: "mystery" },
  { id: "d", provider: "off", testStatus: "active", isActive: false },
];
const snapshotWindow = (usedFraction) => ({ windows: [{ kind: "5h", usedFraction }] });

describe("buildShellSummary", () => {
  it("counts providers, attention, LLM combos, low quota and the translator gate", () => {
    const summary = buildShellSummary({
      connections,
      combos: [{ name: "x" }, { name: "y", kind: "llm" }, { name: "z", kind: "image" }],
      translatorEnabled: true,
      gateway,
      getSnapshotView: (id) =>
        ({ a: snapshotWindow(0.85), b: snapshotWindow(0.5), d: snapshotWindow(1) })[id] ?? null,
    });
    expect(summary).toEqual({
      gateway,
      providers: { connected: 3, attention: { count: 2, status: "err" } },
      combos: 2,
      // d is ≤ 20% but disabled; c has no snapshot.
      lowQuota: 1,
      enableTranslator: true,
      // No traffic input: heartbeat absent, not a fake flat line.
      traffic: null,
      savings: null,
    });
  });

  it("shapes the heartbeat traffic and pending milestone additively", () => {
    const summary = buildShellSummary({
      connections,
      combos: [],
      translatorEnabled: false,
      gateway,
      getSnapshotView: () => null,
      traffic: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2],
      savingsMilestone: 1_000_000,
    });
    expect(summary.traffic).toEqual({
      series: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2],
      total: 3,
    });
    expect(summary.savings).toEqual({ pendingMilestone: 1_000_000 });
  });

  it("rejects non-integer heartbeat values without inventing counts", () => {
    const withAbsent = buildShellSummary({
      connections,
      combos: [],
      translatorEnabled: false,
      gateway,
      getSnapshotView: () => null,
      traffic: [1, null, Number.NaN, -2, undefined],
      savingsMilestone: 0,
    });
    expect(withAbsent.traffic).toEqual({ series: [1, 0, 0, 0, 0], total: 1 });
    expect(withAbsent.savings).toEqual({ pendingMilestone: null });
  });

  it("treats the threshold as inclusive and ignores unknown quota", () => {
    expect(countLowQuota([{ remaining: 20 }, { remaining: 21 }, { remaining: null }])).toBe(1);
  });
});

describe("GET /api/shell/summary", () => {
  it("returns the summary with no-store and hides connection data", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "a", provider: "openai", testStatus: "active", apiKey: "sk-secret" },
    ]);
    mocks.getCombos.mockResolvedValue([{ name: "c1" }]);
    mocks.getSettings.mockResolvedValue({ translatorEnabled: false });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.init.headers["Cache-Control"]).toBe("no-store");
    expect(res.body).toMatchObject({ combos: 1, lowQuota: 0, enableTranslator: false });
    expect(JSON.stringify(res.body)).not.toContain("sk-secret");
    // Heartbeat and milestone ride the same response (empty isolated DB).
    expect(res.body.traffic).toEqual({ series: Array(15).fill(0), total: 0 });
    expect(res.body.savings).toEqual({ pendingMilestone: null });
  });

  it("returns a typed 500 when the store fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getCombos.mockRejectedValue(new Error("db down"));
    const res = await GET();
    expect(res).toMatchObject({ status: 500, body: { error: "Failed to load shell summary" } });
  });
});

describe("applyShellSummary", () => {
  const prev = {
    loading: true,
    gatewayOnline: true,
    startedAt: "s",
    serverPort: 1,
    badges: { providers: 4, combos: 2, quota: 1 },
    providerAttention: { count: 1, status: "warn" },
    enableTranslator: true,
    traffic: { series: [0, 1], total: 1 },
    savingsMilestone: 100_000,
  };

  it("maps a 2xx body onto shell state", () => {
    const next = applyShellSummary(prev, 200, {
      gateway,
      providers: { connected: 3, attention: { count: 0, status: null } },
      combos: 5,
      lowQuota: 0,
      enableTranslator: false,
      traffic: { series: [0, 0, 2], total: 2 },
      savings: { pendingMilestone: null },
    });
    expect(next).toEqual({
      loading: false,
      gatewayOnline: true,
      startedAt: gateway.startedAt,
      serverPort: 20128,
      badges: { providers: 3, combos: 5, quota: 0 },
      providerAttention: { count: 0, status: null },
      enableTranslator: false,
      traffic: { series: [0, 0, 2], total: 2 },
      savingsMilestone: null,
    });
  });

  it("marks offline on network failure or 5xx and keeps the last badges and heartbeat", () => {
    for (const status of [null, 503]) {
      const next = applyShellSummary(prev, status, null);
      expect(next).toMatchObject({
        gatewayOnline: false,
        badges: prev.badges,
        traffic: prev.traffic,
        savingsMilestone: prev.savingsMilestone,
      });
      expect(next.enableTranslator).toBe(true);
    }
  });

  it("stays online on a 4xx without inventing counts", () => {
    expect(applyShellSummary(prev, 401, null)).toMatchObject({
      gatewayOnline: true,
      badges: prev.badges,
      traffic: prev.traffic,
    });
  });

  it("keeps the last heartbeat when the body omits or mangles it", () => {
    for (const traffic of [undefined, null, {}, { series: "nope", total: 3 }]) {
      const next = applyShellSummary(prev, 200, { gateway, traffic });
      expect(next.traffic).toEqual(prev.traffic);
    }
  });

  it("maps a pending milestone and clears it on a body that carries savings", () => {
    const crossed = applyShellSummary(prev, 200, {
      gateway,
      savings: { pendingMilestone: 1_000_000 },
    });
    expect(crossed.savingsMilestone).toBe(1_000_000);
    // Garbage milestone values keep the last state instead of reaching the toast.
    const garbage = applyShellSummary(prev, 200, { gateway, savings: { pendingMilestone: "1M" } });
    expect(garbage.savingsMilestone).toBe(prev.savingsMilestone);
  });
});

describe("useShellStatus refresh lifecycle", () => {
  it("coalesces refreshes, throttles focus and stops polling with the last listener", async () => {
    vi.resetModules();
    const cleanups = [];
    vi.doMock("react", () => ({
      useState: (init) => [init, () => {}],
      useEffect: (fn) => cleanups.push(fn()),
    }));
    const handlers = {};
    vi.stubGlobal("document", {
      hidden: false,
      addEventListener: (type, fn) => {
        handlers[type] = fn;
      },
      removeEventListener: (type) => delete handlers[type],
    });
    vi.stubGlobal("window", {
      location: { port: "" },
      setInterval: vi.fn(() => 7),
      clearInterval: vi.fn(),
    });
    const resolvers = [];
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolvers.push(() => resolve({ status: 200, ok: true, json: async () => ({}) }));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const flush = async () => {
      while (resolvers.length) resolvers.shift()();
      await new Promise((r) => setTimeout(r, 0));
    };
    try {
      const mod = await import("@/shared/hooks/useShellStatus.js");
      mod.default(); // first listener: initial fetch + poll + focus listener
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Two mutations during flight queue exactly one follow-up.
      mod.refreshShellStatus();
      mod.refreshShellStatus();
      handlers.visibilitychange(); // in flight: ignored
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(2);

      handlers.visibilitychange(); // within 15s of the last attempt: throttled
      expect(fetchMock).toHaveBeenCalledTimes(2);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + mod.FOCUS_THROTTLE_MS + 1);
      handlers.visibilitychange();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      await flush();

      for (const fn of cleanups) fn?.();
      expect(globalThis.window.clearInterval).toHaveBeenCalledWith(7);
      expect(handlers.visibilitychange).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.doUnmock("react");
    }
  });
});
