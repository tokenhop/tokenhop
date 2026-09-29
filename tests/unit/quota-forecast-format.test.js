import { describe, it, expect } from "vitest";
import {
  describeForecast,
  formatApproxDuration,
  worstForecast,
} from "@/shared/utils/quotaForecast.js";

const NOW = new Date("2026-09-26T12:00:00Z").getTime();
const iso = (ms) => new Date(ms).toISOString();

function forecast(overrides = {}) {
  return {
    state: "will-run-out",
    reason: null,
    remainingPct: 20,
    burnPctPerHour: 4.2,
    emptyAt: iso(NOW + 9 * 3600_000),
    resetAt: iso(NOW + 42 * 3600_000),
    sampleCount: 12,
    sampleSpanMs: 58 * 60_000,
    ...overrides,
  };
}

describe("formatApproxDuration", () => {
  it("returns <1m below a minute and null for unusable input", () => {
    expect(formatApproxDuration(0)).toBe("<1m");
    expect(formatApproxDuration(30_000)).toBe("<1m");
    expect(formatApproxDuration(Number.NaN)).toBeNull();
    expect(formatApproxDuration(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatApproxDuration(-5)).toBeNull();
  });

  it("formats minutes and hours", () => {
    expect(formatApproxDuration(60_000)).toBe("~1m");
    expect(formatApproxDuration(45 * 60_000)).toBe("~45m");
    expect(formatApproxDuration(9 * 3600_000)).toBe("~9h");
    expect(formatApproxDuration(23.6 * 3600_000)).toBe("~24h");
  });

  it("formats day ranges and drops a zero hour", () => {
    expect(formatApproxDuration(2 * 86400_000)).toBe("~2d");
    expect(formatApproxDuration(42 * 3600_000)).toBe("~1d 18h");
    expect(formatApproxDuration(41 * 3600_000)).toBe("~1d 17h");
  });

  it("formats week-plus as days only", () => {
    expect(formatApproxDuration(3 * 86400_000)).toBe("~3d");
    expect(formatApproxDuration(7 * 86400_000)).toBe("~7d");
    expect(formatApproxDuration(10 * 86400_000)).toBe("~10d");
  });
});

describe("describeForecast", () => {
  it("returns null for missing or unknown forecasts", () => {
    expect(describeForecast(null, NOW)).toBeNull();
    expect(describeForecast(undefined, NOW)).toBeNull();
    expect(describeForecast({ state: "unknown" }, NOW)).toBeNull();
  });

  it("describes will-run-out with err tone and warning icon", () => {
    const described = describeForecast(forecast(), NOW);
    expect(described).toMatchObject({
      state: "will-run-out",
      tone: "err",
      icon: "warning",
      lead: "At this pace, empty in",
      emptyIn: "~9h",
      resetsIn: "~1d 18h",
    });
    expect(described.burnRate).toBe("~4.2%/h");
    expect(described.sampleWindow).toBe("~58m");
    expect(described.resetsIn).toBe("~1d 18h");
  });

  it("describes tight with warn tone and hourglass icon", () => {
    const described = describeForecast(
      forecast({ state: "tight", emptyAt: iso(NOW + 41 * 3600_000) }),
      NOW,
    );
    expect(described).toMatchObject({
      tone: "warn",
      icon: "hourglass_top",
      lead: "Cutting it close, empty in",
      emptyIn: "~1d 17h",
    });
  });

  it("describes on-track with no empty time", () => {
    const described = describeForecast(forecast({ state: "on-track", burnPctPerHour: 1.1 }), NOW);
    expect(described).toMatchObject({
      tone: "muted",
      icon: "check_circle",
      lead: "On track",
      emptyIn: null,
    });
    expect(described.burnRate).toBe("~1.1%/h");
  });

  it("describes idle with zeroed burn and no empty time", () => {
    const described = describeForecast(
      forecast({ state: "idle", burnPctPerHour: 0.02, emptyAt: null }),
      NOW,
    );
    expect(described).toMatchObject({
      tone: "muted",
      icon: "bedtime",
      lead: "Idle lately",
      emptyIn: null,
    });
    expect(described.burnRate).toBe("~0%/h");
  });
});

describe("worstForecast", () => {
  const pick = (items) => worstForecast(items)?.label ?? null;

  it("returns null when nothing is known", () => {
    expect(worstForecast([])).toBeNull();
    expect(worstForecast(null)).toBeNull();
    expect(
      worstForecast([
        { label: "a", forecast: null },
        { label: "b", forecast: { state: "unknown" } },
      ]),
    ).toBeNull();
  });

  it("orders by urgency: will-run-out > tight > on-track > idle", () => {
    const items = [
      { label: "idle", forecast: forecast({ state: "idle" }) },
      { label: "on-track", forecast: forecast({ state: "on-track" }) },
      { label: "tight", forecast: forecast({ state: "tight" }) },
      { label: "risk", forecast: forecast({ state: "will-run-out" }) },
    ];
    expect(pick(items)).toBe("risk");
    expect(pick(items.filter((item) => item.label !== "risk"))).toBe("tight");
    expect(
      pick([
        { label: "idle", forecast: forecast({ state: "idle" }) },
        { label: "on-track", forecast: forecast({ state: "on-track" }) },
      ]),
    ).toBe("on-track");
  });

  it("breaks urgency ties by earliest emptyAt", () => {
    expect(
      pick([
        { label: "later", forecast: forecast({ emptyAt: iso(NOW + 12 * 3600_000) }) },
        { label: "sooner", forecast: forecast({ emptyAt: iso(NOW + 6 * 3600_000) }) },
      ]),
    ).toBe("sooner");
  });
});
