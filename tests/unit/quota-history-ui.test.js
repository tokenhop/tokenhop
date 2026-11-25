import { describe, expect, it } from "vitest";
import { attachQuotaHistory } from "@/app/(dashboard)/dashboard/quota/lib/quotaForecastJoin.js";
import { buildCachedQuotaEntry } from "@/app/(dashboard)/dashboard/quota/lib/quotaSnapshotRows.js";
import { buildSparklineGeometry } from "@/shared/utils/quotaSparkline.js";

const T0 = Date.UTC(2026, 10, 15, 0, 0, 0);
const DAY = 24 * 3_600_000;

describe("attachQuotaHistory", () => {
  it("joins history series by quotaType, modelKey, name, and Antigravity grouped fallback", () => {
    const sessionPts = [
      { ts: T0, usedPct: 10 },
      { ts: T0 + DAY, usedPct: 40 },
    ];
    const geminiProPts = [
      { ts: T0, usedPct: 20 },
      { ts: T0 + DAY, usedPct: 80 },
    ];
    const geminiFlashPts = [
      { ts: T0, usedPct: 5 },
      { ts: T0 + DAY, usedPct: 15 },
    ];

    const rows = [
      { name: "5h", quotaType: "session" },
      { name: "Gemini (Flash / Pro)", modelKey: "gemini" },
      { name: "Unlimited row", unlimited: true },
      { name: "Credits", isCreditBalance: true },
    ];

    const joined = attachQuotaHistory(rows, {
      session: sessionPts,
      "gemini-2.5-pro": geminiProPts,
      "gemini-2.5-flash": geminiFlashPts,
    });

    expect(joined[0].history).toEqual(sessionPts);
    // Antigravity grouped row picks highest-used gemini-* series
    expect(joined[1].history).toEqual(geminiProPts);
    expect(joined[2].history).toBeNull();
    expect(joined[3].history).toBeNull();
  });

  it("returns null history cleanly when history map is missing or invalid", () => {
    expect(attachQuotaHistory([{ name: "5h" }], null)).toEqual([{ name: "5h", history: null }]);
    expect(attachQuotaHistory([{ name: "5h" }], [])).toEqual([{ name: "5h", history: null }]);
  });
});

describe("buildSparklineGeometry", () => {
  it("returns null for fewer than 2 valid points", () => {
    expect(buildSparklineGeometry(null)).toBeNull();
    expect(buildSparklineGeometry([])).toBeNull();
    expect(buildSparklineGeometry([{ ts: T0, usedPct: 20 }])).toBeNull();
    expect(
      buildSparklineGeometry([
        { ts: T0, usedPct: 20 },
        { ts: NaN, usedPct: 40 },
      ]),
    ).toBeNull();
  });

  it("maps 0..100% used onto fixed vertical coordinates and proportional timestamps", () => {
    const geom = buildSparklineGeometry([
      { ts: T0, usedPct: 0 },
      { ts: T0 + 2 * DAY, usedPct: 50 },
      { ts: T0 + 4 * DAY, usedPct: 100 },
    ]);

    expect(geom).not.toBeNull();
    // viewBox 100x20 with PAD_Y=2 => y=18 for 0%, y=10 for 50%, y=2 for 100%
    expect(geom.linePoints).toBe("0,18 50,10 100,2");
    expect(geom.areaPoints).toBe("0,18 0,18 50,10 100,2 100,18");
    expect(geom).toMatchObject({
      minPct: 0,
      maxPct: 100,
      latestPct: 100,
      count: 3,
    });
  });

  it("handles equal timestamps without NaN and clamps out-of-range percentages", () => {
    const geom = buildSparklineGeometry([
      { ts: T0, usedPct: -10 },
      { ts: T0, usedPct: 140 },
    ]);
    expect(geom.linePoints).toBe("0,18 100,2");
    expect(geom.minPct).toBe(0);
    expect(geom.maxPct).toBe(100);
  });
});

describe("buildCachedQuotaEntry", () => {
  const payload = {
    cached: true,
    quotaSnapshot: {
      windows: [
        { kind: "5h", usedFraction: 0.4, resetsAt: "2026-11-24T10:00:00.000Z" },
        { kind: "model:gemini-2.5-pro", usedFraction: 1.4, resetsAt: null },
        { kind: "bad", usedFraction: "x" },
      ],
      updatedAt: "2026-11-24T08:00:00.000Z",
      stale: false,
    },
    forecasts: {},
    history: {
      "5h": [
        { ts: T0, usedPct: 10 },
        { ts: T0 + DAY, usedPct: 40 },
      ],
    },
  };

  it("maps snapshot windows to display rows with history attached", () => {
    const entry = buildCachedQuotaEntry(payload);
    expect(entry.updatedAt).toBe("2026-11-24T08:00:00.000Z");
    expect(entry.stale).toBe(false);
    expect(entry.quotas).toHaveLength(2);
    expect(entry.quotas[0]).toMatchObject({ name: "5h", used: 40, total: 100 });
    expect(entry.quotas[0].history).toHaveLength(2);
    expect(entry.quotas[1]).toMatchObject({ name: "gemini-2.5-pro", used: 100, resetAt: null });
  });

  it("rejects live, empty or missing payloads", () => {
    expect(buildCachedQuotaEntry(null)).toBeNull();
    expect(buildCachedQuotaEntry({ ...payload, cached: undefined })).toBeNull();
    expect(buildCachedQuotaEntry({ cached: true, quotaSnapshot: null })).toBeNull();
    expect(buildCachedQuotaEntry({ cached: true, quotaSnapshot: { windows: [] } })).toBeNull();
  });
});
