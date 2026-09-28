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
const window = (usedFraction) => ({ windows: [{ kind: "5h", usedFraction }] });

describe("buildShellSummary", () => {
  it("counts providers, attention, LLM combos, low quota and the translator gate", () => {
    const summary = buildShellSummary({
      connections,
      combos: [{ name: "x" }, { name: "y", kind: "llm" }, { name: "z", kind: "image" }],
      translatorEnabled: true,
      gateway,
      getSnapshotView: (id) => ({ a: window(0.85), b: window(0.5), d: window(1) })[id] ?? null,
    });
    expect(summary).toEqual({
      gateway,
      providers: { connected: 3, attention: { count: 2, status: "err" } },
      combos: 2,
      // d is ≤ 20% but disabled; c has no snapshot.
      lowQuota: 1,
      enableTranslator: true,
    });
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
  };

  it("maps a 2xx body onto shell state", () => {
    const next = applyShellSummary(prev, 200, {
      gateway,
      providers: { connected: 3, attention: { count: 0, status: null } },
      combos: 5,
      lowQuota: 0,
      enableTranslator: false,
    });
    expect(next).toEqual({
      loading: false,
      gatewayOnline: true,
      startedAt: gateway.startedAt,
      serverPort: 20128,
      badges: { providers: 3, combos: 5, quota: 0 },
      providerAttention: { count: 0, status: null },
      enableTranslator: false,
    });
  });

  it("marks offline on network failure or 5xx and keeps the last badges", () => {
    for (const status of [null, 503]) {
      const next = applyShellSummary(prev, status, null);
      expect(next).toMatchObject({ gatewayOnline: false, badges: prev.badges });
      expect(next.enableTranslator).toBe(true);
    }
  });

  it("stays online on a 4xx without inventing counts", () => {
    expect(applyShellSummary(prev, 401, null)).toMatchObject({
      gatewayOnline: true,
      badges: prev.badges,
    });
  });
});
