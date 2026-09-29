// Quota runway forecast (YAN-401): pure burn-rate prediction per quota window.
// Samples are observed `remainingPct` (0..100) over time; a least-squares slope
// gives the burn rate (%/h) and the projected empty time, compared to reset.

/** Samples older than this are dropped. */
export const LOOKBACK_MS = 120 * 60_000;
/** Minimum samples for a forecast. */
export const MIN_SAMPLES = 3;
/** Minimum span between first and last sample. */
export const MIN_SPAN_MS = 10 * 60_000;
/** Burn at or below this (%/h) counts as idle, not consuming. */
export const IDLE_PCT_PER_HOUR = 0.1;
/** `tight` when time-to-empty < time-to-reset × (1 + TIGHT_MARGIN). */
export const TIGHT_MARGIN = 0.1;
/** Future samples beyond now + this are clock skew and dropped. */
export const SKEW_TOLERANCE_MS = 60_000;

function toIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function unknown(reason, latest, resetMs, count, spanMs) {
  return {
    state: "unknown",
    reason,
    remainingPct: latest,
    burnPctPerHour: null,
    emptyAt: null,
    resetAt: toIso(resetMs),
    sampleCount: count,
    sampleSpanMs: spanMs,
  };
}

/**
 * Predict whether remaining quota lasts until reset.
 * Pure: all inputs explicit, `now` injected for tests.
 *
 * @param {Array<{ t: number, remaining: number }>} samples observed remaining (0..100) at epoch ms
 * @param {{ resetAt?: number|null, now?: number }} opts window reset (epoch ms|null) and clock
 * @returns {{ state: string, reason: string|null, remainingPct: number, burnPctPerHour: number|null, emptyAt: string|null, resetAt: string|null, sampleCount: number, sampleSpanMs: number }}
 */
export function computeForecast(samples, { resetAt = null, now = Date.now() } = {}) {
  const kept = (Array.isArray(samples) ? samples : [])
    .filter(
      (s) =>
        s &&
        typeof s === "object" &&
        Number.isFinite(s.t) &&
        Number.isFinite(s.remaining) &&
        s.t <= now + SKEW_TOLERANCE_MS &&
        s.t >= now - LOOKBACK_MS,
    )
    .sort((a, b) => a.t - b.t);

  const resetMs = Number.isFinite(resetAt) && resetAt > 0 ? resetAt : null;
  const count = kept.length;
  const spanMs = count > 0 ? kept[count - 1].t - kept[0].t : 0;
  const latest = count > 0 ? kept[count - 1].remaining : 0;

  if (latest <= 0) return unknown("empty", latest, resetMs, count, spanMs);
  if (resetMs === null) return unknown("no-reset", latest, resetMs, count, spanMs);
  if (resetMs <= now) return unknown("reset-passed", latest, resetMs, count, spanMs);
  if (count < MIN_SAMPLES || spanMs < MIN_SPAN_MS) {
    return unknown("insufficient-data", latest, resetMs, count, spanMs);
  }

  // Least squares of remaining (pct) vs t (hours since first sample); burn = -slope.
  const t0 = kept[0].t;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const s of kept) {
    const x = (s.t - t0) / 3_600_000;
    sumX += x;
    sumY += s.remaining;
    sumXY += x * s.remaining;
    sumXX += x * x;
  }
  const denom = count * sumXX - sumX * sumX;
  const slope = denom === 0 ? 0 : (count * sumXY - sumX * sumY) / denom;
  const burn = -slope;

  if (!(burn > IDLE_PCT_PER_HOUR)) {
    return {
      state: "idle",
      reason: null,
      remainingPct: latest,
      burnPctPerHour: burn,
      emptyAt: null,
      resetAt: toIso(resetMs),
      sampleCount: count,
      sampleSpanMs: spanMs,
    };
  }

  const timeToEmptyMs = (latest / burn) * 3_600_000;
  const timeToResetMs = resetMs - now;
  const emptyAt = toIso(now + timeToEmptyMs);
  const state =
    now + timeToEmptyMs < resetMs
      ? "will-run-out"
      : timeToEmptyMs < timeToResetMs * (1 + TIGHT_MARGIN)
        ? "tight"
        : "on-track";

  return {
    state,
    reason: null,
    remainingPct: latest,
    burnPctPerHour: burn,
    emptyAt,
    resetAt: toIso(resetMs),
    sampleCount: count,
    sampleSpanMs: spanMs,
  };
}
