import { describe, expect, it } from "vitest";
import {
  getAccountStatus,
  getBulkActionTargets,
  getHealthBucket,
  getSoonestReset,
  getWorstForecast,
  summarizeQuotaHealth,
} from "@/app/(dashboard)/dashboard/quota/quotaSummary.js";
import { sortVisibleConnections } from "@/app/(dashboard)/dashboard/quota/lib/quotaUtils.js";
import { attachForecasts } from "@/app/(dashboard)/dashboard/quota/lib/quotaForecastJoin.js";

const quota = (remaining, resetAt = null) => ({
  name: "Window",
  used: 100 - remaining,
  total: 100,
  remaining,
  resetAt,
});

const at = (iso) => iso;

describe("getHealthBucket", () => {
  it("buckets healthy above 45", () => {
    expect(getHealthBucket(46)).toBe("healthy");
    expect(getHealthBucket(100)).toBe("healthy");
  });
  it("buckets running low from 1 to 45", () => {
    expect(getHealthBucket(1)).toBe("low");
    expect(getHealthBucket(20)).toBe("low");
    expect(getHealthBucket(45)).toBe("low");
  });
  it("buckets zero as empty", () => {
    expect(getHealthBucket(0)).toBe("empty");
  });
  it("clamps out-of-range values", () => {
    expect(getHealthBucket(-5)).toBe("empty");
    expect(getHealthBucket(120)).toBe("healthy");
  });
});

describe("summarizeQuotaHealth", () => {
  it("counts buckets by each account's worst quota", () => {
    const summary = summarizeQuotaHealth([
      { id: "a", quotas: [quota(80), quota(10)] },
      { id: "b", quotas: [quota(90)] },
      { id: "c", quotas: [quota(0)] },
    ]);
    expect(summary).toEqual({ healthy: 1, low: 1, empty: 1, total: 3 });
  });
  it("skips unlimited and credit-only accounts", () => {
    const summary = summarizeQuotaHealth([
      { id: "a", quotas: [{ name: "Chat", used: 5, total: 0, unlimited: true }] },
      {
        id: "b",
        quotas: [{ name: "Credits", used: 0, total: 12.4, isCreditBalance: true }],
      },
      { id: "c", quotas: [] },
    ]);
    expect(summary).toEqual({ healthy: 0, low: 0, empty: 0, total: 0 });
  });
  it("prefers the explicit remaining field over used/total", () => {
    const summary = summarizeQuotaHealth([
      { id: "a", quotas: [{ name: "W", used: 0, total: 100, remaining: 30 }] },
    ]);
    expect(summary).toEqual({ healthy: 0, low: 1, empty: 0, total: 1 });
  });
});

describe("getSoonestReset", () => {
  const now = Date.parse("2026-09-26T08:00:00Z");
  it("names the soonest-resetting account", () => {
    const soonest = getSoonestReset(
      [
        { id: "a", label: "Work" },
        { id: "b", label: "Personal" },
      ],
      {
        a: { quotas: [quota(50, at("2026-09-26T14:00:00Z"))] },
        b: { quotas: [quota(10, at("2026-09-26T10:00:00Z"))] },
      },
      now,
    );
    expect(soonest).toEqual({
      connectionId: "b",
      label: "Personal",
      resetAt: at("2026-09-26T10:00:00Z"),
    });
  });
  it("returns null when nothing has a future reset", () => {
    expect(getSoonestReset([{ id: "a", label: "Work" }], {}, now)).toBeNull();
    expect(
      getSoonestReset([{ id: "a", label: "Work" }], { a: { quotas: [quota(50)] } }, now),
    ).toBeNull();
  });
  it("rejects non-finite bucket input instead of guessing", () => {
    expect(() => getHealthBucket(Number.NaN)).toThrow();
  });
});

describe("expiring-first sort", () => {
  const connections = [
    { id: "a", provider: "codex", name: "Late" },
    { id: "b", provider: "claude", name: "Soon" },
    { id: "c", provider: "gemini", name: "NoReset" },
  ];
  const quotaData = {
    a: { quotas: [quota(50, at("2026-09-27T10:00:00Z"))] },
    b: { quotas: [quota(10, at("2026-09-26T10:00:00Z"))] },
    c: { quotas: [quota(80)] },
  };
  it("orders by earliest reset, reset-less accounts last", () => {
    const sorted = sortVisibleConnections(connections, quotaData, true, "all", "default");
    expect(sorted.map((c) => c.id)).toEqual(["b", "a", "c"]);
  });
});

describe("getAccountStatus", () => {
  it.each([
    [{ isActive: true, quotas: [quota(80)] }, "Active", "ok"],
    [{ isActive: true, quotas: [quota(30)] }, "Running low", "warn"],
    [{ isActive: true, quotas: [quota(0)] }, "Empty", "err"],
    [{ isActive: false, quotas: [quota(0)] }, "Turned off · empty", "neutral"],
    [{ isActive: false, quotas: [quota(70)] }, "Turned off", "neutral"],
    [{ isActive: true, quotas: [], error: "HTTP 500" }, "Error", "err"],
    [{ isActive: true, quotas: [], loading: true }, "Checking", "neutral"],
    [{ isActive: true, quotas: [] }, "No data", "neutral"],
    [
      { isActive: true, quotas: [{ name: "Chat", used: 1, total: 0, unlimited: true }] },
      "Active",
      "ok",
    ],
  ])("maps %o to %s", (account, label, variant) => {
    expect(getAccountStatus(account)).toEqual({ label, variant });
  });
});

describe("getBulkActionTargets", () => {
  const connections = [
    { id: "on-full", isActive: true },
    { id: "on-empty", isActive: true },
    { id: "off-empty", isActive: false },
    { id: "off-available", isActive: false },
  ];
  const quotaData = {
    "on-full": { quotas: [quota(80)] },
    "on-empty": { quotas: [quota(0)] },
    "off-empty": { quotas: [quota(0)] },
    "off-available": { quotas: [quota(60)] },
  };
  it("turns off only active empty accounts", () => {
    expect(getBulkActionTargets(connections, quotaData, "off")).toEqual(["on-empty"]);
  });
  it("turns on only inactive accounts with quota left", () => {
    expect(getBulkActionTargets(connections, quotaData, "on")).toEqual(["off-available"]);
  });
  it("returns empty lists when nothing matches", () => {
    expect(getBulkActionTargets([], {}, "off")).toEqual([]);
    expect(getBulkActionTargets([], {}, "on")).toEqual([]);
  });
});

describe("attachForecasts", () => {
  const rows = [
    { name: "5h limit", quotaType: "5h", remaining: 40 },
    { name: "Gemini 2.5 Pro", modelKey: "gemini-2.5-pro", remaining: 80 },
    { name: "Legacy window", remaining: 50 },
    { name: "Chat", remaining: 100, unlimited: true },
    { name: "Credits", remaining: 90, isCreditBalance: true },
  ];
  const forecasts = { "5h": { state: "tight" }, "gemini-2.5-pro": { state: "on-track" } };

  it("joins forecasts by quotaType, then modelKey, then name", () => {
    const attached = attachForecasts(rows, forecasts);
    expect(attached[0].forecast).toEqual({ state: "tight" });
    expect(attached[1].forecast).toEqual({ state: "on-track" });
    expect(attached[2].forecast).toBeNull();
  });

  it("never forecasts unlimited or credit rows", () => {
    const attached = attachForecasts(rows, {
      Chat: { state: "idle" },
      Credits: { state: "idle" },
    });
    expect(attached[3].forecast).toBeNull();
    expect(attached[4].forecast).toBeNull();
  });

  it("ignores a malformed forecasts payload", () => {
    expect(attachForecasts(rows, "oops").every((row) => row.forecast === null)).toBe(true);
    expect(attachForecasts(rows, null).every((row) => row.forecast === null)).toBe(true);
    expect(attachForecasts(null, forecasts)).toEqual([]);
  });
});

describe("getWorstForecast", () => {
  const NOW = Date.parse("2026-09-26T12:00:00Z");
  const iso = (hours) => new Date(NOW + hours * 3600_000).toISOString();
  const forecastAt = (state, hours) => ({
    state,
    reason: null,
    remainingPct: 20,
    burnPctPerHour: 4.2,
    emptyAt: state === "will-run-out" || state === "tight" ? iso(hours) : null,
    resetAt: iso(42),
    sampleCount: 12,
    sampleSpanMs: 58 * 60_000,
  });
  const connections = [
    { id: "a", provider: "claude", name: "Claude Work" },
    { id: "b", provider: "codex", name: "Codex Main" },
  ];

  it("labels the most urgent forecast as 'Account · Window'", () => {
    const quotaData = {
      a: {
        quotas: [quota(20, null), { ...quota(20, null), forecast: forecastAt("on-track", 9) }],
      },
      b: {
        quotas: [{ ...quota(15, null), name: "5h limit", forecast: forecastAt("will-run-out", 6) }],
      },
    };
    const { best, hasForecasts } = getWorstForecast(connections, quotaData);
    expect(hasForecasts).toBe(true);
    expect(best.label).toBe("Codex Main · 5h limit");
    expect(best.forecast.state).toBe("will-run-out");
  });

  it("ignores unknown forecasts and unlimited/credit rows", () => {
    const quotaData = {
      a: {
        quotas: [
          { name: "Chat", unlimited: true, forecast: forecastAt("will-run-out", 1) },
          { name: "Credits", isCreditBalance: true, forecast: forecastAt("tight", 2) },
          { ...quota(10, null), forecast: { state: "unknown" } },
        ],
      },
    };
    expect(getWorstForecast(connections, quotaData)).toEqual({
      best: null,
      hasForecasts: false,
    });
  });

  it("handles missing quota data", () => {
    expect(getWorstForecast(connections, {})).toEqual({ best: null, hasForecasts: false });
    expect(getWorstForecast(null, null)).toEqual({ best: null, hasForecasts: false });
  });
});
