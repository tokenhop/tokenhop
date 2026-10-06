import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/index.js", () => ({}), { virtual: true });

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(),
  getProviderConnectionsUnscoped: vi.fn(),
  getProviderConnectionByIdUnscoped: vi.fn(),
  getCombos: vi.fn(),
  getModelAliases: vi.fn(async () => ({})),
  updateProviderConnectionUnscoped: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: vi.fn(),
}));

vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: vi.fn(),
}));

vi.mock("open-sse/services/usage/claude.js", () => ({
  fetchClaudePlanTier: vi.fn(),
}));

const NOW = new Date("2026-09-24T18:00:00.000Z");
const RESET_AT = "2026-09-25T18:00:00.000Z";

describe("quota snapshot sync", () => {
  let sync;
  let store;
  let db;
  let fetchClaudePlanTier;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    db = await import("@/lib/localDb");
    db.getProviderConnectionByIdUnscoped.mockReset();
    db.updateProviderConnectionUnscoped.mockReset();
    ({ fetchClaudePlanTier } = await import("open-sse/services/usage/claude.js"));
    fetchClaudePlanTier.mockReset();
    store = await import("open-sse/services/quotaSnapshot.js");
    sync = await import("../../src/sse/services/quotaSnapshotSync.js");
    store.clearQuotaSnapshots();
    sync._resetQuotaSnapshotSync();
  });

  afterEach(() => {
    store?.clearQuotaSnapshots();
    vi.useRealTimers();
  });

  it("maps Claude session, weekly, and model-scoped weekly quotas", async () => {
    await sync.recordUsageSnapshot({
      connectionId: "claude-1",
      provider: "claude",
      usage: {
        quotas: {
          "session (5h)": { used: 10, total: 100, resetAt: RESET_AT },
          "weekly (7d)": { used: 20, total: 100, resetAt: RESET_AT },
          "weekly opus (7d)": { used: 30, total: 100, resetAt: RESET_AT },
        },
      },
      source: "probe",
    });

    expect(store.getSnapshot("claude-1").windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "5h", usedFraction: 0.1 }),
        expect.objectContaining({ kind: "7d", usedFraction: 0.2 }),
        expect.objectContaining({ kind: "model:opus", usedFraction: 0.3 }),
      ]),
    );
  });

  it("uses a known Codex fallback tier without persisting it", async () => {
    await sync.recordUsageSnapshot({
      connectionId: "codex-fallback",
      provider: "codex",
      usage: { plan: "unknown", quotas: {} },
      fallbackTier: "pro",
    });

    expect(store.getSnapshot("codex-fallback")).toMatchObject({ planTier: "pro" });
    expect(db.getProviderConnectionByIdUnscoped).not.toHaveBeenCalled();
    expect(db.updateProviderConnectionUnscoped).not.toHaveBeenCalled();
  });

  it("classifies Codex windows by windowMinutes rather than slot name", async () => {
    await sync.recordUsageSnapshot({
      connectionId: "codex-1",
      provider: "codex",
      usage: {
        quotas: {
          session: { used: 25, total: 100, windowMinutes: 10080, resetAt: RESET_AT },
        },
      },
    });

    expect(store.getSnapshot("codex-1").windows).toEqual([
      expect.objectContaining({ kind: "7d", usedFraction: 0.25 }),
    ]);
  });

  it("skips unknown full Antigravity buckets", async () => {
    await sync.recordUsageSnapshot({
      connectionId: "antigravity-1",
      provider: "antigravity",
      usage: {
        quotas: {
          "gemini-3-pro": { remainingPercentage: 100, resetAt: RESET_AT },
          "gemini-3-flash": { remainingPercentage: 40, resetAt: RESET_AT },
        },
      },
    });

    expect(store.getSnapshot("antigravity-1").windows).toEqual([
      expect.objectContaining({ kind: "model:gemini-3-flash", usedFraction: 0.6 }),
    ]);
  });

  it("maps Kiro resource types to model windows and GitHub chat to month", async () => {
    await sync.recordUsageSnapshot({
      connectionId: "kiro-1",
      provider: "kiro",
      usage: {
        plan: "Kiro",
        quotas: { agentic_request: { used: 4, total: 10, resetAt: RESET_AT } },
      },
    });
    await sync.recordUsageSnapshot({
      connectionId: "github-1",
      provider: "github",
      usage: {
        quotas: { chat: { used: 2, total: 10, resetAt: RESET_AT } },
      },
    });

    expect(store.getSnapshot("kiro-1").windows[0]).toMatchObject({
      kind: "model:agentic_request",
      usedFraction: 0.4,
    });
    expect(store.getSnapshot("github-1").windows[0]).toMatchObject({
      kind: "month",
      usedFraction: 0.2,
    });
  });

  it("persists changed plan tier while preserving provider-specific data", async () => {
    db.getProviderConnectionByIdUnscoped.mockResolvedValue({
      id: "codex-tier",
      providerSpecificData: { workspaceId: "ws-1", planTier: "plus" },
    });

    await sync.recordUsageSnapshot({
      connectionId: "codex-tier",
      provider: "codex",
      usage: { plan: "Pro", quotas: {} },
    });

    expect(db.updateProviderConnectionUnscoped).toHaveBeenCalledWith("codex-tier", {
      // Repo merges this delta onto live siblings; sending the read snapshot
      // would overwrite concurrent credential refreshes (YAN-365).
      providerSpecificData: { planTier: "pro" },
    });
  });

  it("does not write the same plan tier again within one hour", async () => {
    db.getProviderConnectionByIdUnscoped.mockResolvedValue({
      id: "codex-tier",
      providerSpecificData: { keep: true, planTier: "plus" },
    });
    const input = {
      connectionId: "codex-tier",
      provider: "codex",
      usage: { plan: "Pro", quotas: {} },
    };

    await sync.recordUsageSnapshot(input);
    await sync.recordUsageSnapshot(input);

    expect(db.getProviderConnectionByIdUnscoped).toHaveBeenCalledTimes(1);
    expect(db.updateProviderConnectionUnscoped).toHaveBeenCalledTimes(1);
  });

  it("fails open when plan tier persistence fails", async () => {
    db.getProviderConnectionByIdUnscoped.mockResolvedValue({
      id: "codex-tier",
      providerSpecificData: {},
    });
    db.updateProviderConnectionUnscoped.mockRejectedValue(new Error("db unavailable"));

    await expect(
      sync.recordUsageSnapshot({
        connectionId: "codex-tier",
        provider: "codex",
        usage: { plan: "Pro", quotas: {} },
      }),
    ).resolves.toBeNull();
  });

  it("handles a Claude profile 403/null result without persisting a tier or throwing", async () => {
    fetchClaudePlanTier.mockResolvedValue(null);
    db.getProviderConnectionByIdUnscoped.mockResolvedValue({
      id: "claude-403",
      providerSpecificData: { workspaceId: "ws-1" },
    });

    await expect(
      sync.fetchAndPersistClaudePlanTier({
        id: "claude-403",
        accessToken: "setup-token",
        providerSpecificData: {},
      }),
    ).resolves.toBeNull();

    expect(fetchClaudePlanTier).toHaveBeenCalledWith("setup-token", null);
    expect(db.updateProviderConnectionUnscoped).toHaveBeenCalledWith(
      "claude-403",
      expect.objectContaining({
        providerSpecificData: expect.not.objectContaining({ planTier: expect.anything() }),
      }),
    );
  });

  it("maps new providers to account-wide windows and skips ambiguous rows", () => {
    const cases = [
      ["kimi", "5h", "5h"],
      ["kimi", "Weekly", "7d"],
      ["kimi", "Monthly", "month"],
      ["kimi", "7d", "7d"],
      ["kimi", "5h #2", "5h"],
      ["glm", "Session (5h)", "5h"],
      ["glm-cn", "Session (5h)", "5h"],
      ["glm", "Weekly (7d)", "7d"],
      ["opencode-go", "Weekly", "7d"],
      ["opencode-go", "Monthly", "month"],
      ["commandcode", "Session (5h)", "5h"],
      ["commandcode", "Weekly", "7d"],
      ["meta-code", "Session (5h)", "5h"],
      ["meta-code", "Weekly", "7d"],
      ["ollama", "Session (5h)", "5h"],
      ["ollama", "Weekly (7d)", "7d"],
      ["xiaomi-mimo", "Weekly", "7d"],
    ];
    for (const [provider, key, kind] of cases) {
      expect(sync.kindForName(provider, key, { remainingPercentage: 50 })).toBe(kind);
    }
    const skipped = [
      ["kimi", "Monthly (Code)"],
      ["kimi", "Ratelimit"],
      ["glm", "Tokens"],
      ["glm", "Session (3h)"],
      ["opencode-go", "Rolling"],
      ["commandcode", "Credits"],
      ["meta-code", "Credits"],
      ["ollama", "Weekly"],
      ["xiaomi-mimo", "Monthly"],
      ["minimax", "M-series (5h)"],
      ["minimax-cn", "M-series (7d)"],
      ["unknown-provider", "Weekly"],
    ];
    for (const [provider, key] of skipped) {
      expect(sync.kindForName(provider, key, { remainingPercentage: 0 })).toBeNull();
    }
  });

  it("records an exhausted Kimi 5h window as usedFraction 1", async () => {
    await sync.recordUsageSnapshot({
      connectionId: "kimi-1",
      provider: "kimi",
      usage: {
        quotas: {
          "5h": { used: 100, total: 100, remainingPercentage: 0, resetAt: RESET_AT },
        },
      },
      source: "probe",
    });

    expect(store.getSnapshot("kimi-1").windows).toEqual([
      expect.objectContaining({ kind: "5h", usedFraction: 1 }),
    ]);
  });

  it("builds ISO reset timestamps and effective-weight decomposition", () => {
    store.recordProbeWindows(
      "claude-view",
      "claude",
      [{ kind: "5h", usedFraction: 0.2, resetsAt: RESET_AT }],
      { planTier: "default_claude_max_5x" },
    );

    expect(sync.buildQuotaSnapshotView("claude-view")).toMatchObject({
      planTier: "default_claude_max_5x",
      windows: [
        {
          kind: "5h",
          usedFraction: 0.2,
          resetsAt: RESET_AT,
          source: "probe",
        },
      ],
      updatedAt: NOW.toISOString(),
      effectiveWeight: {
        weight: 4,
        base: 5,
        baseSource: "plan",
        headroom: 0.8,
        headroomSource: "probe",
        belowFloor: false,
      },
    });
    expect(sync.buildQuotaSnapshotView("missing")).toBeNull();
  });
});

describe("quota snapshot poller", () => {
  let poller;
  let store;
  let deps;
  let state;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    delete global.__quotaSnapshotPoller;

    const db = await import("@/lib/localDb");
    db.getSettings.mockReset().mockResolvedValue({});
    db.getCombos.mockReset().mockResolvedValue([]);
    db.getProviderConnectionsUnscoped.mockReset().mockResolvedValue([]);
    store = await import("open-sse/services/quotaSnapshot.js");
    poller = await import("../../src/shared/services/quotaSnapshotPoller.js");
    store.clearQuotaSnapshots();

    deps = {
      getSettings: vi.fn().mockResolvedValue({
        providerStrategies: { codex: { fallbackStrategy: "weighted" } },
      }),
      getCombos: vi.fn().mockResolvedValue([]),
      getProviderConnectionsUnscoped: vi.fn(),
      resolveConnectionProxyConfig: vi.fn().mockResolvedValue({ connectionProxyEnabled: false }),
      refreshAndUpdateCredentials: vi.fn(async (connection) => ({ connection, refreshed: false })),
      getUsageForProvider: vi.fn().mockResolvedValue({
        quotas: { session: { used: 10, total: 100, windowMinutes: 300, resetAt: RESET_AT } },
      }),
    };
    state = { running: false, failureCache: {} };
  });

  afterEach(() => {
    poller?.stopQuotaSnapshotPoller();
    store?.clearQuotaSnapshots();
    vi.useRealTimers();
  });

  it("polls only missing or stale snapshots for weighted providers", async () => {
    const fresh = { id: "fresh", provider: "codex", authType: "oauth" };
    const stale = { id: "stale", provider: "codex", authType: "oauth" };
    const missing = { id: "missing", provider: "codex", authType: "oauth" };
    deps.getProviderConnectionsUnscoped.mockResolvedValue([fresh, stale, missing]);
    store.recordProbeWindows(
      fresh.id,
      fresh.provider,
      [{ kind: "5h", usedFraction: 0.1, resetsAt: RESET_AT }],
      {},
      NOW.getTime(),
    );
    store.recordProbeWindows(
      stale.id,
      stale.provider,
      [{ kind: "5h", usedFraction: 0.1, resetsAt: RESET_AT }],
      {},
      NOW.getTime() - 20 * 60_000,
    );

    await poller.runQuotaSnapshotTick(deps, state);

    expect(deps.getProviderConnectionsUnscoped).toHaveBeenCalledWith({
      provider: "codex",
      isActive: true,
    });
    expect(deps.refreshAndUpdateCredentials).toHaveBeenCalledTimes(2);
    expect(deps.refreshAndUpdateCredentials).toHaveBeenCalledWith(
      stale,
      false,
      expect.objectContaining({ strictProxy: false }),
    );
    expect(deps.refreshAndUpdateCredentials).toHaveBeenCalledWith(
      missing,
      false,
      expect.objectContaining({ strictProxy: false }),
    );
    expect(deps.getUsageForProvider).toHaveBeenCalledTimes(2);
    for (const call of deps.getUsageForProvider.mock.calls) {
      expect(call[2]).toEqual({ force: false });
    }
    expect(Object.hasOwn(deps, "getExecutor")).toBe(false);
    expect(Object.hasOwn(deps, "sendPing")).toBe(false);
  });

  it("caches failures and skips the connection during cooldown", async () => {
    const connection = { id: "broken", provider: "codex", authType: "oauth" };
    deps.getProviderConnectionsUnscoped.mockResolvedValue([connection]);
    deps.getUsageForProvider.mockRejectedValue(new Error("quota endpoint down"));

    await poller.runQuotaSnapshotTick(deps, state);
    await poller.runQuotaSnapshotTick(deps, state);

    expect(state.failureCache["codex:broken"]).toBe(NOW.getTime());
    expect(deps.getUsageForProvider).toHaveBeenCalledTimes(1);
  });

  it("skips malformed combo models without aborting the tick", async () => {
    const throwing = {};
    Object.defineProperty(throwing, "model", {
      get() {
        throw new Error("boom");
      },
    });
    deps.getSettings.mockResolvedValue({ comboStrategy: "weighted" });
    deps.getCombos.mockResolvedValue([
      { name: "mix", models: [null, 123, {}, throwing, "cx/gpt-5"] },
    ]);
    deps.getProviderConnectionsUnscoped.mockResolvedValue([
      { id: "cx-1", provider: "codex", authType: "oauth" },
    ]);

    await poller.runQuotaSnapshotTick(deps, state);

    expect(deps.getProviderConnectionsUnscoped).toHaveBeenCalledWith({
      provider: "codex",
      isActive: true,
    });
    expect(deps.getUsageForProvider).toHaveBeenCalledTimes(1);
  });

  it("prunes expired failureCache entries and caps size at 1000", async () => {
    deps.getSettings.mockResolvedValue({});
    const now = NOW.getTime();
    state.failureCache.expired = now - 900_000;
    for (let i = 0; i < 1100; i += 1) state.failureCache[`c:${i}`] = now - 1100 + i;

    await poller.runQuotaSnapshotTick(deps, state);

    const keys = Object.keys(state.failureCache);
    expect(keys).toHaveLength(1000);
    expect(keys).not.toContain("expired");
    expect(keys).not.toContain("c:0");
    expect(keys).toContain("c:1099");
  });

  it("ignores non-weighted provider strategies", async () => {
    deps.getSettings.mockResolvedValue({
      providerStrategies: { codex: { fallbackStrategy: "priority" } },
    });

    await poller.runQuotaSnapshotTick(deps, state);

    expect(deps.getProviderConnectionsUnscoped).not.toHaveBeenCalled();
  });

  it("isWeightedProvider reflects weighted strategy and fails closed", async () => {
    const { isWeightedProvider } = await import("../../src/shared/services/weightedTargets.js");
    const depsFor = (settings) => ({
      getSettings: vi.fn().mockResolvedValue(settings),
      getCombos: vi.fn().mockResolvedValue([]),
    });

    await expect(
      isWeightedProvider(
        "claude",
        depsFor({ providerStrategies: { claude: { fallbackStrategy: "weighted" } } }),
      ),
    ).resolves.toBe(true);
    await expect(
      isWeightedProvider(
        "claude",
        depsFor({ providerStrategies: { claude: { fallbackStrategy: "priority" } } }),
      ),
    ).resolves.toBe(false);
    await expect(
      isWeightedProvider("claude", {
        getSettings: vi.fn().mockRejectedValue(new Error("db down")),
        getCombos: vi.fn(),
      }),
    ).resolves.toBe(false);
  });

  it("starts scheduler when weighted provider exists and stops otherwise", () => {
    poller.configureQuotaSnapshotPoller({
      providerStrategies: { codex: { fallbackStrategy: "weighted" } },
    });
    expect(vi.getTimerCount()).toBe(1);

    poller.configureQuotaSnapshotPoller({
      providerStrategies: { codex: { fallbackStrategy: "priority" } },
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
