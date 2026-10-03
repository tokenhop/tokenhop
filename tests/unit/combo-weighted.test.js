import { describe, it, expect, beforeEach } from "vitest";

import {
  getWeightedModels,
  handleComboChat,
  resetComboRotation,
} from "../../open-sse/services/combo.js";
import {
  resolveComboStrategy,
  validateComboStrategySettings,
} from "../../open-sse/services/comboStrategy.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };

function errResponse(status, message, headers = {}) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function okResponse() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function firstPicks({ models, name, weights, headroomFn, stickyLimit, count }) {
  return Array.from(
    { length: count },
    () => getWeightedModels(models, name, weights, headroomFn, stickyLimit)[0],
  );
}

describe("weighted combo distribution", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("3:1 weights give A first 75% over 1000 draws", () => {
    const picks = firstPicks({
      models: ["a", "b"],
      name: "w-dist-3-1",
      weights: { a: 3, b: 1 },
      count: 1000,
    });
    const aCount = picks.filter((p) => p === "a").length;
    expect(aCount).toBeGreaterThanOrEqual(730);
    expect(aCount).toBeLessThanOrEqual(770);
  });

  it("headroom 0.2 on A gives A first 37.5% over 1000 draws", () => {
    const picks = firstPicks({
      models: ["a", "b"],
      name: "w-dist-headroom",
      weights: { a: 3, b: 1 },
      headroomFn: (m) => (m === "a" ? 0.2 : 1),
      count: 1000,
    });
    const aCount = picks.filter((p) => p === "a").length;
    expect(aCount).toBeGreaterThanOrEqual(355);
    expect(aCount).toBeLessThanOrEqual(395);
  });
});

describe("weighted combo edge weights", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it.each([
    ["unknown", () => undefined],
    ["NaN", () => NaN],
    [
      "throw",
      () => {
        throw new Error("db down");
      },
    ],
  ])("%s headroom keeps the configured weights", (_label, headroomFn) => {
    resetComboRotation("w-headroom-edge");
    const [first] = getWeightedModels(["a", "b"], "w-headroom-edge", { a: 3, b: 1 }, headroomFn);
    expect(first).toBe("a");
  });

  it("weight 0 is never first but stays in the fallback tail", () => {
    for (let i = 0; i < 10; i++) {
      const result = getWeightedModels(["a", "b"], "w-zero", { a: 0, b: 1 });
      expect(result[0]).toBe("b");
      expect(result).toEqual(["b", "a"]);
    }
  });

  it("all-zero weights keep the original order", () => {
    const models = ["a", "b", "c"];
    expect(getWeightedModels(models, "w-all-zero", { a: 0, b: 0, c: 0 })).toEqual(models);
  });
});

describe("weighted combo sticky + reset", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("sticky 3 holds each pick for 3 calls without advancing the draw", () => {
    const picks = firstPicks({
      models: ["a", "b"],
      name: "w-sticky",
      weights: { a: 1, b: 1 },
      stickyLimit: 3,
      count: 6,
    });
    expect(picks).toEqual(["a", "a", "a", "b", "b", "b"]);
  });

  it("resetComboRotation(name) resets state to a fresh first pick", () => {
    const name = "w-reset";
    const fresh = getWeightedModels(["a", "b"], name, { a: 3, b: 1 })[0];
    for (let i = 0; i < 5; i++) getWeightedModels(["a", "b"], name, { a: 3, b: 1 });
    expect(getWeightedModels(["a", "b"], name, { a: 3, b: 1 })[0]).toBe("b");
    resetComboRotation(name);
    expect(getWeightedModels(["a", "b"], name, { a: 3, b: 1 })[0]).toBe(fresh);
  });
});

describe("resolveComboStrategy", () => {
  it("prefers the per-combo override over the global strategy", () => {
    const resolved = resolveComboStrategy(
      {
        comboStrategy: "fallback",
        comboStrategies: { code: { fallbackStrategy: "weighted", weights: { a: 3 } } },
      },
      "code",
    );
    expect(resolved.strategy).toBe("weighted");
    expect(resolved.weights).toEqual({ a: 3 });
  });

  it("falls back to the global strategy when the combo has no entry", () => {
    expect(resolveComboStrategy({ comboStrategy: "round-robin" }, "missing").strategy).toBe(
      "round-robin",
    );
    expect(resolveComboStrategy({}, "missing").strategy).toBe("fallback");
  });

  it("resolves unknown stored strategies to fallback", () => {
    expect(resolveComboStrategy({ comboStrategy: "bogus" }, "x").strategy).toBe("fallback");
    expect(
      resolveComboStrategy({ comboStrategies: { x: { fallbackStrategy: "bogus" } } }, "x").strategy,
    ).toBe("fallback");
  });

  it("never resolves __proto__ through the prototype chain", () => {
    expect(resolveComboStrategy({}, "__proto__").strategy).toBe("fallback");
    const owned = JSON.parse('{"comboStrategies":{"__proto__":{"fallbackStrategy":"weighted"}}}');
    expect(resolveComboStrategy(owned, "__proto__").strategy).toBe("weighted");
  });
});

describe("validateComboStrategySettings", () => {
  it("rejects unknown global and per-combo strategies", () => {
    expect(validateComboStrategySettings({ comboStrategy: "bogus" })).toContain("comboStrategy");
    expect(
      validateComboStrategySettings({ comboStrategies: { code: { fallbackStrategy: "nope" } } }),
    ).toContain('combo "code"');
  });

  it.each([
    ["negative", -1],
    ["NaN", NaN],
    ["string", "3"],
    ["over cap", 1001],
  ])("rejects %s weights", (_label, value) => {
    expect(
      validateComboStrategySettings({ comboStrategies: { code: { weights: { a: value } } } }),
    ).toContain('model "a"');
  });

  it("rejects blocked keys smuggled in via JSON.parse", () => {
    const comboName = JSON.parse(
      '{"comboStrategies":{"__proto__":{"fallbackStrategy":"weighted"}}}',
    );
    expect(validateComboStrategySettings(comboName)).toContain("__proto__");
    const weightKey = JSON.parse('{"comboStrategies":{"code":{"weights":{"__proto__":1}}}}');
    expect(validateComboStrategySettings(weightKey)).toContain("__proto__");
  });

  it("rejects malformed comboStrategies and weights", () => {
    expect(validateComboStrategySettings({ comboStrategies: ["code"] })).not.toBeNull();
    expect(validateComboStrategySettings({ comboStrategies: { code: "weighted" } })).not.toBeNull();
    expect(
      validateComboStrategySettings({ comboStrategies: { code: { weights: [1] } } }),
    ).not.toBeNull();
  });

  it("accepts weighted with a zero weight", () => {
    expect(
      validateComboStrategySettings({
        comboStrategies: { code: { fallbackStrategy: "weighted", weights: { a: 0, b: 1 } } },
      }),
    ).toBeNull();
  });
});

describe("handleComboChat weighted failover", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("tries the rest in original order after the weighted first pick fails", async () => {
    const tried = [];
    const res = await handleComboChat({
      body: {},
      models: ["p/a", "p/b", "p/c"],
      comboName: "w-failover",
      comboStrategy: "weighted",
      comboWeights: { "p/a": 3, "p/b": 1, "p/c": 1 },
      handleSingleModel: async (_body, model) => {
        tried.push(model);
        if (model !== "p/c") return errResponse(429, "Rate limit exceeded", { "Retry-After": "5" });
        return okResponse();
      },
      log,
    });

    expect(tried[0]).toBe("p/a");
    expect(tried).toEqual(["p/a", "p/b", "p/c"]);
    expect(res.ok).toBe(true);
  });
});

describe("loadComboHeadroomFn", () => {
  it("resolves provider aliases for bare and provider/model members", async () => {
    const { recordHeaderWindows, clearQuotaSnapshots } = await import(
      "../../open-sse/services/quotaSnapshot.js"
    );
    const { loadComboHeadroomFn } = await import("../../src/sse/services/comboHeadroom.js");
    clearQuotaSnapshots();
    recordHeaderWindows("conn-1", "claude", [{ kind: "5h", usedFraction: 0.8 }]);
    const headroom = await loadComboHeadroomFn({
      getProviderConnectionsUnscoped: async () => [{ id: "conn-1", provider: "claude" }],
    });
    expect(headroom("cc")).toBeCloseTo(0.2);
    expect(headroom("cc/claude-opus")).toBeCloseTo(0.2);
    expect(headroom("unknown/model")).toBe(1);
    clearQuotaSnapshots();
  });
});
