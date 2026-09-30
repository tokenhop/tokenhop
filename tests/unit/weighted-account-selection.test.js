import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearQuotaSnapshots, recordProbeWindows } from "open-sse/services/quotaSnapshot.js";
import { MODEL_LOCK_ALL } from "open-sse/services/accountFallback.js";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: mocks.updateProviderConnection,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { resolveWeightedStickyLimit, selectWeightedConnection } = await import(
  "@/sse/services/accountSelection.js"
);
const { getProviderCredentials, resetAccountSelection } = await import("@/sse/services/auth.js");

const NOW = Date.parse("2026-09-01T00:00:00.000Z");
const snapshots = {
  max20a: { planTier: "default_claude_max_20x", windows: [{ kind: "5h", usedFraction: 0.1 }] },
  max20b: { planTier: "default_claude_max_20x", windows: [{ kind: "5h", usedFraction: 0.8 }] },
  pro: { planTier: "pro", windows: [{ kind: "5h", usedFraction: 0 }] },
};
const snapshotFor = (id) => snapshots[id] ?? null;

function pick(connections, state, opts = {}) {
  return selectWeightedConnection({
    connections,
    provider: "claude",
    model: "claude-opus-4",
    stickyLimit: 1,
    state,
    getSnapshot: snapshotFor,
    now: NOW,
    ...opts,
  });
}

describe("selectWeightedConnection", () => {
  it("distributes 1000 sticky-1 picks 18:4:1 within ±2%", () => {
    const connections = [{ id: "max20a" }, { id: "max20b" }, { id: "pro" }];
    const counts = { max20a: 0, max20b: 0, pro: 0 };
    let state;
    for (let i = 0; i < 1000; i++) {
      const result = pick(connections, state);
      state = result.nextState;
      counts[result.connection.id]++;
    }
    expect(Math.abs(counts.max20a - (1000 * 18) / 23)).toBeLessThanOrEqual(20);
    expect(Math.abs(counts.max20b - (1000 * 4) / 23)).toBeLessThanOrEqual(20);
    expect(Math.abs(counts.pro - 1000 / 23)).toBeLessThanOrEqual(20);
  });

  it("skips floor crossing and manual zero while a positive candidate exists", () => {
    const connections = [
      { id: "low", providerSpecificData: { planTier: "pro" } },
      { id: "zero", providerSpecificData: { weight: 0 } },
      { id: "ok" },
    ];
    const getSnapshot = (id) =>
      id === "low" ? { windows: [{ kind: "7d", usedFraction: 0.96 }] } : null;
    for (let i = 0; i < 5; i++) {
      expect(pick(connections, undefined, { getSnapshot }).connection.id).toBe("ok");
    }
  });

  it("fails open to a sole manual-zero candidate", () => {
    const only = { id: "zero", providerSpecificData: { weight: 0 } };
    expect(pick([only]).connection).toBe(only);
  });

  it("uses equal weights when no quota or plan data exists", () => {
    const connections = [{ id: "a" }, { id: "b" }];
    const first = pick(connections, undefined, { getSnapshot: () => null });
    const second = pick(connections, first.nextState, { getSnapshot: () => null });
    expect([first.connection.id, second.connection.id].sort()).toEqual(["a", "b"]);
  });

  it("keeps most recent account inside its sticky window", () => {
    const current = { id: "pro", lastUsedAt: "2026-08-31T23:59:00.000Z", consecutiveUseCount: 2 };
    const connections = [{ id: "max20a", lastUsedAt: "2026-08-31T23:00:00.000Z" }, current];
    expect(pick(connections, undefined, { stickyLimit: 3 })).toMatchObject({
      connection: current,
      continued: true,
    });
    expect(pick(connections, undefined, { stickyLimit: 2 })).toMatchObject({
      connection: { id: "max20a" },
      continued: false,
    });
  });

  it("uses manual plan tier over snapshot tier only when marked manual", () => {
    const getSnapshot = (id) => ({ planTier: id === "auto" ? "pro" : "pro", windows: [] });
    const connections = [
      { id: "auto", providerSpecificData: { planTier: "default_claude_max_20x" } },
      {
        id: "manual",
        providerSpecificData: { planTier: "default_claude_max_20x", planTierManual: true },
      },
    ];
    const counts = { auto: 0, manual: 0 };
    let state;
    for (let i = 0; i < 21; i++) {
      const result = pick(connections, state, { getSnapshot });
      state = result.nextState;
      counts[result.connection.id]++;
    }
    expect(counts).toEqual({ auto: 1, manual: 20 });
  });

  it("defaults sticky 3 for OAuth subscriptions and 1 elsewhere, keeping explicit 1", () => {
    expect(resolveWeightedStickyLimit("claude", {}, { stickyRoundRobinLimit: 3 })).toBe(3);
    expect(resolveWeightedStickyLimit("openai", {}, { stickyRoundRobinLimit: 3 })).toBe(1);
    expect(resolveWeightedStickyLimit("claude", { stickyRoundRobinLimit: 1 }, {})).toBe(1);
  });
});

describe("getProviderCredentials account strategies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearQuotaSnapshots();
    resetAccountSelection();
  });

  it("weighted honors excludes, persists new window, and keeps pin precedence", async () => {
    recordProbeWindows("big", "claude", [{ kind: "5h", usedFraction: 0 }], {
      planTier: "default_claude_max_20x",
    });
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "weighted" });
    mocks.getProviderConnections.mockResolvedValue([{ id: "big" }, { id: "small" }]);

    await expect(getProviderCredentials("claude", "big")).resolves.toMatchObject({
      connectionId: "small",
    });
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("small", {
      lastUsedAt: expect.any(String),
      consecutiveUseCount: 1,
    });

    await expect(
      getProviderCredentials("claude", null, null, { preferredConnectionId: "small" }),
    ).resolves.toMatchObject({ connectionId: "small" });
    expect(mocks.updateProviderConnection).toHaveBeenCalledTimes(1);
  });

  it("weighted increments sticky count for current account", async () => {
    mocks.getSettings.mockResolvedValue({
      providerStrategies: { codex: { fallbackStrategy: "weighted" } },
    });
    mocks.getProviderConnections.mockResolvedValue([
      { id: "a", lastUsedAt: "2026-08-31T00:00:00.000Z", consecutiveUseCount: 1 },
      { id: "b" },
    ]);
    await expect(getProviderCredentials("codex")).resolves.toMatchObject({ connectionId: "a" });
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("a", {
      lastUsedAt: expect.any(String),
      consecutiveUseCount: 2,
    });
  });

  it("fill-first picks first available priority account without persistence", async () => {
    mocks.getSettings.mockResolvedValue({});
    mocks.getProviderConnections.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
    await expect(getProviderCredentials("openai", "p1")).resolves.toMatchObject({
      connectionId: "p2",
    });
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("round-robin keeps current until sticky limit, then least recently used", async () => {
    mocks.getSettings.mockResolvedValue({
      fallbackStrategy: "round-robin",
      stickyRoundRobinLimit: 2,
    });
    const old = { id: "old", lastUsedAt: "2026-08-30T00:00:00.000Z" };
    mocks.getProviderConnections.mockResolvedValue([
      old,
      { id: "cur", lastUsedAt: "2026-08-31T00:00:00.000Z", consecutiveUseCount: 1 },
    ]);
    await expect(getProviderCredentials("openai")).resolves.toMatchObject({ connectionId: "cur" });
    expect(mocks.updateProviderConnection).toHaveBeenLastCalledWith("cur", {
      lastUsedAt: expect.any(String),
      consecutiveUseCount: 2,
    });

    mocks.getProviderConnections.mockResolvedValue([
      old,
      { id: "cur", lastUsedAt: "2026-08-31T00:00:00.000Z", consecutiveUseCount: 2 },
    ]);
    await expect(getProviderCredentials("openai")).resolves.toMatchObject({ connectionId: "old" });
    expect(mocks.updateProviderConnection).toHaveBeenLastCalledWith("old", {
      lastUsedAt: expect.any(String),
      consecutiveUseCount: 1,
    });
  });
});

// YAN-384: known 0%-quota connections are never selected, under any strategy.
describe("getProviderCredentials quota-exhausted skip", () => {
  const reset = () => new Date(Date.now() + 600_000).toISOString();
  const exhaust = (id, provider = "claude", kind = "5h") =>
    recordProbeWindows(id, provider, [{ kind, usedFraction: 1, resetsAt: reset() }]);

  beforeEach(() => {
    vi.clearAllMocks();
    clearQuotaSnapshots();
    resetAccountSelection();
    mocks.getProviderConnections.mockResolvedValue([{ id: "dry" }, { id: "wet" }]);
  });

  it.each([[{}], [{ fallbackStrategy: "round-robin" }], [{ fallbackStrategy: "weighted" }]])(
    "skips exhausted account under %o",
    async (settings) => {
      mocks.getSettings.mockResolvedValue(settings);
      exhaust("dry");
      recordProbeWindows("wet", "claude", [{ kind: "5h", usedFraction: 0.97 }]);
      await expect(getProviderCredentials("claude")).resolves.toMatchObject({
        connectionId: "wet",
      });
    },
  );

  it("keeps unknown, other-model, and other-provider snapshots eligible", async () => {
    mocks.getSettings.mockResolvedValue({});
    exhaust("dry", "codex");
    await expect(getProviderCredentials("claude")).resolves.toMatchObject({ connectionId: "dry" });
    clearQuotaSnapshots();
    exhaust("dry", "claude", "model:opus");
    await expect(getProviderCredentials("claude", null, "sonnet")).resolves.toMatchObject({
      connectionId: "dry",
    });
    await expect(getProviderCredentials("claude", null, "opus")).resolves.toMatchObject({
      connectionId: "wet",
    });
  });

  it("honors an explicit pin even when that account is exhausted", async () => {
    mocks.getSettings.mockResolvedValue({});
    exhaust("dry");
    await expect(
      getProviderCredentials("claude", null, null, { preferredConnectionId: "dry" }),
    ).resolves.toMatchObject({ connectionId: "dry" });
  });

  it("returns allRateLimited without an account when every account is exhausted", async () => {
    mocks.getSettings.mockResolvedValue({});
    exhaust("dry");
    exhaust("wet");
    const result = await getProviderCredentials("claude");
    expect(result).toMatchObject({ allRateLimited: true, lastError: "Quota exhausted" });
    expect(result.connectionId).toBeUndefined();
    expect(Date.parse(result.retryAfter)).toBeGreaterThan(Date.now());
  });
});

// YAN-387: lastError/lastErrorCode come from the account that unblocks first.
describe("getProviderCredentials allRateLimited error owner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearQuotaSnapshots();
    resetAccountSelection();
  });

  it("reports lastError from the earliest-expiring lock, not the first connection", async () => {
    const soon = new Date(Date.now() + 30_000).toISOString();
    mocks.getSettings.mockResolvedValue({});
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "a",
        [MODEL_LOCK_ALL]: new Date(Date.now() + 120_000).toISOString(),
        lastError: "billing",
        errorCode: 402,
      },
      { id: "b", [MODEL_LOCK_ALL]: soon, lastError: "rate limited", errorCode: 429 },
    ]);
    await expect(getProviderCredentials("claude")).resolves.toMatchObject({
      allRateLimited: true,
      retryAfter: soon,
      lastError: "rate limited",
      lastErrorCode: 429,
    });
  });
});
