import { describe, it, expect } from "vitest";

import {
  roleLabel,
  STRATEGY_EXPLAINERS,
  STRATEGIES,
  weightShare,
  isFallbackOnly,
  parseWeight,
  validateComboName,
  applyEditorAction,
  isDirty,
  usageTodayForCombo,
  assignStepIds,
  pruneKeys,
} from "../../src/shared/components/combos/comboBuilder.js";

describe("roleLabel", () => {
  it("fallback: index 0 Primary, rest Backup", () => {
    expect(roleLabel("fallback", 0)).toBe("Primary");
    expect(roleLabel("fallback", 1)).toBe("Backup");
    expect(roleLabel("fallback", 5)).toBe("Backup");
  });

  it("round-robin → In rotation", () => {
    expect(roleLabel("round-robin", 0)).toBe("In rotation");
    expect(roleLabel("round-robin", 2)).toBe("In rotation");
  });

  it("weighted → Weighted", () => {
    expect(roleLabel("weighted", 0)).toBe("Weighted");
    expect(roleLabel("weighted", 1)).toBe("Weighted");
  });

  it("fusion → Panelist", () => {
    expect(roleLabel("fusion", 0)).toBe("Panelist");
    expect(roleLabel("fusion", 3)).toBe("Panelist");
  });

  it("unknown strategy → Primary/Backup ordering", () => {
    expect(roleLabel("bogus", 0)).toBe("Primary");
    expect(roleLabel("bogus", 1)).toBe("Backup");
    expect(roleLabel(undefined, 0)).toBe("Primary");
    expect(roleLabel(undefined, 2)).toBe("Backup");
  });
});

describe("STRATEGY_EXPLAINERS", () => {
  it("has board copy for all four strategies", () => {
    expect(STRATEGY_EXPLAINERS.fallback).toBe(
      "Every request starts at #1. On a rate limit, auth error or outage, 9router moves down the list without your client noticing.",
    );
    expect(STRATEGY_EXPLAINERS["round-robin"]).toBe(
      "Each request goes to the next model in the list, spreading load and quota evenly.",
    );
    expect(STRATEGY_EXPLAINERS.weighted).toBe(
      "Traffic splits by weight, then shifts away from accounts that are running low on quota.",
    );
    expect(STRATEGY_EXPLAINERS.fusion).toBe(
      "Every model in the panel answers in parallel. The judge reads them all and returns the best reply.",
    );
  });
});

describe("STRATEGIES", () => {
  it("has four cards with labels, descs, Material Symbols icons", () => {
    expect(STRATEGIES.map((s) => s.id)).toEqual(["fallback", "round-robin", "weighted", "fusion"]);
    expect(STRATEGIES.map((s) => s.label)).toEqual([
      "Fallback",
      "Round robin",
      "Weighted",
      "Fusion",
    ]);
    expect(STRATEGIES.map((s) => s.desc)).toEqual([
      "Try in order until one answers",
      "Rotate on every request",
      "Split by weight and remaining quota",
      "Ask a panel, let a judge pick",
    ]);
    expect(STRATEGIES.map((s) => s.icon)).toEqual([
      "low_priority",
      "autorenew",
      "bar_chart",
      "gavel",
    ]);
  });
});

describe("weightShare", () => {
  it("splits 50/30/20 like the board example", () => {
    expect(weightShare([50, 30, 20], [1, 1, 1])).toEqual([50, 30, 20]);
  });

  it("weight 0 → share 0", () => {
    expect(weightShare([1, 0], [1, 1])).toEqual([100, 0]);
  });

  it("scales by headroom", () => {
    // 3*0.2=0.6 vs 1*1=1 → 37.5 / 62.5
    expect(weightShare([3, 1], [0.2, 1])).toEqual([37.5, 62.5]);
  });

  it("missing weights default to 1", () => {
    expect(weightShare([], [])).toEqual([]);
    expect(weightShare([2], [])).toEqual([100]);
    expect(weightShare([undefined, undefined], [1, 1])).toEqual([50, 50]);
  });

  it("non-finite/negative headroom → 1", () => {
    expect(weightShare([1, 1], [NaN, 1])).toEqual([50, 50]);
    expect(weightShare([1, 1], [-0.5, 1])).toEqual([50, 50]);
    expect(weightShare([1, 1], [Infinity, 1])).toEqual([50, 50]);
  });

  it("total 0 → all 0", () => {
    expect(weightShare([0, 0], [1, 1])).toEqual([0, 0]);
  });

  it("rounds to 1 decimal", () => {
    expect(weightShare([1, 1, 1], [1, 1, 1])).toEqual([33.3, 33.3, 33.3]);
  });
});

describe("isFallbackOnly", () => {
  it("only weight === 0", () => {
    expect(isFallbackOnly(0)).toBe(true);
    expect(isFallbackOnly(1)).toBe(false);
    expect(isFallbackOnly("0")).toBe(false);
    expect(isFallbackOnly(undefined)).toBe(false);
  });
});

describe("parseWeight", () => {
  it("undefined → {ok:false}", () => {
    expect(parseWeight(undefined)).toEqual({ ok: false, error: "Enter a number" });
  });

  it("empty/non-finite → {ok:false,error}", () => {
    expect(parseWeight("").ok).toBe(false);
    expect(parseWeight("   ").ok).toBe(false);
    expect(parseWeight("abc").ok).toBe(false);
    expect(parseWeight(NaN).ok).toBe(false);
    expect(parseWeight(Infinity).ok).toBe(false);
  });

  it("out of range → {ok:false,error}", () => {
    expect(parseWeight(-1)).toEqual({ ok: false, error: "Weight must be between 0 and 1000" });
    expect(parseWeight(1001)).toEqual({ ok: false, error: "Weight must be between 0 and 1000" });
    expect(parseWeight("-5").ok).toBe(false);
  });

  it("accepts strings and boundary values", () => {
    expect(parseWeight("50")).toEqual({ ok: true, value: 50 });
    expect(parseWeight("0")).toEqual({ ok: true, value: 0 });
    expect(parseWeight(0)).toEqual({ ok: true, value: 0 });
    expect(parseWeight(1000)).toEqual({ ok: true, value: 1000 });
    expect(parseWeight("2.5")).toEqual({ ok: true, value: 2.5 });
  });
});

describe("validateComboName", () => {
  it("trimmed empty → Name is required", () => {
    expect(validateComboName("")).toEqual({ ok: false, error: "Name is required" });
    expect(validateComboName("   ")).toEqual({ ok: false, error: "Name is required" });
    expect(validateComboName(undefined)).toEqual({ ok: false, error: "Name is required" });
  });

  it("bad chars → allowed-set error", () => {
    expect(validateComboName("my combo!")).toEqual({
      ok: false,
      error: "Only letters, numbers, -, _ and . allowed",
    });
    expect(validateComboName("a/b")).toEqual({
      ok: false,
      error: "Only letters, numbers, -, _ and . allowed",
    });
  });

  it("accepts and trims valid names", () => {
    expect(validateComboName("coder")).toEqual({ ok: true, value: "coder" });
    expect(validateComboName("  fast-chat_2.0 ")).toEqual({ ok: true, value: "fast-chat_2.0" });
  });
});

describe("applyEditorAction / isDirty", () => {
  const saved = { name: "coder", models: ["a"], strategy: "fallback", weights: {}, judgeModel: "" };
  const fresh = () => ({ saved: { ...saved }, draft: { ...saved }, errors: { w: "x" } });

  it("set updates draft[field]", () => {
    const next = applyEditorAction(fresh(), { type: "set", field: "strategy", value: "weighted" });
    expect(next.draft.strategy).toBe("weighted");
    expect(next.saved.strategy).toBe("fallback");
    expect(isDirty(next)).toBe(true);
  });

  it("reset copies saved→draft and clears errors", () => {
    const dirty = { ...fresh(), draft: { ...saved, strategy: "fusion" } };
    const next = applyEditorAction(dirty, { type: "reset" });
    expect(next.draft).toEqual(saved);
    expect(next.errors).toEqual({});
    expect(isDirty(next)).toBe(false);
  });

  it("saved replaces saved and draft, clears errors", () => {
    const nextSaved = { ...saved, strategy: "weighted" };
    const next = applyEditorAction(fresh(), { type: "saved", saved: nextSaved });
    expect(next.saved).toEqual(nextSaved);
    expect(next.draft).toEqual(nextSaved);
    expect(next.errors).toEqual({});
    expect(isDirty(next)).toBe(false);
  });

  it("isDirty false when JSON matches", () => {
    expect(isDirty(fresh())).toBe(false);
  });

  it("does not mutate input state", () => {
    const s = fresh();
    applyEditorAction(s, { type: "set", field: "name", value: "other" });
    expect(s.draft.name).toBe("coder");
  });
});

describe("usageTodayForCombo", () => {
  const byModel = {
    "coder (opencode)": { requests: 3, rawModel: "coder" },
    "mimo-v2.5-free (opencode)": { requests: 2, rawModel: "mimo-v2.5-free" },
    "qwen3-coder (openrouter)": { requests: 5, rawModel: "qwen3-coder" },
    "other (x)": { requests: 100, rawModel: "other" },
  };
  const combo = { name: "coder", models: ["oc/mimo-v2.5-free", "or/qwen3-coder"] };

  it("counts direct combo hits plus member-model traffic", () => {
    expect(usageTodayForCombo(combo, byModel)).toBe(10);
  });

  it("matches bare model ids against provider/model entries", () => {
    expect(usageTodayForCombo({ name: "x", models: ["mimo-v2.5-free"] }, byModel)).toBe(2);
  });

  it("string form counts combo-name hits only", () => {
    expect(usageTodayForCombo("coder", byModel)).toBe(3);
  });

  it("returns 0 for missing data", () => {
    expect(usageTodayForCombo(combo, null)).toBe(0);
    expect(usageTodayForCombo(combo, {})).toBe(0);
    expect(usageTodayForCombo({ name: "nope", models: [] }, byModel)).toBe(0);
  });
});

describe("assignStepIds", () => {
  it("assigns fresh ids on first load", () => {
    const steps = assignStepIds(["a", "b"]);
    expect(steps).toEqual([
      { id: "step-1", model: "a" },
      { id: "step-2", model: "b" },
    ]);
  });

  it("gives duplicate models distinct ids", () => {
    const steps = assignStepIds(["m", "m", "m"]);
    expect(new Set(steps.map((s) => s.id)).size).toBe(3);
    expect(steps.map((s) => s.model)).toEqual(["m", "m", "m"]);
  });

  it("preserves per-instance identity across reorder", () => {
    const first = assignStepIds(["a", "b", "b"]);
    const [idA, idB1, idB2] = first.map((s) => s.id);
    const reordered = assignStepIds(["b", "a", "b"], first);
    expect(reordered.map((s) => s.id)).toEqual([idB1, idA, idB2]);
  });

  it("drops removed ids and mints fresh ones for added models", () => {
    const first = assignStepIds(["a", "b"]);
    const next = assignStepIds(["a", "c"], first);
    expect(next.map((s) => s.id)).toEqual(["step-1", "step-3"]);
  });

  it("is fixpoint-stable (StrictMode double render keeps ids)", () => {
    const once = assignStepIds(["x", "x"], []);
    const twice = assignStepIds(["x", "x"], once);
    expect(twice).toEqual(once);
  });
});

describe("pruneKeys", () => {
  it("keeps only valid ids", () => {
    expect(pruneKeys({ a: "1", b: "2", c: "3" }, ["a", "c"])).toEqual({ a: "1", c: "3" });
  });

  it("accepts a Set and tolerates missing input", () => {
    expect(pruneKeys({ a: "1" }, new Set(["a"]))).toEqual({ a: "1" });
    expect(pruneKeys(null, [])).toEqual({});
  });
});
