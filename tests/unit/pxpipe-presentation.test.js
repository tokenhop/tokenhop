import { describe, expect, it } from "vitest";
import {
  formatTokens,
  formatUptime,
  localizePxpipeTimeline,
  reasonLabel,
  statusLabel,
} from "@/app/(dashboard)/dashboard/pxpipe/pxpipePresentation";

describe("pxpipePresentation", () => {
  it("formats token counts", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1500)).toBe("1.5K");
    expect(formatTokens(2500000)).toBe("2.50M");
  });

  it("formats uptime", () => {
    expect(formatUptime(0)).toBe("—");
    expect(formatUptime(-5)).toBe("—");
    expect(formatUptime(5 * 60000)).toBe("5m");
    expect(formatUptime(130 * 60000)).toBe("2h10m");
  });

  it("resolves status labels", () => {
    expect(statusLabel(null, null)).toBe("—");
    expect(statusLabel({ installed: false }, null)).toBe("Not installed");
    expect(statusLabel({ installed: true, running: true }, { healthy: true })).toBe("Healthy");
    expect(statusLabel({ installed: true, running: true }, { healthy: false })).toBe("Running");
    expect(statusLabel({ installed: true, running: false }, null)).toBe("Stopped");
  });

  it("maps skip reasons, falling back to raw", () => {
    expect(reasonLabel("timeout")).toBe("Compression timed out");
    expect(reasonLabel("weird_future")).toBe("weird_future");
  });

  it("localizes PXPIPE timeline bucket dates using bucket bounds", () => {
    const now = new Date(2026, 9, 15, 12);
    const timeline = [
      { date: "2026-10-03", tokensSavedEst: 500, compressed: 2, requests: 3 },
      { date: "2026-10-04", tokensSavedEst: 0, compressed: 0, requests: 0 },
    ];
    const de = localizePxpipeTimeline(timeline, "de", now);
    expect(de[0]).toMatchObject({
      date: "2026-10-03",
      grain: "day",
      start: "2026-10-03",
      tokensSavedEst: 500,
      compressed: 2,
      requests: 3,
      label: new Intl.DateTimeFormat("de", { month: "short", day: "numeric" }).format(
        new Date(2026, 9, 3),
      ),
    });
    expect(localizePxpipeTimeline(timeline, "en-US", now).map((r) => r.label)).toEqual([
      "Oct 3",
      "Oct 4",
    ]);
    // Year appears when the timeline spans New Year or lies outside the current year.
    const acrossYear = localizePxpipeTimeline(
      [
        { date: "2025-12-31", tokensSavedEst: 10 },
        { date: "2026-01-01", tokensSavedEst: 20 },
      ],
      "en-US",
      now,
    );
    expect(acrossYear.map((r) => r.label)).toEqual(["Dec 31, 2025", "Jan 1, 2026"]);
    // Safely handles empty/null inputs and malformed dates.
    expect(localizePxpipeTimeline(null, "en-US", now)).toEqual([]);
    expect(localizePxpipeTimeline([], "en-US", now)).toEqual([]);
    expect(localizePxpipeTimeline({}, "en-US", now)).toEqual([]);
    expect(
      localizePxpipeTimeline(
        [{ date: "" }, { date: "not-a-date" }, { date: "2026-02-30" }],
        "de",
        now,
      ),
    ).toMatchObject([{ label: "" }, { label: "not-a-date" }, { label: "2026-02-30" }]);
    expect(localizePxpipeTimeline([{ date: "2026-11-24" }], "@@", now)).toEqual(
      localizePxpipeTimeline([{ date: "2026-11-24" }], "en", now),
    );
  });
});
