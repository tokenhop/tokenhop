// YAN-425: exportWindow time math — named day-grain periods align with the
// rollup cutoff, custom ranges use inclusive local-day bounds, `all` is open.
import { describe, expect, it } from "vitest";
import { exportWindow } from "@/lib/usage/exportWindow.js";
import { cutoffDateKey, localDateKey } from "@/lib/db/repos/usageRollupRepo.js";
import { periodStart } from "@/shared/utils/period.js";

const NOW = new Date(2026, 9, 26, 12, 34, 56).getTime(); // local noon

describe("exportWindow", () => {
  it("7d history start is local midnight of cutoffDateKey(7), rollup matches", () => {
    const w = exportWindow("7d", null, NOW);
    const from = cutoffDateKey(7, NOW);
    const [y, m, d] = from.split("-").map(Number);
    expect(w.history.startMs).toBe(new Date(y, m - 1, d).getTime());
    expect(w.history.startMs).toBe(periodStart("7d", NOW));
    expect(w.rollup).toEqual({ fromKey: from, toKey: localDateKey(new Date(NOW)) });
    expect(w.history.nowMs).toBe(NOW);
  });

  it("honours `now` for the cutoff (not the wall clock)", () => {
    const past = new Date(2020, 0, 15, 12).getTime();
    expect(exportWindow("30d", null, past).rollup.fromKey).toBe(cutoffDateKey(30, past));
    expect(exportWindow("30d", null, past).rollup.fromKey).not.toBe(cutoffDateKey(30, NOW));
  });

  it("custom end bound is the last millisecond of the `to` local day", () => {
    const w = exportWindow("custom", { from: "2026-10-01", to: "2026-10-03" }, NOW);
    expect(w.history.startMs).toBe(new Date(2026, 9, 1).getTime());
    expect(w.history.nowMs).toBe(new Date(2026, 9, 4).getTime() - 1);
    const end = new Date(w.history.nowMs);
    expect([end.getHours(), end.getMinutes(), end.getSeconds(), end.getMilliseconds()]).toEqual([
      23, 59, 59, 999,
    ]);
    expect(w.rollup).toEqual({ fromKey: "2026-10-01", toKey: "2026-10-03" });
  });

  it("all has a null history start and an open rollup start", () => {
    const w = exportWindow("all", null, NOW);
    expect(w.history).toEqual({ startMs: null, nowMs: NOW });
    expect(w.rollup.fromKey).toBeNull();
  });

  it("today/24h use periodStart", () => {
    expect(exportWindow("today", null, NOW).history.startMs).toBe(periodStart("today", NOW));
    expect(exportWindow("24h", null, NOW).history.startMs).toBe(NOW - 24 * 3600 * 1000);
  });
});
