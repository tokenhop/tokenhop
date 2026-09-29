import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDLE_PCT_PER_HOUR,
  LOOKBACK_MS,
  MIN_SAMPLES,
  MIN_SPAN_MS,
  SKEW_TOLERANCE_MS,
  computeForecast,
} from "@/lib/quota/forecast.js";
import {
  MAX_KEYS,
  MAX_SAMPLES,
  _resetQuotaForecastStore,
  getQuotaForecasts,
  pickUrgentForecast,
  recordQuotaSample,
} from "@/lib/quota/forecastStore.js";

const NOW = Date.UTC(2026, 8, 24, 18, 0, 0);
const HOUR = 3_600_000;
const MIN = 60_000;

beforeEach(() => {
  _resetQuotaForecastStore();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  _resetQuotaForecastStore();
});

/** Linear decline: remaining from `from` to `to` over `spanMs` ending at NOW. */
function series(from, to, n, spanMs, resetAt) {
  return Array.from({ length: n }, (_, i) => ({
    t: NOW - spanMs + (spanMs * i) / (n - 1),
    remaining: from + ((to - from) * i) / (n - 1),
  })).map((s) => ({ ...s, resetAt }));
}

describe("computeForecast slope", () => {
  it("recovers the burn rate of a linear decline", () => {
    // 100 → 70 over 1h = 30%/h; reset 3h out so time-to-empty (2.33h) hits will-run-out.
    const f = computeForecast(series(100, 70, 5, HOUR), { resetAt: NOW + 3 * HOUR, now: NOW });
    expect(f.state).toBe("will-run-out");
    expect(f.burnPctPerHour).toBeCloseTo(30, 0);
    expect(f.emptyAt).toBe(new Date(NOW + (70 / 30) * HOUR).toISOString());
    expect(f.resetAt).toBe(new Date(NOW + 3 * HOUR).toISOString());
    expect(f.remainingPct).toBe(70);
    expect(f.sampleCount).toBe(5);
    expect(f.sampleSpanMs).toBe(HOUR);
  });
});

describe("computeForecast states", () => {
  it("on-track when empty lands past reset", () => {
    // 100 → 95 over 1h = 5%/h; empty in 19h, reset in 2h.
    const f = computeForecast(series(100, 95, 4, HOUR), { resetAt: NOW + 2 * HOUR, now: NOW });
    expect(f.state).toBe("on-track");
    expect(f.reason).toBeNull();
    expect(f.burnPctPerHour).toBeCloseTo(5, 0);
    expect(Math.abs(Date.parse(f.emptyAt) - (NOW + 19 * HOUR))).toBeLessThan(60_000);
  });

  it("tight when empty lands just past reset", () => {
    // 5%/h burn, 95 left → empty in 19h; reset in 18h (within 10% margin).
    const f = computeForecast(series(100, 95, 4, HOUR), { resetAt: NOW + 18 * HOUR, now: NOW });
    expect(f.state).toBe("tight");
  });

  it("will-run-out when empty lands before reset", () => {
    const f = computeForecast(series(100, 95, 4, HOUR), { resetAt: NOW + 20 * HOUR, now: NOW });
    expect(f.state).toBe("will-run-out");
  });

  it("idle when burn is at/below the idle threshold", () => {
    const flat = series(80, 80, 4, HOUR);
    const f = computeForecast(flat, { resetAt: NOW + 5 * HOUR, now: NOW });
    expect(f.state).toBe("idle");
    expect(f.emptyAt).toBeNull();
  });

  it("unknown/empty when latest remaining is zero", () => {
    const f = computeForecast(series(50, 0, 4, HOUR), { resetAt: NOW + HOUR, now: NOW });
    expect(f).toMatchObject({ state: "unknown", reason: "empty", remainingPct: 0 });
  });

  it("unknown/no-reset without resetAt", () => {
    const f = computeForecast(series(100, 70, 4, HOUR), { resetAt: null, now: NOW });
    expect(f).toMatchObject({ state: "unknown", reason: "no-reset", resetAt: null });
  });

  it("unknown/reset-passed when reset already passed", () => {
    const f = computeForecast(series(100, 70, 4, HOUR), { resetAt: NOW - MIN, now: NOW });
    expect(f).toMatchObject({ state: "unknown", reason: "reset-passed" });
  });

  it("unknown/insufficient-data below MIN_SAMPLES or MIN_SPAN_MS", () => {
    expect(MIN_SAMPLES).toBe(3);
    expect(MIN_SPAN_MS).toBe(10 * MIN);
    const few = computeForecast(series(100, 90, 2, HOUR), { resetAt: NOW + HOUR, now: NOW });
    expect(few).toMatchObject({ state: "unknown", reason: "insufficient-data" });
    const short = computeForecast(series(100, 90, 3, 5 * MIN), { resetAt: NOW + HOUR, now: NOW });
    expect(short).toMatchObject({ state: "unknown", reason: "insufficient-data" });
    expect(short.sampleCount).toBe(3);
  });
});

describe("computeForecast filtering", () => {
  it("drops future samples beyond skew tolerance", () => {
    const samples = [
      ...series(100, 90, 3, 30 * MIN),
      { t: NOW + SKEW_TOLERANCE_MS + 1000, remaining: 10 },
    ];
    const f = computeForecast(samples, { resetAt: NOW + HOUR, now: NOW });
    expect(f.sampleCount).toBe(3);
    expect(f.remainingPct).toBe(90);
  });

  it("drops samples outside the lookback window", () => {
    expect(LOOKBACK_MS).toBe(120 * MIN);
    const samples = [
      { t: NOW - LOOKBACK_MS - MIN, remaining: 100 },
      ...series(90, 70, 3, 30 * MIN),
    ];
    const f = computeForecast(samples, { resetAt: NOW + HOUR, now: NOW });
    expect(f.sampleCount).toBe(3);
    expect(f.sampleSpanMs).toBe(30 * MIN);
  });

  it("drops non-finite samples", () => {
    const samples = [
      { t: NOW - 30 * MIN, remaining: 100 },
      { t: Number.NaN, remaining: 90 },
      { t: NOW - 20 * MIN, remaining: Number.NaN },
      { t: NOW - 10 * MIN, remaining: 90 },
      { t: NOW, remaining: 80 },
    ];
    const f = computeForecast(samples, { resetAt: NOW + 5 * HOUR, now: NOW });
    expect(f.sampleCount).toBe(3);
  });
});

describe("forecast store", () => {
  it("builds forecasts keyed by raw quota key", () => {
    // 88 → 85 over 30 min = 6%/h; empty in ~14h, reset 5h out → on-track.
    for (let i = 0; i < 4; i++) {
      recordQuotaSample(
        "c1",
        "session (5h)",
        { remaining: 88 - i, resetAt: NOW + 5 * HOUR },
        NOW - 30 * MIN + i * 10 * MIN,
      );
    }
    const forecasts = getQuotaForecasts("c1", NOW);
    expect(Object.keys(forecasts)).toEqual(["session (5h)"]);
    expect(forecasts["session (5h)"].state).toBe("on-track");
    expect(forecasts["session (5h)"].remainingPct).toBe(85);
  });

  it("detects reset on remaining jump or resetAt move", () => {
    for (let i = 0; i < 3; i++) {
      recordQuotaSample(
        "c1",
        "5h",
        { remaining: 80 - i * 10, resetAt: NOW + 5 * HOUR },
        NOW - 30 * MIN + i * 10 * MIN,
      );
    }
    // Remaining jumps back up → history cleared.
    recordQuotaSample("c1", "5h", { remaining: 99, resetAt: NOW + 5 * HOUR }, NOW - 5 * MIN);
    let f = getQuotaForecasts("c1", NOW)["5h"];
    expect(f.sampleCount).toBe(1);
    expect(f).toMatchObject({ state: "unknown", reason: "insufficient-data" });

    // Fresh decline, then resetAt moves → history cleared again.
    recordQuotaSample("c1", "5h", { remaining: 90, resetAt: NOW + 5 * HOUR }, NOW - 4 * MIN);
    recordQuotaSample("c1", "5h", { remaining: 80, resetAt: NOW + 10 * HOUR }, NOW - 3 * MIN);
    f = getQuotaForecasts("c1", NOW)["5h"];
    expect(f.sampleCount).toBe(1);
  });

  it("dedupes sub-30s samples by replacing the last", () => {
    recordQuotaSample("c1", "5h", { remaining: 100, resetAt: NOW + HOUR }, NOW - 40 * MIN);
    recordQuotaSample("c1", "5h", { remaining: 90, resetAt: NOW + HOUR }, NOW - 30 * MIN);
    recordQuotaSample("c1", "5h", { remaining: 89, resetAt: NOW + HOUR }, NOW - 30 * MIN + 10_000);
    recordQuotaSample("c1", "5h", { remaining: 80, resetAt: NOW + HOUR }, NOW - 20 * MIN);
    const f = getQuotaForecasts("c1", NOW)["5h"];
    expect(f.sampleCount).toBe(3);
    expect(f.sampleSpanMs).toBe(20 * MIN);
  });

  it("ignores out-of-order samples", () => {
    recordQuotaSample("c1", "5h", { remaining: 100, resetAt: NOW + HOUR }, NOW - 30 * MIN);
    recordQuotaSample("c1", "5h", { remaining: 90, resetAt: NOW + HOUR }, NOW - 20 * MIN);
    recordQuotaSample("c1", "5h", { remaining: 50, resetAt: NOW + HOUR }, NOW - 40 * MIN);
    expect(getQuotaForecasts("c1", NOW)["5h"].remainingPct).toBe(90);
  });

  it("a late sample never clears history or moves resetAt", () => {
    const record = (remaining, t, resetAt = NOW + 5 * HOUR) =>
      recordQuotaSample("c1", "5h", { remaining, resetAt }, t);
    record(90, NOW - 30 * MIN);
    record(85, NOW - 20 * MIN);
    record(80, NOW - 10 * MIN);
    record(95, NOW - 25 * MIN); // stale higher remaining (would look like a reset)
    record(80, NOW - 15 * MIN, NOW + 10 * HOUR); // stale shifted resetAt
    record(75, NOW);
    const f = getQuotaForecasts("c1", NOW)["5h"];
    expect(f.sampleCount).toBe(4);
    expect(f.remainingPct).toBe(75);
    expect(f.resetAt).toBe(new Date(NOW + 5 * HOUR).toISOString());
  });

  it("bounds samples per key and keys store-wide", () => {
    const reset = new Date(NOW + HOUR).toISOString();
    // 45s spacing beats the 30s dedupe and stays inside the lookback window.
    for (let i = 0; i < MAX_SAMPLES + 10; i++) {
      recordQuotaSample(
        "c1",
        "5h",
        { remaining: 100 - i * 0.01, resetAt: reset },
        NOW - 55 * MIN + i * 45_000,
      );
    }
    expect(getQuotaForecasts("c1", NOW)["5h"].sampleCount).toBe(MAX_SAMPLES);

    for (let i = 0; i < MAX_KEYS + 5; i++) {
      recordQuotaSample(`c${i}`, "5h", { remaining: 50, resetAt: reset }, NOW - i);
    }
    let total = 0;
    for (let i = 0; i < MAX_KEYS + 5; i++) {
      total += Object.keys(getQuotaForecasts(`c${i}`, NOW)).length;
    }
    expect(total).toBeLessThanOrEqual(MAX_KEYS);
  });

  it("validates and clamps inputs", () => {
    recordQuotaSample("c1", "5h", { remaining: Number.NaN, resetAt: NOW + HOUR }, NOW);
    recordQuotaSample("c1", "5h", { remaining: 150, resetAt: NOW + HOUR }, NOW);
    expect(getQuotaForecasts("c1", NOW)["5h"].remainingPct).toBe(100);
    recordQuotaSample("", "5h", { remaining: 50, resetAt: NOW + HOUR }, NOW);
    recordQuotaSample("c1", "", { remaining: 50, resetAt: NOW + HOUR }, NOW);
    expect(Object.keys(getQuotaForecasts("c1", NOW))).toEqual(["5h"]);
    expect(getQuotaForecasts("nope", NOW)).toEqual({});
    // resetAt outside parse range → no-reset forecast, not a throw.
    recordQuotaSample("c2", "5h", { remaining: 50, resetAt: "not a date" }, NOW);
    expect(getQuotaForecasts("c2", NOW)["5h"].reason).toBe("no-reset");
  });

  it("uses IDLE threshold from the contract", () => {
    expect(IDLE_PCT_PER_HOUR).toBe(0.1);
  });
});

describe("pickUrgentForecast", () => {
  it("orders will-run-out > tight > on-track > idle, ties by earliest emptyAt", () => {
    const base = {
      reason: null,
      remainingPct: 50,
      burnPctPerHour: 5,
      resetAt: new Date(NOW + HOUR).toISOString(),
      sampleCount: 3,
      sampleSpanMs: 20 * MIN,
    };
    const forecasts = {
      a: { ...base, state: "idle", emptyAt: null },
      b: { ...base, state: "on-track", emptyAt: new Date(NOW + 5 * HOUR).toISOString() },
      c: { ...base, state: "tight", emptyAt: new Date(NOW + 2 * HOUR).toISOString() },
      d: { ...base, state: "tight", emptyAt: new Date(NOW + HOUR).toISOString() },
      e: { ...base, state: "will-run-out", emptyAt: new Date(NOW + 30 * MIN).toISOString() },
      f: { ...base, state: "unknown", reason: "insufficient-data", emptyAt: null },
    };
    expect(pickUrgentForecast(forecasts)).toMatchObject({ state: "will-run-out", window: "e" });
    const { e: _drop, ...rest } = forecasts;
    expect(pickUrgentForecast(rest)).toMatchObject({ state: "tight", window: "d" });
    const { c: _c, d: _d, ...rest2 } = rest;
    expect(pickUrgentForecast(rest2)).toMatchObject({ state: "on-track", window: "b" });
    const { b: _b, ...rest3 } = rest2;
    expect(pickUrgentForecast(rest3)).toMatchObject({ state: "idle", window: "a" });
    expect(pickUrgentForecast({ f: forecasts.f })).toBeNull();
    expect(pickUrgentForecast({})).toBeNull();
    expect(pickUrgentForecast(null)).toBeNull();
  });
});
