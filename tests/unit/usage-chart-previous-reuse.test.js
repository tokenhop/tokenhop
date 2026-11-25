// YAN-1789: Reuse /api/usage/chart previous-period series across background
// refreshes for unchanged windows instead of re-reading the previous window.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PREVIOUS_REUSE_TTL_MS,
  ROLLING_24H_DRIFT_GRACE_MS,
  canReusePrevious,
  capturePreviousSnapshot,
  isImmutablePreviousWindow,
  mergeReusedPrevious,
} from "@/app/(dashboard)/dashboard/usage/lib/chartPreviousReuse.js";
import { shapeChartSeries } from "@/app/(dashboard)/dashboard/usage/lib/usageShapes.js";

// Minimal hook runtime (same pattern as tests/unit/quota-actions-hook.test.js).
const rt = vi.hoisted(() => {
  const state = { slots: [], index: 0, pending: [] };
  const same = (a, b) =>
    !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const slot = (init) => {
    const i = state.index++;
    if (!(i in state.slots)) state.slots[i] = init();
    return [i, state.slots[i]];
  };
  const hooks = {
    useState(initial) {
      const [, s] = slot(() => {
        const s = { value: typeof initial === "function" ? initial() : initial };
        s.set = (v) => {
          s.value = typeof v === "function" ? v(s.value) : v;
        };
        return s;
      });
      return [s.value, s.set];
    },
    useRef(initial) {
      return slot(() => ({ current: initial }))[1];
    },
    useMemo(fn, deps) {
      const [, s] = slot(() => ({}));
      if (!same(s.deps, deps)) Object.assign(s, { value: fn(), deps });
      return s.value;
    },
    useCallback(fn, deps) {
      return hooks.useMemo(() => fn, deps);
    },
    useEffect(fn, deps) {
      const [, s] = slot(() => ({}));
      if (same(s.deps, deps)) return;
      s.deps = deps;
      state.pending.push(() => {
        s.cleanup?.();
        s.cleanup = fn();
      });
    },
  };
  return { state, hooks };
});
vi.mock("react", () => rt.hooks);

import { useChartBuckets } from "@/app/(dashboard)/dashboard/usage/lib/useChartBuckets.js";

const T0 = new Date(2026, 9, 15, 10, 30, 0).getTime();

const makeRawDayBuckets = (days, { withPrevious = true, prevValues = [] } = {}) =>
  days.map((start, i) => ({
    label: start,
    grain: "day",
    start,
    input: 10 + i,
    cached: 2,
    output: 5,
    tokens: 15 + i,
    cost: 0.1,
    requests: 1 + i,
    ...(withPrevious
      ? {
          previous:
            prevValues[i] === null
              ? null
              : {
                  input: prevValues[i] ?? 20,
                  cached: 0,
                  output: 0,
                  tokens: prevValues[i] ?? 20,
                  cost: 0.2,
                  requests: 1,
                },
        }
      : {}),
  }));

const makeRawHourBuckets = (baseMs, prevValues = []) =>
  Array.from({ length: 24 }, (_, i) => ({
    label: `${String(i).padStart(2, "0")}:00`,
    grain: "hour",
    start: new Date(baseMs + i * 3_600_000).toISOString(),
    input: 10 + i,
    cached: 0,
    output: 2,
    tokens: 12 + i,
    cost: 0.1,
    requests: 1,
    previous:
      prevValues[i] === undefined
        ? { tokens: i * 10, requests: 1 }
        : prevValues[i] === null
          ? null
          : { tokens: prevValues[i], requests: 1 },
  }));

describe("chartPreviousReuse helpers", () => {
  it("capturePreviousSnapshot keeps positive, zero, and null prevTokens and rejects degraded/all responses", () => {
    const raw = makeRawDayBuckets(["2026-10-13", "2026-10-14", "2026-10-15"], {
      prevValues: [120, 0, null],
    });
    const shaped = shapeChartSeries(raw);
    const snap = capturePreviousSnapshot(raw, shaped, {
      period: "7d",
      windowKey: "7d",
      scopeKey: "",
      now: T0,
    });
    expect(snap).toMatchObject({
      period: "7d",
      windowKey: "7d",
      scopeKey: "",
      fetchedAt: T0,
      localDay: "2026-10-15",
      localHour: 10,
      slots: [
        { grain: "day", start: "2026-10-13", prevTokens: 120 },
        { grain: "day", start: "2026-10-14", prevTokens: 0 },
        { grain: "day", start: "2026-10-15", prevTokens: null },
      ],
    });

    expect(
      capturePreviousSnapshot(raw, shaped, {
        period: "all",
        windowKey: "all",
        scopeKey: "",
        now: T0,
      }),
    ).toBeNull();
    expect(
      capturePreviousSnapshot([], [], { period: "7d", windowKey: "7d", scopeKey: "", now: T0 }),
    ).toBeNull();
    expect(
      capturePreviousSnapshot(raw, shaped.slice(0, 2), {
        period: "7d",
        windowKey: "7d",
        scopeKey: "",
        now: T0,
      }),
    ).toBeNull();

    // Partial or full omission / undefined `previous` must never be cached.
    const degradedAll = makeRawDayBuckets(["2026-10-14", "2026-10-15"], { withPrevious: false });
    expect(
      capturePreviousSnapshot(degradedAll, shapeChartSeries(degradedAll), {
        period: "7d",
        windowKey: "7d",
        scopeKey: "",
        now: T0,
      }),
    ).toBeNull();
    const partialDegraded = [raw[0], { ...raw[1], previous: undefined }];
    expect(
      capturePreviousSnapshot(partialDegraded, shapeChartSeries(partialDegraded), {
        period: "7d",
        windowKey: "7d",
        scopeKey: "",
        now: T0,
      }),
    ).toBeNull();
  });

  it("canReusePrevious respects TTL, midnight/hour/DST rollovers, scope, and clock rollback", () => {
    const raw = makeRawDayBuckets(["2026-10-14", "2026-10-15"]);
    const baseMeta = { period: "today", windowKey: "today", scopeKey: "", now: T0 };
    const todaySnap = capturePreviousSnapshot(raw, shapeChartSeries(raw), baseMeta);

    expect(canReusePrevious(null, baseMeta)).toBe(false);
    expect(canReusePrevious({ ...todaySnap, slots: [] }, baseMeta)).toBe(false);
    expect(canReusePrevious(todaySnap, { ...baseMeta, now: T0 + 30_000 })).toBe(true);
    expect(canReusePrevious(todaySnap, { ...baseMeta, now: T0 + PREVIOUS_REUSE_TTL_MS })).toBe(
      false,
    );
    expect(canReusePrevious(todaySnap, { ...baseMeta, now: T0 - 1_000 })).toBe(false);
    expect(canReusePrevious(todaySnap, { ...baseMeta, scopeKey: "&view=me" })).toBe(false);
    expect(canReusePrevious(todaySnap, { ...baseMeta, period: "7d", windowKey: "7d" })).toBe(false);
    expect(canReusePrevious(todaySnap, { ...baseMeta, period: "all", windowKey: "all" })).toBe(
      false,
    );

    // Hour rollover invalidates `today` even within 60s.
    const nearHourEnd = new Date(2026, 9, 15, 10, 59, 45).getTime();
    const nearHourSnap = capturePreviousSnapshot(raw, shapeChartSeries(raw), {
      period: "today",
      windowKey: "today",
      scopeKey: "",
      now: nearHourEnd,
    });
    expect(
      canReusePrevious(nearHourSnap, {
        period: "today",
        windowKey: "today",
        scopeKey: "",
        now: nearHourEnd + 20_000,
      }),
    ).toBe(false);

    // Fall-back DST transition: two consecutive 01:xx wall-clock hours must not collide.
    const fallBackMidnight = new Date(2026, 10, 1, 0, 0, 0).getTime();
    const firstOne59 = fallBackMidnight + 2 * 3_600_000 - 15_000;
    const secondOne00 = firstOne59 + 20_000;
    if (new Date(firstOne59).getHours() === new Date(secondOne00).getHours()) {
      const dstSnap = capturePreviousSnapshot(raw, shapeChartSeries(raw), {
        period: "today",
        windowKey: "today",
        scopeKey: "",
        now: firstOne59,
      });
      expect(
        canReusePrevious(dstSnap, {
          period: "today",
          windowKey: "today",
          scopeKey: "",
          now: secondOne00,
        }),
      ).toBe(false);
    }

    // Midnight rollover invalidates day periods even within 60s, while `24h` stays valid within TTL.
    const nearMidnight = new Date(2026, 9, 15, 23, 59, 45).getTime();
    for (const p of ["7d", "30d", "60d", "90d"]) {
      const snap = capturePreviousSnapshot(raw, shapeChartSeries(raw), {
        period: p,
        windowKey: p,
        scopeKey: "",
        now: nearMidnight,
      });
      expect(
        canReusePrevious(snap, {
          period: p,
          windowKey: p,
          scopeKey: "",
          now: nearMidnight + 20_000,
        }),
      ).toBe(true === false);
    }

    const rollingSnap = capturePreviousSnapshot(raw, shapeChartSeries(raw), {
      period: "24h",
      windowKey: "24h",
      scopeKey: "",
      now: nearMidnight,
    });
    expect(
      canReusePrevious(rollingSnap, {
        period: "24h",
        windowKey: "24h",
        scopeKey: "",
        now: nearMidnight + 20_000,
      }),
    ).toBe(true);
  });

  it("canReusePrevious evaluates custom immutability against fetchedAt, not current wall clock", () => {
    const oldRaw = makeRawDayBuckets(["2026-10-01", "2026-10-02"]);
    const oldSnap = capturePreviousSnapshot(oldRaw, shapeChartSeries(oldRaw), {
      period: "custom",
      windowKey: "custom:2026-10-01:2026-10-02",
      scopeKey: "",
      now: T0,
    });
    // `to = 2026-10-02 < yesterday (2026-10-14)` at fetchedAt stays immutable indefinitely.
    expect(
      canReusePrevious(oldSnap, {
        period: "custom",
        range: { from: "2026-10-01", to: "2026-10-02" },
        windowKey: "custom:2026-10-01:2026-10-02",
        scopeKey: "",
        now: T0 + 10 * 86_400_000,
      }),
    ).toBe(true);
    // Changing to a different custom range invalidates via windowKey.
    expect(
      canReusePrevious(oldSnap, {
        period: "custom",
        range: { from: "2026-10-01", to: "2026-10-03" },
        windowKey: "custom:2026-10-01:2026-10-03",
        scopeKey: "",
        now: T0 + 1_000,
      }),
    ).toBe(false);

    // Partial-day `to === today` snapshot captured on day D must expire even if re-evaluated on D+2.
    const todayRaw = makeRawDayBuckets(["2026-10-14", "2026-10-15"]);
    const todayCustomSnap = capturePreviousSnapshot(todayRaw, shapeChartSeries(todayRaw), {
      period: "custom",
      windowKey: "custom:2026-10-14:2026-10-15",
      scopeKey: "",
      now: T0,
    });
    expect(
      canReusePrevious(todayCustomSnap, {
        period: "custom",
        range: { from: "2026-10-14", to: "2026-10-15" },
        windowKey: "custom:2026-10-14:2026-10-15",
        scopeKey: "",
        now: T0 + 2 * 86_400_000,
      }),
    ).toBe(false);

    // `to = yesterday (2026-10-14)` stays subject to TTL to guard against browser/server TZ skew.
    const yestRaw = makeRawDayBuckets(["2026-10-13", "2026-10-14"]);
    const yestSnap = capturePreviousSnapshot(yestRaw, shapeChartSeries(yestRaw), {
      period: "custom",
      windowKey: "custom:2026-10-13:2026-10-14",
      scopeKey: "",
      now: T0,
    });
    expect(
      canReusePrevious(yestSnap, {
        period: "custom",
        range: { from: "2026-10-13", to: "2026-10-14" },
        windowKey: "custom:2026-10-13:2026-10-14",
        scopeKey: "",
        now: T0 + PREVIOUS_REUSE_TTL_MS,
      }),
    ).toBe(false);

    // Coarse grains (`week`, `month`, `year` >92d) are immutable even when `to === today`; `"hour"` is not.
    for (const grain of ["week", "month", "year"]) {
      const coarseRaw = [
        { label: "A", grain, start: "2025-01", input: 5, output: 1, previous: { tokens: 9 } },
        { label: "B", grain, start: "2026-10", input: 8, output: 2, previous: { tokens: 12 } },
      ];
      const coarseSnap = capturePreviousSnapshot(coarseRaw, shapeChartSeries(coarseRaw), {
        period: "custom",
        windowKey: "custom:2025-01-01:2026-10-15",
        scopeKey: "",
        now: T0,
      });
      expect(
        isImmutablePreviousWindow(
          "custom",
          { from: "2025-01-01", to: "2026-10-15" },
          coarseSnap.slots,
          T0,
        ),
      ).toBe(true);
      expect(
        canReusePrevious(coarseSnap, {
          period: "custom",
          range: { from: "2025-01-01", to: "2026-10-15" },
          windowKey: "custom:2025-01-01:2026-10-15",
          scopeKey: "",
          now: T0 + 300_000,
        }),
      ).toBe(true);
    }
    expect(
      isImmutablePreviousWindow(
        "custom",
        { from: "2026-10-15", to: "2026-10-15" },
        [{ grain: "hour" }],
        T0,
      ),
    ).toBe(false);
  });

  it("mergeReusedPrevious preserves positive/0/null prevTokens and detects shifted skeletons or length mismatches", () => {
    const raw = makeRawDayBuckets(["2026-10-13", "2026-10-14", "2026-10-15"], {
      prevValues: [40, 0, null],
    });
    const snap = capturePreviousSnapshot(raw, shapeChartSeries(raw), {
      period: "7d",
      windowKey: "7d",
      scopeKey: "",
      now: T0,
    });

    const freshNonCompare = shapeChartSeries([
      {
        label: "Oct 13",
        grain: "day",
        start: "2026-10-13",
        input: 50,
        cached: 0,
        output: 10,
        cost: 0.5,
        requests: 4,
      },
      {
        label: "Oct 14",
        grain: "day",
        start: "2026-10-14",
        input: 100,
        cached: 5,
        output: 20,
        cost: 1,
        requests: 9,
      },
      {
        label: "Oct 15",
        grain: "day",
        start: "2026-10-15",
        input: 200,
        cached: 10,
        output: 30,
        cost: 2,
        requests: 12,
      },
    ]);
    const merged = mergeReusedPrevious(freshNonCompare, snap, "7d");
    expect(merged).toHaveLength(3);
    expect(merged[0]).toMatchObject({ input: 50, tokens: 60, requests: 4, prevTokens: 40 });
    expect(merged[1]).toMatchObject({ input: 100, tokens: 120, requests: 9, prevTokens: 0 });
    expect(merged[2]).toMatchObject({ input: 200, tokens: 230, requests: 12, prevTokens: null });

    // Length mismatch and shifted skeleton return null.
    expect(mergeReusedPrevious(freshNonCompare.slice(0, 2), snap, "7d")).toBeNull();
    const shifted = shapeChartSeries(
      makeRawDayBuckets(["2026-10-14", "2026-10-15", "2026-10-16"], { withPrevious: false }),
    );
    expect(mergeReusedPrevious(shifted, snap, "7d")).toBeNull();

    // Rolling 24h accepts up to TTL + grace forward timestamp drift and rejects negative or excessive drift.
    const hourRaw = makeRawHourBuckets(T0 - 23 * 3_600_000);
    const hourSnap = capturePreviousSnapshot(hourRaw, shapeChartSeries(hourRaw), {
      period: "24h",
      windowKey: "24h",
      scopeKey: "",
      now: T0,
    });
    const hourShift = (deltaMs) =>
      shapeChartSeries(
        hourRaw.map((b, i) => ({
          label: b.label,
          grain: "hour",
          start: new Date(Date.parse(b.start) + deltaMs).toISOString(),
          input: i + 100,
          output: 2,
        })),
      );
    const maxDrift = PREVIOUS_REUSE_TTL_MS + ROLLING_24H_DRIFT_GRACE_MS;
    const merged24h = mergeReusedPrevious(hourShift(maxDrift), hourSnap, "24h");
    expect(merged24h[5]).toMatchObject({ input: 105, tokens: 107, prevTokens: 50 });
    expect(mergeReusedPrevious(hourShift(-1_000), hourSnap, "24h")).toBeNull();
    expect(mergeReusedPrevious(hourShift(maxDrift + 1), hourSnap, "24h")).toBeNull();
  });
});

describe("useChartBuckets previous-series reuse", () => {
  const originalFetch = globalThis.fetch;
  let calls;

  const jsonResponse = (body) => ({
    ok: true,
    status: 200,
    json: async () => body,
  });
  const errorResponse = (status, error) => ({
    ok: false,
    status,
    json: async () => ({ error }),
  });
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const render = (period, enabled, refreshKey, filters = null, range = null) => {
    rt.state.index = 0;
    rt.state.pending = [];
    const out = useChartBuckets(period, enabled, refreshKey, filters, range);
    for (const run of rt.state.pending) run();
    return out;
  };
  const runRender = async (...args) => {
    render(...args);
    await flush();
    return render(...args);
  };

  beforeEach(() => {
    rt.state.slots = [];
    rt.state.index = 0;
    rt.state.pending = [];
    calls = [];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    for (const s of rt.state.slots) s?.cleanup?.();
  });

  it("omits compare=previous on background refreshes within TTL for 7d, today, and 24h while preserving 0/null/positive prevTokens", async () => {
    let seq = 0;
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(url);
      seq += 1;
      const withPrev = url.includes("compare=previous");
      if (url.includes("period=today") || url.includes("period=24h")) {
        const hours = makeRawHourBuckets(T0 - 23 * 3_600_000, [0, null, 200]);
        return jsonResponse(
          hours.map((b) => {
            const next = { ...b, input: b.input * seq, tokens: b.input * seq + b.output };
            if (!withPrev) delete next.previous;
            return next;
          }),
        );
      }
      return jsonResponse(
        makeRawDayBuckets(["2026-10-13", "2026-10-14", "2026-10-15"], {
          withPrevious: withPrev,
          prevValues: withPrev ? [55, 0, null] : [],
        }).map((b) => ({ ...b, input: b.input * seq, tokens: b.input * seq + b.output })),
      );
    });

    const first = await runRender("7d", true, 0);
    expect(calls).toEqual(["/api/usage/chart?period=7d&compare=previous"]);
    expect(first.buckets.map((b) => b.prevTokens)).toEqual([55, 0, null]);
    expect(first.buckets[0].input).toBe(10);

    // Background refresh within TTL: omits compare=previous and updates current values while keeping prevTokens.
    vi.setSystemTime(T0 + 25_000);
    const second = await runRender("7d", true, 1);
    expect(calls).toEqual([
      "/api/usage/chart?period=7d&compare=previous",
      "/api/usage/chart?period=7d",
    ]);
    expect(second.buckets.map((b) => b.prevTokens)).toEqual([55, 0, null]);
    expect(second.buckets[0].input).toBe(20);

    // A second refresh inside 60s STILL honors original fetchedAt (no sliding TTL extension).
    vi.setSystemTime(T0 + 55_000);
    await runRender("7d", true, 2);
    expect(calls[2]).toBe("/api/usage/chart?period=7d");

    // Once original fetchedAt + 60s elapses, refreshes fetch compare=previous again.
    vi.setSystemTime(T0 + 60_000);
    const fourth = await runRender("7d", true, 3);
    expect(calls[3]).toBe("/api/usage/chart?period=7d&compare=previous");
    expect(fourth.buckets.map((b) => b.prevTokens)).toEqual([55, 0, null]);

    // `today` and `24h` also reuse within TTL and invalidate on hour rollover (`today`) vs preserve (`24h`).
    calls.length = 0;
    const today1 = await runRender("today", true, 3);
    expect(today1.buckets.slice(0, 3).map((b) => b.prevTokens)).toEqual([0, null, 200]);
    vi.setSystemTime(T0 + 60_000 + 20_000);
    const today2 = await runRender("today", true, 4);
    expect(calls).toEqual([
      "/api/usage/chart?period=today&compare=previous",
      "/api/usage/chart?period=today",
    ]);
    expect(today2.buckets.slice(0, 3).map((b) => b.prevTokens)).toEqual([0, null, 200]);

    calls.length = 0;
    await runRender("24h", true, 4);
    vi.setSystemTime(T0 + 60_000 + 40_000);
    await runRender("24h", true, 5);
    expect(calls).toEqual([
      "/api/usage/chart?period=24h&compare=previous",
      "/api/usage/chart?period=24h",
    ]);
  });

  it("falls back to compare=previous when a non-compare refresh detects a shifted server skeleton, and handles fallback failures cleanly", async () => {
    let shiftServerDay = false;
    let failFallback = false;
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(url);
      const withPrev = url.includes("compare=previous");
      if (withPrev && failFallback) return errorResponse(503, "fallback down");
      const days = shiftServerDay ? ["2026-10-15", "2026-10-16"] : ["2026-10-14", "2026-10-15"];
      return jsonResponse(
        makeRawDayBuckets(days, {
          withPrevious: withPrev,
          prevValues: withPrev ? (shiftServerDay ? [88, 99] : [11, 22]) : [],
        }),
      );
    });

    const first = await runRender("7d", true, 0);
    expect(first.buckets.map((b) => b.prevTokens)).toEqual([11, 22]);

    // Simulate server ahead by midnight while client clock is still within TTL.
    shiftServerDay = true;
    vi.setSystemTime(T0 + 10_000);
    const second = await runRender("7d", true, 1);
    expect(calls).toEqual([
      "/api/usage/chart?period=7d&compare=previous",
      "/api/usage/chart?period=7d",
      "/api/usage/chart?period=7d&compare=previous",
    ]);
    expect(second.buckets.map((b) => b.start)).toEqual(["2026-10-15", "2026-10-16"]);
    expect(second.buckets.map((b) => b.prevTokens)).toEqual([88, 99]);

    // If fallback compare=previous fails, surface error and leave cache empty so next refresh sends compare=previous.
    calls.length = 0;
    failFallback = true;
    shiftServerDay = false;
    const failedFallback = await runRender("7d", true, 2);
    expect(failedFallback.error).toBe("chart 503");
    failFallback = false;
    await runRender("7d", true, 3);
    expect(calls.at(-1)).toBe("/api/usage/chart?period=7d&compare=previous");
  });

  it("reuses historical custom ranges indefinitely, switches between custom ranges, and never sends compare=previous for all", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(url);
      const withPrev = url.includes("compare=previous");
      const days = url.includes("2026-10-03")
        ? ["2026-10-03", "2026-10-04"]
        : ["2026-10-01", "2026-10-02"];
      return jsonResponse(
        makeRawDayBuckets(days, {
          withPrevious: withPrev,
          prevValues: url.includes("2026-10-03") ? [61, 62] : [31, 32],
        }),
      );
    });

    const rangeA = { from: "2026-10-01", to: "2026-10-02" };
    await runRender("custom", true, 0, null, rangeA);
    vi.setSystemTime(T0 + 3_600_000);
    const refreshed = await runRender("custom", true, 1, null, rangeA);
    expect(calls).toEqual([
      "/api/usage/chart?period=custom&from=2026-10-01&to=2026-10-02&compare=previous",
      "/api/usage/chart?period=custom&from=2026-10-01&to=2026-10-02",
    ]);
    expect(refreshed.buckets.map((b) => b.prevTokens)).toEqual([31, 32]);

    // Switching to another custom range resets cache and asks compare=previous.
    const rangeB = { from: "2026-10-03", to: "2026-10-04" };
    const switched = await runRender("custom", true, 1, null, rangeB);
    expect(calls[2]).toBe(
      "/api/usage/chart?period=custom&from=2026-10-03&to=2026-10-04&compare=previous",
    );
    expect(switched.buckets.map((b) => b.prevTokens)).toEqual([61, 62]);

    calls.length = 0;
    await runRender("all", true, 2, null, null);
    expect(calls).toEqual(["/api/usage/chart?period=all"]);
  });

  it("handles scope switch-back after quiet scope, clears stale error on period switch-back, and ignores non-AbortError on aborted loads", async () => {
    const scopeA = { workspaceId: "ws-1", view: "workspace" };
    const scopeB = { workspaceId: "ws-2", view: "me" };
    let fail30d = false;
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(url);
      if (url.includes("period=30d") && fail30d) return errorResponse(500, "30d broke");
      return jsonResponse(
        makeRawDayBuckets(["2026-10-14", "2026-10-15"], {
          withPrevious: url.includes("compare=previous"),
          prevValues: [44, 55],
        }),
      );
    });

    // Load Scope A.
    const a1 = await runRender("7d", true, 0, scopeA);
    expect(a1.buckets.map((b) => b.prevTokens)).toEqual([44, 55]);

    // Switch to Scope B while quiet (enabled=false), then return to Scope A: must refetch, never wedge loading.
    render("7d", false, 0, scopeB);
    await flush();
    const backToA = await runRender("7d", true, 0, scopeA);
    expect(backToA.loading).toBe(false);
    expect(backToA.bucketsPeriod).toBe("7d");
    expect(backToA.buckets.map((b) => b.prevTokens)).toEqual([44, 55]);
    expect(calls).toEqual([
      "/api/usage/chart?period=7d&compare=previous&workspaceId=ws-1&view=workspace",
      "/api/usage/chart?period=7d&compare=previous&workspaceId=ws-1&view=workspace",
    ]);

    // Switch to failing 30d, then back to 7d (same key): stale error must clear!
    fail30d = true;
    const err30d = await runRender("30d", true, 0, scopeA);
    expect(err30d.error).toBe("chart 500");
    fail30d = false;
    const back7d = await runRender("7d", true, 0, scopeA);
    expect(back7d.error).toBeNull();
    expect(back7d.loading).toBe(false);

    // Aborted request rejecting with a non-AbortError must not set error state, and disabling mid-flight clears loading.
    let rejectAborted;
    globalThis.fetch = vi.fn(
      () =>
        new Promise((_, reject) => {
          rejectAborted = reject;
        }),
    );
    const inFlight = render("60d", true, 1, scopeA);
    expect(inFlight.loading).toBe(false); // state flips on next render after effect
    const whileLoading = render("60d", true, 1, scopeA);
    expect(whileLoading.loading).toBe(true);

    const disabled = render("60d", false, 1, scopeA);
    rejectAborted(new TypeError("network truncated"));
    await flush();
    const settledDisabled = render("60d", false, 1, scopeA);
    expect(disabled.loading).toBe(true); // before effect ran
    expect(settledDisabled.loading).toBe(false);
    expect(settledDisabled.error).toBeNull();
  });

  it("recovers from degraded server payloads, supports retry(), and ignores late aborted successes", async () => {
    let omitPreviousOnServer = true;
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(url);
      const withPrev = url.includes("compare=previous") && !omitPreviousOnServer;
      return jsonResponse(
        makeRawDayBuckets(["2026-10-14", "2026-10-15"], {
          withPrevious: withPrev,
          prevValues: [44, 55],
        }),
      );
    });

    // Server returned degraded payload without `previous`: must NOT cache, so next refresh asks again.
    await runRender("7d", true, 0);
    omitPreviousOnServer = false;
    vi.setSystemTime(T0 + 5_000);
    const recovered = await runRender("7d", true, 1);
    expect(calls).toEqual([
      "/api/usage/chart?period=7d&compare=previous",
      "/api/usage/chart?period=7d&compare=previous",
    ]);
    expect(recovered.buckets.map((b) => b.prevTokens)).toEqual([44, 55]);

    // Explicit retry clears cache and forces compare=previous.
    recovered.retry();
    await flush();
    const afterRetry = render("7d", true, 1);
    expect(calls[2]).toBe("/api/usage/chart?period=7d&compare=previous");
    expect(afterRetry.buckets.map((b) => b.prevTokens)).toEqual([44, 55]);

    // Aborted request never populates cache or state even if it resolves later.
    let resolveAborted;
    globalThis.fetch = vi.fn((url) => {
      calls.push(url);
      if (url.includes("period=30d")) {
        return new Promise((resolve) => {
          resolveAborted = () =>
            resolve(jsonResponse(makeRawDayBuckets(["2026-10-14"], { prevValues: [999] })));
        });
      }
      return Promise.resolve(jsonResponse(makeRawDayBuckets(["2026-10-14"], { prevValues: [77] })));
    });
    render("30d", true, 2);
    const out60 = await runRender("60d", true, 2);
    resolveAborted();
    await flush();
    expect(out60.buckets.map((b) => b.prevTokens)).toEqual([77]);
  });
});
