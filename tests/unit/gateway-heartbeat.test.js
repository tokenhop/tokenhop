// Gateway heartbeat (YAN-408): 15-bucket req/min series for the sidebar
// sparkline, and the pulse-duration mapping from live traffic.
import { describe, it, expect, beforeAll } from "vitest";

import {
  buildMinuteBuckets,
  pulseDurationMs,
  HEARTBEAT_BUCKETS,
} from "../../src/lib/gatewayStatus.js";

const MIN = 60_000;

describe("buildMinuteBuckets", () => {
  const now = Date.parse("2026-09-27T12:15:00.000Z");

  it("returns 15 zero buckets for no timestamps", () => {
    expect(buildMinuteBuckets([], now)).toEqual(Array(15).fill(0));
    expect(buildMinuteBuckets(undefined, now)).toEqual(Array(15).fill(0));
  });

  it("drops timestamps outside the 15-minute window", () => {
    const series = buildMinuteBuckets(
      [new Date(now - 16 * MIN).toISOString(), new Date(now + 5_000).toISOString()],
      now,
    );
    expect(series).toEqual(Array(15).fill(0));
  });

  it("assigns each timestamp to its minute bucket, oldest first", () => {
    const stamps = [
      new Date(now - 14.5 * MIN).toISOString(), // bucket 0
      new Date(now - 14 * MIN).toISOString(), // bucket 1
      new Date(now - 3 * MIN).toISOString(), // bucket 12
      new Date(now - 1_000).toISOString(), // newest minute → bucket 14
      new Date(now - 1_000).toISOString(), // same minute again
    ];
    const series = buildMinuteBuckets(stamps, now);
    expect(series).toHaveLength(HEARTBEAT_BUCKETS);
    expect(series).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2]);
  });

  it("ignores unparsable timestamps", () => {
    const series = buildMinuteBuckets(["not-a-date", null, new Date(now).toISOString()], now);
    expect(series.reduce((a, b) => a + b, 0)).toBe(1);
  });
});

describe("pulseDurationMs", () => {
  it("maps idle traffic to the slow pulse", () => {
    expect(pulseDurationMs(0)).toBe(2400);
    expect(pulseDurationMs(null)).toBe(2400);
    expect(pulseDurationMs(-5)).toBe(2400);
  });

  it("maps busy traffic to the fast pulse and clamps there", () => {
    expect(pulseDurationMs(60)).toBe(900);
    expect(pulseDurationMs(600)).toBe(900);
  });

  it("interpolates linearly in between", () => {
    expect(pulseDurationMs(30)).toBe(1650);
  });
});

describe("getRequestRateSeries", () => {
  let db;

  beforeAll(async () => {
    db = await import("@/lib/db/index.js");
    await db.initDb?.();
  });

  it("returns all zeros on an empty window without extra requests", async () => {
    const series = await db.getRequestRateSeries();
    expect(series).toEqual(Array(HEARTBEAT_BUCKETS).fill(0));
  });

  it("counts seeded usage rows into the live 15-minute series", async () => {
    const now = Date.now();
    const stamps = [
      now - 30_000, // newest bucket
      now - 30_000,
      now - 90_000, // one bucket back
      now - 10 * MIN, // ten minutes old → bucket 4
      now - 20 * MIN, // outside the window
    ];
    for (const ts of stamps) {
      await db.saveRequestUsage({
        provider: "openai",
        model: "gpt-4",
        tokens: { prompt_tokens: 10, completion_tokens: 5 },
        endpoint: "/v1/chat",
        status: "ok",
        timestamp: new Date(ts).toISOString(),
      });
    }
    const series = await db.getRequestRateSeries();
    expect(series).toHaveLength(HEARTBEAT_BUCKETS);
    expect(series[14]).toBe(2);
    expect(series[13]).toBe(1);
    expect(series[4]).toBe(1);
    expect(series.reduce((a, b) => a + b, 0)).toBe(4);
  });
});
