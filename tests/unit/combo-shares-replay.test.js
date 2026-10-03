import { describe, expect, it, vi } from "vitest";
import { comboShares, effectiveComboWeight } from "../../open-sse/services/comboWeights.js";
import {
  explainWeightedShares,
  shareDetailText,
} from "../../src/shared/components/combos/comboBuilder.js";
import { METER_FILLS } from "../../src/shared/components/displayPrimitives.js";
import { probeTrackEvents } from "../../src/shared/components/combos/routeTestFormat.js";

describe("effective weighted shares (router math)", () => {
  it("effective weight = configured weight × remaining quota, router defaults", () => {
    const weights = { a: 1, b: 1, c: 0 };
    expect(effectiveComboWeight("a", weights, 0.2)).toBe(0.2);
    // missing/invalid quota data stays fail-open (full quota)
    expect(effectiveComboWeight("b", weights, NaN)).toBe(1);
    expect(effectiveComboWeight("b", weights, null)).toBe(1);
    expect(effectiveComboWeight("b", weights, -0.5)).toBe(1);
    // weight 0 stays fallback-only; negative weights default to 1
    expect(effectiveComboWeight("c", weights, 1)).toBe(0);
    expect(effectiveComboWeight("a", { a: -1 }, 1)).toBe(1);
  });

  it("shares equal weights unequally once quota shifts, and dedupe duplicates", () => {
    expect(comboShares(["a", "b", "c"], { a: 1, b: 1, c: 0 }, { a: 0.2 })).toEqual([16.7, 83.3, 0]);
    // duplicate rows show the same per-model share (router dedupes candidates)
    expect(comboShares(["a", "b", "a"], { a: 1, b: 1 }, {})).toEqual([50, 50, 50]);
    // all-zero (weights or quota) means plain fallback: no shares at all
    expect(comboShares(["a", "b"], { a: 0, b: 0 }, {})).toEqual([0, 0]);
    expect(comboShares(["a", "b"], { a: 1, b: 1 }, { a: 0, b: 0 })).toEqual([0, 0]);
  });

  it("explanation exposes configured weight, effective share and quota source", () => {
    const out = explainWeightedShares(
      ["a", "b", "c", "d"],
      { a: 1, b: 1, c: 0, d: 2 },
      { a: 0.2, b: 1, d: 0 },
      { a: "header", d: "probe" },
    );
    expect(out[0]).toMatchObject({ base: 1, quota: 0.2, quotaSource: "header", share: 16.7 });
    expect(out[1]).toMatchObject({ base: 1, quota: 1, quotaSource: "static", share: 83.3 });
    expect(out[2].fallbackOnly).toBe(true);
    expect(out[3]).toMatchObject({ outOfQuota: true, quotaSource: "probe", share: 0 });
  });

  it("writes fallback-only, exhausted and split explanation copy", () => {
    const [fallbackOnly, exhausted, split] = explainWeightedShares(
      ["c", "d", "a"],
      { c: 0, d: 2, a: 1 },
      { d: 0, a: 0.4 },
      { a: "probe" },
    );
    expect(shareDetailText(fallbackOnly)).toBe(
      "Weight 0 — fallback only: no traffic until the others fail.",
    );
    expect(shareDetailText(exhausted)).toBe(
      "No quota left (no quota data yet) — paused until quota resets.",
    );
    expect(shareDetailText(split)).toBe(
      `Weight 1 × 40% quota left (from the last quota probe) → about ${split.share}% of traffic.`,
    );
    expect(shareDetailText(null)).toBeNull();
  });

  it("renders weighted shares through the brand (coral) meter fill", () => {
    expect(METER_FILLS.brand).toBe("bg-coral");
    expect(METER_FILLS.neutral).toBe("bg-subtle");
    expect(METER_FILLS.ok).toBe("bg-ok");
  });
});

describe("combo headroom quota source (additive API)", () => {
  it("GET /api/combos/[id]/headroom keeps `headroom` and adds per-member detail", async () => {
    vi.resetModules();
    vi.doMock("@/lib/localDb", () => ({
      getComboById: async () => ({ id: "c1", name: "combo", models: ["cc/a", "cx/b"] }),
    }));
    vi.doMock("@/sse/services/comboHeadroom.js", () => ({
      loadComboHeadroomDetailFn: async () => (model) =>
        model === "cc/a" ? { headroom: 0.2, source: "header" } : { headroom: 1, source: "static" },
    }));
    const { GET } = await import("../../src/app/api/combos/[id]/headroom/route.js");
    const res = await GET({}, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.headroom).toEqual({ "cc/a": 0.2, "cx/b": 1 });
    expect(json.quotaByModel).toEqual({
      "cc/a": { headroom: 0.2, source: "header" },
      "cx/b": { headroom: 1, source: "static" },
    });
    vi.doUnmock("@/sse/services/comboHeadroom.js");
    vi.doUnmock("@/lib/localDb");
  });

  it("loadComboHeadroomFn keeps returning numbers with the same fail-open rules", async () => {
    const { loadComboHeadroomDetailFn, loadComboHeadroomFn } = await import(
      "../../src/sse/services/comboHeadroom.js"
    );
    const deps = {
      getProviderConnectionsUnscoped: async () => [{ id: "conn-1", provider: "p" }],
    };
    const detail = await loadComboHeadroomDetailFn(deps);
    expect(detail("p/model")).toEqual({ headroom: 1, source: "static" });
    expect(detail(null)).toEqual({ headroom: 1, source: "static" });
    const headroom = await loadComboHeadroomFn(deps);
    expect(headroom("p/model")).toBe(1);
  });
});

describe("probe route-track replay", () => {
  it.each(["fallback", "round-robin", "weighted", "fusion"])(
    "maps %s attempts by model occurrence: attempted→sky, failed/skipped→warn, answered→lime",
    (strategy) => {
      const events = probeTrackEvents(
        ["a", "b", "a"],
        [
          { model: "b", outcome: "skipped", status: 429, errorType: "rate limited" },
          {
            model: "a",
            outcome: "answered",
            status: 200,
            role: strategy === "fusion" ? "panel" : "route",
          },
          {
            model: "a",
            outcome: "served",
            status: 200,
            role: strategy === "fusion" ? "judge" : "route",
          },
        ],
      );
      expect(events.map((event) => event.index)).toEqual([1, 0, 2]);
      expect(events.map((event) => event.tone)).toEqual(["warn", "live", "live"]);
      expect(events[0].state).toBe("skipped");
      expect(events[0].text).toContain("rate limited");
      // the panel renders `event.latency` directly — it must never be "—"
      expect(events[0].latency).toBe("—");
      expect(events[1].latency).toBe("—");
      expect(events[1].state).toBe("answered");
      const withLatency = probeTrackEvents(
        ["a"],
        [{ model: "a", outcome: "served", status: 200, latencyMs: 1250 }],
      );
      expect(withLatency[0].latency).toBe("1.25s");
    },
  );

  it("lights the outer step for nested-combo attempts and keeps text for the timeline", () => {
    const events = probeTrackEvents(
      ["nested", "a"],
      [
        { model: "a", via: "nested", role: "nested", outcome: "served", status: 200 },
        { model: "a", outcome: "skipped", status: 429, errorType: "rate limited" },
      ],
    );
    // the inner member "a" served *as part of* nested → the nested step lights;
    // the outer "a" step maps by its own model
    expect(events.map((event) => event.index)).toEqual([0, 1]);
    expect(events[0].tone).toBe("live");
    expect(events[0].text).toContain("a");
    // attempts that match neither a track model nor a track combo stay timeline-only
    const orphan = probeTrackEvents(
      ["a"],
      [{ model: "judge/x", role: "judge", outcome: "served", status: 200 }],
    );
    expect(orphan[0].index).toBeNull();
    expect(orphan[0].tone).toBe("live");
  });
});
