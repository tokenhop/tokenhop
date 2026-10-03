import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionByIdUnscoped: vi.fn(),
  updateProviderConnectionUnscoped: vi.fn(),
  getUsageForProvider: vi.fn(),
  getProviderConnectionsUnscoped: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}), { virtual: true });
vi.mock("@/lib/db/index.js", () => ({
  getProviderConnectionsUnscoped: mocks.getProviderConnectionsUnscoped,
  getConnection: vi.fn(),
}));
// Single-user scope (YAN-361): the route loads the row unscoped.
vi.mock("@/lib/users/workspaceScope.js", () => ({
  loadScoped: async (_cap, id, _scoped, unscoped) => ({ scope: null, row: await unscoped(id) }),
  scopedConnections: async () => ({
    scope: null,
    connections: await mocks.getProviderConnectionsUnscoped(),
  }),
}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionByIdUnscoped: mocks.getProviderConnectionByIdUnscoped,
  updateProviderConnectionUnscoped: mocks.updateProviderConnectionUnscoped,
}));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: mocks.getUsageForProvider }));
vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: () => ({ needsRefresh: () => false }),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));
vi.mock("@/shared/services/weightedTargets", () => ({ isWeightedProvider: () => false }));
vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

const NOW = Date.UTC(2026, 8, 24, 18, 0, 0);
const HOUR = 3_600_000;
const MIN = 60_000;
const RESET_AT = new Date(NOW + 5 * HOUR).toISOString();
const usageFor = (remainingPct) => ({
  quotas: { "session (5h)": { remainingPercentage: remainingPct, resetAt: RESET_AT } },
});

const { clearQuotaSnapshots } = await import("open-sse/services/quotaSnapshot.js");
const sync = await import("@/sse/services/quotaSnapshotSync.js");
const forecastStore = await import("@/lib/quota/forecastStore.js");
const { deriveQuotaAccounts } = await import("@/lib/home/quota.js");
const { GET: usageGET } = await import("@/app/api/usage/[connectionId]/route.js");
const { GET: homeGET } = await import("@/app/api/home/quota/route.js");

const usageRequest = () =>
  usageGET(new Request("http://localhost/api/usage/a"), {
    params: Promise.resolve({ connectionId: "a" }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  clearQuotaSnapshots();
  forecastStore._resetQuotaForecastStore();
  sync._resetQuotaSnapshotSync();
  mocks.getProviderConnectionByIdUnscoped.mockResolvedValue({
    id: "a",
    provider: "claude",
    authType: "oauth",
    providerSpecificData: {},
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/usage/[connectionId] forecasts", () => {
  it("returns forecasts built from recorded probes across calls", async () => {
    // 100 → 70 over 30 min = 60%/h; reset 5h out → will-run-out (empty in ~1.2h).
    const remaining = [100, 90, 80, 70];
    for (let i = 0; i < remaining.length; i++) {
      vi.setSystemTime(NOW - (remaining.length - 1 - i) * 10 * MIN);
      mocks.getUsageForProvider.mockResolvedValueOnce(usageFor(remaining[i]));
      const body = await (await usageRequest()).json();
      expect(body.forecasts["session (5h)"]).toBeDefined();
    }
    expect(forecastStore.getQuotaForecasts("a", NOW)["session (5h)"]).toMatchObject({
      state: "will-run-out",
      reason: null,
      remainingPct: 70,
      sampleCount: 4,
      sampleSpanMs: 30 * MIN,
    });
    expect(forecastStore.getQuotaForecasts("a", NOW)["session (5h)"].burnPctPerHour).toBeCloseTo(
      60,
      0,
    );
    expect(typeof forecastStore.getQuotaForecasts("a", NOW)["session (5h)"].emptyAt).toBe("string");
  });

  it("returns an empty forecasts map without samples", async () => {
    mocks.getUsageForProvider.mockResolvedValueOnce({ quotas: {} });
    const body = await (await usageRequest()).json();
    expect(body.forecasts).toEqual({});
  });

  it("records no forecast samples for header source", async () => {
    await sync.recordUsageSnapshot({
      connectionId: "h",
      provider: "claude",
      usage: usageFor(50),
      source: "header",
    });
    expect(forecastStore.getQuotaForecasts("h", NOW)).toEqual({});
  });
});

describe("home quota forecast", () => {
  it("deriveQuotaAccounts attaches the urgent forecast per account", () => {
    const connections = [
      { id: "c1", provider: "claude", name: "Work" },
      { id: "c2", provider: "codex", name: "Main" },
    ];
    const views = {
      c1: { windows: [{ kind: "5h", usedFraction: 0.3, resetsAt: NOW + 5 * HOUR }] },
      c2: { windows: [] },
    };
    // 6%/h burn, 91 left → empty in ~15h, reset 5h out → on-track.
    for (let i = 0; i < 4; i++) {
      forecastStore.recordQuotaSample(
        "c1",
        "session (5h)",
        { remaining: 94 - i, resetAt: NOW + 5 * HOUR },
        NOW - 30 * MIN + i * 10 * MIN,
      );
    }

    const accounts = deriveQuotaAccounts(
      connections,
      (id) => views[id] ?? null,
      (id) => forecastStore.getQuotaForecasts(id, NOW),
    );
    expect(accounts[0].forecast).toMatchObject({ window: "session (5h)" });
    expect(accounts[0].forecast.state).not.toBe("unknown");
    expect(accounts[1]).toMatchObject({ forecast: null });

    // Without a forecast lookup (legacy callers): forecast stays null.
    const legacy = deriveQuotaAccounts(connections, (id) => views[id] ?? null);
    expect(legacy[0]).toMatchObject({ forecast: null });
  });

  it("GET /api/home/quota exposes accounts[].forecast from recorded samples", async () => {
    // 24%/h burn, 88 left → empty in ~3.7h, reset 5h out → will-run-out.
    for (let i = 0; i < 4; i++) {
      forecastStore.recordQuotaSample(
        "c1",
        "session (5h)",
        { remaining: 100 - i * 4, resetAt: NOW + 5 * HOUR },
        NOW - 30 * MIN + i * 10 * MIN,
      );
    }
    mocks.getProviderConnectionsUnscoped.mockResolvedValue([
      { id: "c1", provider: "claude", name: "Work", isActive: true },
      { id: "c2", provider: "codex", name: "Main", isActive: true },
    ]);

    const body = await (await homeGET()).json();
    const [c1, c2] = body.accounts;
    expect(c1.forecast).toMatchObject({ window: "session (5h)", state: "will-run-out" });
    expect(c2.forecast).toBeNull();
  });
});
