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
/** Remaining rising more than this (pts) above the previous point marks a reset. */
const HISTORY_RESET_JUMP_PTS = 1;
/** Reset timestamp moving more than this marks a new window. */
const HISTORY_RESET_SHIFT_MS = 5 * 60_000;

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
export function computeForecast(
  samples,
  { resetAt = null, now = Date.now(), lookbackMs = LOOKBACK_MS } = {},
) {
  const effectiveLookback =
    Number.isFinite(lookbackMs) && lookbackMs > 0 ? lookbackMs : LOOKBACK_MS;
  const kept = (Array.isArray(samples) ? samples : [])
    .filter(
      (s) =>
        s &&
        typeof s === "object" &&
        Number.isFinite(s.t) &&
        Number.isFinite(s.remaining) &&
        s.t <= now + SKEW_TOLERANCE_MS &&
        s.t >= now - effectiveLookback,
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

/**
 * Compute a burn-rate / runway forecast directly from persisted `quotaHistory`
 * rows for one quota window (YAN-422). Detects window rollovers (remaining jump
 * or resetAt shift) so only samples from the current window feed the slope.
 *
 * @param {Array<{ ts: number, usedFraction: number, resetsAt?: number|null }>} rows
 * @param {{ now?: number, lookbackMs?: number }} [opts]
 * @returns {ReturnType<typeof computeForecast>}
 */
export function computeForecastFromHistory(
  rows,
  { now = Date.now(), lookbackMs = LOOKBACK_MS } = {},
) {
  const ordered = (Array.isArray(rows) ? rows : [])
    .filter(
      (r) =>
        r &&
        typeof r === "object" &&
        Number.isFinite(r.ts) &&
        Number.isFinite(r.usedFraction) &&
        r.ts <= now + SKEW_TOLERANCE_MS,
    )
    .sort((a, b) => a.ts - b.ts);

  let samples = [];
  let resetAt = null;
  for (const row of ordered) {
    const clampedUsed = Math.min(1, Math.max(0, row.usedFraction));
    const remaining = Math.round((1 - clampedUsed) * 10000) / 100;
    const rowReset = Number.isFinite(row.resetsAt) && row.resetsAt > 0 ? row.resetsAt : null;
    const prev = samples[samples.length - 1];
    if (prev && remaining > prev.remaining + HISTORY_RESET_JUMP_PTS) {
      samples = [];
    } else if (
      prev &&
      resetAt !== null &&
      rowReset !== null &&
      Math.abs(rowReset - resetAt) > HISTORY_RESET_SHIFT_MS
    ) {
      samples = [];
    }
    if (rowReset !== null) resetAt = rowReset;
    samples.push({ t: row.ts, remaining });
  }

  return computeForecast(samples, { resetAt, now, lookbackMs });
}
