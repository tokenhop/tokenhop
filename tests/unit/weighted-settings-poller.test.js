import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200 }) },
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getCombos: vi.fn(),
  getModelAliases: vi.fn(async () => ({})),
  getProviderConnectionsUnscoped: vi.fn(),
  updateProviderConnectionUnscoped: vi.fn(),
}));
// YAN-362: the poller's default deps read preferences from the DB barrel; keep
// the real DB (and its checkpoint timer) out of these fake-timer tests.
vi.mock("@/lib/db/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  listEffectivePreferencesUnscoped: vi.fn(async () => null),
}));
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: vi.fn() }));
vi.mock("@/sse/services/auth", () => ({ resetAccountSelection: vi.fn() }));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn() }));
vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: vi.fn(),
}));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: vi.fn() }));
vi.mock("@/sse/services/quotaSnapshotSync", () => ({
  fetchAndPersistClaudePlanTier: vi.fn(),
  recordUsageSnapshot: vi.fn(),
}));

import {
  getCombos,
  getProviderConnectionsUnscoped,
  getSettings,
  updateSettings,
} from "@/lib/localDb";
import { resetAccountSelection } from "@/sse/services/auth";
import { PATCH } from "../../src/app/api/settings/route.js";
import {
  comboMemberProviders,
  weightedProviders,
  isWeightedProvider,
} from "../../src/shared/services/weightedTargets.js";
import {
  configureQuotaSnapshotPoller,
  runQuotaSnapshotTick,
  stopQuotaSnapshotPoller,
  syncQuotaSnapshotPoller,
} from "../../src/shared/services/quotaSnapshotPoller.js";

const patch = (body) => PATCH({ json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  updateSettings.mockImplementation(async (body) => body);
  // Scheduler start runs one real-deps tick; keep it inert.
  getSettings.mockResolvedValue({});
  getCombos.mockResolvedValue([]);
  getProviderConnectionsUnscoped.mockResolvedValue([]);
  vi.useFakeTimers();
});
afterEach(() => {
  stopQuotaSnapshotPoller();
  vi.useRealTimers();
});

describe("weighted settings validation", () => {
  it.each([
    { fallbackStrategy: "random" },
    { fallbackStrategy: null },
    { stickyRoundRobinLimit: 0 },
    { stickyRoundRobinLimit: 101 },
    { stickyRoundRobinLimit: "3" },
    { providerStrategies: null },
    { providerStrategies: [] },
    { providerStrategies: { "": {} } },
    { providerStrategies: { "  ": {} } },
    { providerStrategies: { constructor: {} } },
    { providerStrategies: JSON.parse('{"__proto__":{}}') },
    { providerStrategies: { claude: null } },
    { providerStrategies: { claude: { fallbackStrategy: "random" } } },
    { providerStrategies: { claude: { stickyRoundRobinLimit: 1.5 } } },
    { providerStrategies: { " claude ": {} } },
    { providerStrategies: { claude: JSON.parse('{"__proto__":{}}') } },
    null,
    ["weighted"],
    "weighted",
  ])("rejects invalid account settings without persisting: %j", async (body) => {
    const response = await patch(body);
    expect(response.status).toBe(400);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("preserves proxy rotation fields and resets selection for valid weighted settings", async () => {
    const body = {
      fallbackStrategy: "weighted",
      stickyRoundRobinLimit: 1,
      providerStrategies: {
        claude: { fallbackStrategy: "weighted", stickyRoundRobinLimit: 100 },
        noauth: { rotateStrategy: "random", proxyPoolId: "pool-1" },
      },
    };
    expect((await patch(body)).status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith(body);
    await vi.waitFor(() => expect(resetAccountSelection).toHaveBeenCalledOnce());
  });
});

describe("global weighted poller", () => {
  const settings = {
    fallbackStrategy: "weighted",
    providerStrategies: { codex: { fallbackStrategy: "fill-first" } },
  };

  it("resolves active providers, excluding per-provider opt-out but keeping weighted combos", async () => {
    expect([...weightedProviders(settings, [], ["claude", "codex"])]).toEqual(["claude"]);
    const weightedCombo = { ...settings, comboStrategy: "weighted" };
    expect(
      weightedProviders(weightedCombo, [{ name: "mix", models: ["cx/gpt-5"] }], []).has("codex"),
    ).toBe(true);
    expect(
      await isWeightedProvider("claude", {
        getSettings: async () => settings,
        getCombos: async () => [],
      }),
    ).toBe(true);
    expect(
      await isWeightedProvider("codex", {
        getSettings: async () => settings,
        getCombos: async () => [],
      }),
    ).toBe(false);

    const getProviderConnectionsUnscoped = vi.fn(async ({ provider }) =>
      provider ? [] : [{ provider: "claude" }, { provider: "codex" }],
    );
    await runQuotaSnapshotTick(
      {
        getSettings: async () => settings,
        getCombos: async () => [],
        getProviderConnectionsUnscoped,
      },
      { running: false, failureCache: {} },
    );
    expect(getProviderConnectionsUnscoped.mock.calls.map(([filter]) => filter)).toEqual([
      { isActive: true },
      { provider: "claude", isActive: true },
    ]);
  });

  it("starts for global weighted and stops when disabled", () => {
    configureQuotaSnapshotPoller(settings);
    expect(vi.getTimerCount()).toBe(1);
    configureQuotaSnapshotPoller({ fallbackStrategy: "fill-first" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("non-weighted combo members (YAN-384)", () => {
  const combo = { name: "c", models: ["cx/gpt-5"] };

  it("comboMemberProviders returns providers for any strategy; weightedProviders stays weighted-only", () => {
    const fillFirst = { fallbackStrategy: "fill-first" };
    expect(comboMemberProviders([combo]).has("codex")).toBe(true);
    expect(weightedProviders(fillFirst, [combo], []).has("codex")).toBe(false);
  });

  it("poller starts for a non-weighted combo member and stops when combos are empty", () => {
    const fillFirst = { fallbackStrategy: "fill-first" };
    configureQuotaSnapshotPoller(fillFirst, [combo]);
    expect(vi.getTimerCount()).toBe(1);
    configureQuotaSnapshotPoller(fillFirst, [{ name: "e", models: [] }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tick polls non-weighted combo member providers", async () => {
    const getProviderConnectionsUnscoped = vi.fn(async ({ provider }) =>
      provider ? [] : [{ provider: "claude" }],
    );
    await runQuotaSnapshotTick(
      {
        getSettings: async () => ({ fallbackStrategy: "fill-first" }),
        getCombos: async () => [combo],
        getProviderConnectionsUnscoped,
      },
      { running: false, failureCache: {} },
    );
    expect(getProviderConnectionsUnscoped.mock.calls.map(([filter]) => filter)).toEqual([
      { provider: "codex", isActive: true },
    ]);
  });

  it("isWeightedProvider stays false for a non-weighted combo member", async () => {
    await expect(
      isWeightedProvider("codex", {
        getSettings: async () => ({ fallbackStrategy: "fill-first" }),
        getCombos: async () => [combo],
      }),
    ).resolves.toBe(false);
  });

  it("syncQuotaSnapshotPoller starts for non-weighted combo and never throws on combos read failure", async () => {
    await syncQuotaSnapshotPoller({
      getSettings: async () => ({ fallbackStrategy: "fill-first" }),
      getCombos: async () => [combo],
    });
    expect(vi.getTimerCount()).toBe(1);

    await expect(
      syncQuotaSnapshotPoller({
        getSettings: async () => ({ fallbackStrategy: "fill-first" }),
        getCombos: async () => Promise.reject(new Error("db down")),
      }),
    ).resolves.toBeUndefined();
    // A transient combos read failure keeps the running scheduler.
    expect(vi.getTimerCount()).toBe(1);

    // A settings read failure never throws into fire-and-forget callers.
    await expect(
      syncQuotaSnapshotPoller({ getSettings: () => Promise.reject(new Error("db down")) }),
    ).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("alias combo members (YAN-386)", () => {
  const aliases = { "my-opus": "claude/claude-opus-4-7" };
  const combos = [
    { name: "c", models: ["my-opus", "inner"] },
    { name: "inner", models: ["cx/gpt-5"] },
  ];

  it("resolves bare alias members and skips nested combo names", () => {
    expect([...comboMemberProviders(combos, aliases)].sort()).toEqual(["claude", "codex"]);
    expect(comboMemberProviders([{ name: "c", models: ["my-opus"] }]).size).toBe(0);
  });

  it("tick polls the aliased provider", async () => {
    const getProviderConnectionsUnscoped = vi.fn(async () => []);
    await runQuotaSnapshotTick(
      {
        getSettings: async () => ({ fallbackStrategy: "fill-first" }),
        getCombos: async () => [{ name: "c", models: ["my-opus"] }],
        getModelAliases: async () => aliases,
        getProviderConnectionsUnscoped,
      },
      { running: false, failureCache: {} },
    );
    expect(getProviderConnectionsUnscoped).toHaveBeenCalledWith({
      provider: "claude",
      isActive: true,
    });
  });

  it("sync keeps a running scheduler when the aliases read fails", async () => {
    const fillFirst = async () => ({ fallbackStrategy: "fill-first" });
    const aliasOnly = async () => [{ name: "c", models: ["my-opus"] }];
    await syncQuotaSnapshotPoller({
      getSettings: fillFirst,
      getCombos: aliasOnly,
      getModelAliases: async () => aliases,
    });
    expect(vi.getTimerCount()).toBe(1);
    await syncQuotaSnapshotPoller({
      getSettings: fillFirst,
      getCombos: aliasOnly,
      getModelAliases: () => Promise.reject(new Error("db down")),
    });
    expect(vi.getTimerCount()).toBe(1);
  });
});
