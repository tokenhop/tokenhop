// YAN-1221: settings saves reset only the routing state they changed, scoped to
// the workspace that was written. A cacheAffinity-only save clears nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mergeWorkspaceLayer } from "../../src/lib/settings/settingsScope.js";

const mocks = vi.hoisted(() => ({
  resetCombo: vi.fn(),
  resetAccounts: vi.fn(),
}));

vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: mocks.resetCombo }));
vi.mock("@/sse/services/auth", () => ({ resetAccountSelection: mocks.resetAccounts }));
vi.mock("@/shared/services/quotaSnapshotPoller", () => ({ syncQuotaSnapshotPoller: vi.fn() }));

const { runSettingsSideEffects } = await import("@/app/api/settings/settingsSideEffects.js");
const { planRoutingResets, touchesRoutingState } = await import(
  "@/app/api/settings/routingResetPlan.js"
);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("planRoutingResets", () => {
  const prev = {
    comboStrategy: "fallback",
    fallbackStrategy: "fill-first",
    comboStrategies: { c: { fallbackStrategy: "round-robin", cacheAffinity: true } },
    providerStrategies: {
      openai: { fallbackStrategy: "round-robin", cacheAffinity: true },
      claude: { fallbackStrategy: "weighted" },
    },
  };

  it("a cacheAffinity-only combo or provider edit resets nothing", () => {
    const next = {
      ...prev,
      comboStrategies: { c: { fallbackStrategy: "round-robin", cacheAffinity: false } },
      providerStrategies: {
        ...prev.providerStrategies,
        openai: { fallbackStrategy: "round-robin", cacheAffinity: false },
      },
    };
    expect(
      planRoutingResets(
        { comboStrategies: next.comboStrategies, providerStrategies: next.providerStrategies },
        next,
        prev,
      ),
    ).toEqual({ combos: false, accounts: null });
    expect(
      planRoutingResets(
        { comboStrategyPatch: { id: "c", patch: { cacheAffinity: false } } },
        next,
        prev,
      ),
    ).toEqual({ combos: false, accounts: null });
  });

  it("adding or removing an affinity-only provider entry resets nothing", () => {
    const before = { providerStrategies: {} };
    const after = { providerStrategies: { openai: { cacheAffinity: false } } };
    expect(planRoutingResets(after, after, before).accounts).toBeNull();
    expect(planRoutingResets(before, before, after).accounts).toBeNull();
  });

  it("copying an inherited provider entry into the workspace map only changes affinity", () => {
    const inherited = {
      providerStrategies: { openai: { fallbackStrategy: "weighted", stickyRoundRobinLimit: 3 } },
    };
    const owned = {
      providerStrategies: {
        openai: { ...inherited.providerStrategies.openai, cacheAffinity: false },
      },
    };
    const before = mergeWorkspaceLayer({ ...inherited }, {});
    const after = mergeWorkspaceLayer({ ...inherited }, owned);
    expect(planRoutingResets(owned, after, before).accounts).toBeNull();
    // A real strategy edit in the owned view still resets that provider.
    const changed = { providerStrategies: { openai: { fallbackStrategy: "round-robin" } } };
    expect(
      planRoutingResets(changed, mergeWorkspaceLayer({ ...inherited }, changed), before).accounts,
    ).toEqual(new Set(["openai"]));
  });

  it("a real combo change resets combos; a patch with another key too", () => {
    const next = { ...prev, comboStrategies: { c: { fallbackStrategy: "weighted" } } };
    expect(planRoutingResets({ comboStrategies: next.comboStrategies }, next, prev).combos).toBe(
      true,
    );
    expect(
      planRoutingResets(
        { comboStrategyPatch: { id: "c", patch: { fallbackStrategy: "weighted" } } },
        next,
        prev,
      ).combos,
    ).toBe(true);
  });

  it("provider edits reset only the providers whose other fields changed", () => {
    const next = {
      ...prev,
      providerStrategies: {
        ...prev.providerStrategies,
        claude: { fallbackStrategy: "round-robin" },
      },
    };
    expect(planRoutingResets({ providerStrategies: next.providerStrategies }, next, prev)).toEqual({
      combos: false,
      accounts: new Set(["claude"]),
    });
  });

  it("global account strategy changes reset every provider; unchanged values reset nothing", () => {
    const next = { ...prev, fallbackStrategy: "round-robin" };
    expect(planRoutingResets({ fallbackStrategy: "round-robin" }, next, prev).accounts).toBe("all");
    expect(planRoutingResets({ fallbackStrategy: "fill-first" }, prev, prev).accounts).toBeNull();
  });

  it("without a previous snapshot every touched area resets (fail-safe)", () => {
    expect(planRoutingResets({ comboStrategies: {} }, {}, undefined)).toEqual({
      combos: true,
      accounts: null,
    });
    expect(planRoutingResets({ providerStrategies: {} }, {}, undefined).accounts).toBe("all");
    expect(
      planRoutingResets({ comboStrategyPatch: { id: "c", patch: { weights: {} } } }, {}).combos,
    ).toBe(true);
  });

  it("touchesRoutingState only flags routing keys", () => {
    expect(touchesRoutingState({ theme: "dark" })).toBe(false);
    expect(touchesRoutingState({ providerStrategies: {} })).toBe(true);
  });
});

describe("runSettingsSideEffects scoping", () => {
  const prev = {
    comboStrategies: { c: { fallbackStrategy: "round-robin", cacheAffinity: true } },
    providerStrategies: { openai: { fallbackStrategy: "round-robin", cacheAffinity: true } },
  };

  it("a workspace save resets only that workspace", async () => {
    const body = { comboStrategies: { c: { fallbackStrategy: "weighted" } } };
    runSettingsSideEffects(body, body, { workspaceId: "wsA", previous: prev });
    expect(mocks.resetCombo).toHaveBeenCalledWith(undefined, { workspaceId: "wsA" });

    const accounts = {
      providerStrategies: { openai: { fallbackStrategy: "weighted" } },
    };
    runSettingsSideEffects(accounts, accounts, { workspaceId: "wsA", previous: prev });
    await flush();
    expect(mocks.resetAccounts).toHaveBeenCalledWith("openai", { workspaceId: "wsA" });
  });

  it("a cacheAffinity-only save clears nothing, instance or workspace", async () => {
    const body = {
      comboStrategies: { c: { fallbackStrategy: "round-robin", cacheAffinity: false } },
      providerStrategies: { openai: { fallbackStrategy: "round-robin", cacheAffinity: false } },
    };
    for (const scope of [{ previous: prev }, { workspaceId: "wsA", previous: prev }]) {
      runSettingsSideEffects(body, body, scope);
    }
    await flush();
    expect(mocks.resetCombo).not.toHaveBeenCalled();
    expect(mocks.resetAccounts).not.toHaveBeenCalled();
  });

  it("the instance save and a missing snapshot keep the global reset", async () => {
    const body = { comboStrategy: "round-robin", fallbackStrategy: "round-robin" };
    runSettingsSideEffects(body, body, { previous: { comboStrategy: "fallback" } });
    runSettingsSideEffects(body, body);
    await flush();
    expect(mocks.resetCombo).toHaveBeenCalledTimes(2);
    for (const call of mocks.resetCombo.mock.calls) {
      expect(call).toEqual([undefined, { workspaceId: undefined }]);
    }
    expect(mocks.resetAccounts.mock.calls.every(([id]) => id === undefined)).toBe(true);
  });
});
