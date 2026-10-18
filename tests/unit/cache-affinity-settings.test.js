// Conversation cache affinity (YAN-1211/1213): per-combo flag resolution, PATCH
// acceptance, and provider-strategy validation.
import { describe, it, expect } from "vitest";
import {
  resolveComboStrategy,
  validateComboStrategySettings,
  CACHE_AFFINITY_STRATEGIES,
} from "../../open-sse/services/comboStrategy.js";
import { applyComboStrategyPatch } from "../../src/app/api/settings/comboStrategyPatch.js";
import { validateSettingsBody } from "../../src/app/api/settings/validateSettings.js";
import { validateSectionSettings } from "../../src/app/api/settings/validateSectionSettings.js";

describe("CACHE_AFFINITY_STRATEGIES", () => {
  it("lists the per-turn rotating strategies", () => {
    expect([...CACHE_AFFINITY_STRATEGIES]).toEqual(["round-robin", "weighted", "fastest"]);
  });
});

describe("resolveComboStrategy cacheAffinity", () => {
  const settings = (entry) => ({ comboStrategies: { c: entry } });

  it("defaults to true", () => {
    expect(resolveComboStrategy({}, "c").cacheAffinity).toBe(true);
    expect(
      resolveComboStrategy(settings({ fallbackStrategy: "round-robin" }), "c").cacheAffinity,
    ).toBe(true);
  });

  it("is false when stored false and true when stored true", () => {
    expect(resolveComboStrategy(settings({ cacheAffinity: false }), "c").cacheAffinity).toBe(false);
    expect(resolveComboStrategy(settings({ cacheAffinity: true }), "c").cacheAffinity).toBe(true);
  });
});

describe("validateComboStrategySettings cacheAffinity", () => {
  const check = (cacheAffinity) =>
    validateComboStrategySettings({
      comboStrategies: { c: { fallbackStrategy: "round-robin", cacheAffinity } },
    });

  it("rejects non-booleans", () => {
    for (const bad of ["yes", 1, null]) {
      expect(check(bad)).toBe('Invalid cacheAffinity for combo "c"');
    }
  });

  it("accepts booleans", () => {
    expect(check(true)).toBeNull();
    expect(check(false)).toBeNull();
  });

  it("rejects cacheAffinity without fallbackStrategy in a full body", () => {
    for (const value of [true, false]) {
      expect(
        validateComboStrategySettings({ comboStrategies: { c: { cacheAffinity: value } } }),
      ).toBe('Invalid cacheAffinity for combo "c": requires fallbackStrategy');
    }
    expect(
      validateComboStrategySettings({ comboStrategies: { c: { weights: { a: 1 } } } }),
    ).toBeNull();
  });
});

describe("applyComboStrategyPatch cacheAffinity", () => {
  const makeUpdate = (initial = {}) => {
    const state = { strategies: initial };
    const update = async (transform, key) => {
      state.strategies = transform(state.strategies, key);
      return { comboStrategies: state.strategies };
    };
    return { state, update };
  };

  it("accepts and stores cacheAffinity", async () => {
    const { state, update } = makeUpdate();
    const result = await applyComboStrategyPatch(
      {
        comboStrategyPatch: {
          name: "c",
          patch: { fallbackStrategy: "round-robin", cacheAffinity: false },
        },
      },
      update,
    );
    expect(result.response).toBeUndefined();
    expect(state.strategies.c).toEqual({ fallbackStrategy: "round-robin", cacheAffinity: false });
  });

  it("rejects any cacheAffinity for an entry with no stored fallbackStrategy", async () => {
    for (const value of [false, true]) {
      const { state, update } = makeUpdate();
      const result = await applyComboStrategyPatch(
        { comboStrategyPatch: { name: "c", patch: { cacheAffinity: value } } },
        update,
      );
      expect(result.response.status).toBe(400);
      expect(state.strategies).toEqual({});
    }
  });

  it("rejects a non-boolean cacheAffinity", async () => {
    const { update } = makeUpdate();
    const result = await applyComboStrategyPatch(
      {
        comboStrategyPatch: {
          name: "c",
          patch: { fallbackStrategy: "round-robin", cacheAffinity: "no" },
        },
      },
      update,
    );
    expect(result.response.status).toBe(400);
  });

  it("still rejects unknown keys", async () => {
    const { update } = makeUpdate();
    const result = await applyComboStrategyPatch(
      { comboStrategyPatch: { name: "c", patch: { fallbackStrategy: "fallback", bogus: 1 } } },
      update,
    );
    expect(result.response.status).toBe(400);
  });
});

describe("providerStrategies.cacheAffinity validation", () => {
  const body = (cacheAffinity) => ({ providerStrategies: { openai: { cacheAffinity } } });

  it("validateSettingsBody accepts booleans and rejects strings", () => {
    expect(validateSettingsBody(body(false))).toBe("");
    expect(validateSettingsBody(body(true))).toBe("");
    expect(validateSettingsBody(body("false"))).not.toBe("");
  });

  it("validateSectionSettings accepts booleans and rejects strings", () => {
    expect(validateSectionSettings(body(false))).toBeFalsy();
    expect(validateSectionSettings(body(true))).toBeFalsy();
    expect(validateSectionSettings(body("false"))).toBeTruthy();
  });
});
