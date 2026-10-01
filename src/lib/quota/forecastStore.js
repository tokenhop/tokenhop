// In-memory quota forecast samples (YAN-401). Pinned on globalThis so Next.js
// route bundles share one store. Samples are recorded server-side on usage
// probes that already happen — no extra upstream calls. Never throws.
// Relative (not the `open-sse` alias) so scripts/quota-forecast-demo.mjs runs in plain Node.
import { parseResetMs } from "../../../open-sse/services/quotaSnapshot.js";
import { computeForecast } from "./forecast.js";

const G_KEY = "__tokenhopQuotaForecast";
/** Max samples kept per connection+quota key (ring buffer). */
export const MAX_SAMPLES = 64;
/** Max keys store-wide; least-recently-touched evicted past this. */
export const MAX_KEYS = 2000;
/** Samples closer than this replace the last one (tab/poller bursts). */
export const DEDUPE_MS = 30_000;
/** Remaining rising more than this (pts) above the last sample means reset. */
export const RESET_JUMP_PTS = 1;
/** resetAt moving more than this means a new window. */
export const RESET_SHIFT_MS = 5 * 60_000;

const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function store() {
  if (!(globalThis[G_KEY] instanceof Map)) globalThis[G_KEY] = new Map();
  return globalThis[G_KEY];
}

function validNow(now) {
  return Number.isFinite(now) ? now : Date.now();
}

function normalizeResetMs(resetAt, now) {
  const parsed = parseResetMs(resetAt, now);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Record one observed remaining sample for a connection quota window.
 * Ignores invalid ids, non-finite remaining, and out-of-order timestamps.
 *
 * @param {string} connectionId provider connection id
 * @param {string} quotaKey raw `usage.quotas` key
 * @param {{ remaining: number, resetAt?: string|number|null }} sample remaining 0..100, reset ISO/ms
 * @param {number} [now] sample time (epoch ms)
 */
export function recordQuotaSample(connectionId, quotaKey, { remaining, resetAt } = {}, now) {
  try {
    if (typeof connectionId !== "string" || !connectionId.trim()) return;
    if (typeof quotaKey !== "string" || !quotaKey) return;
    if (!Number.isFinite(remaining)) return;
    const t = validNow(now);
    const clamped = Math.min(100, Math.max(0, remaining));
    const resetMs = normalizeResetMs(resetAt, t);

    const map = store();
    const key = `${connectionId}\u0000${quotaKey}`;
    let entry = map.get(key);
    if (!entry) {
      entry = { resetAt: null, samples: [], touched: 0 };
      if (map.size >= MAX_KEYS) {
        let oldestKey;
        let oldestTouched = Infinity;
        for (const [k, v] of map) {
          if (v.touched < oldestTouched) {
            oldestTouched = v.touched;
            oldestKey = k;
          }
        }
        if (oldestKey !== undefined) map.delete(oldestKey);
      }
      map.set(key, entry);
    }

    // Reject out-of-order samples before touching history or resetAt.
    const last = entry.samples[entry.samples.length - 1];
    if (last && t < last.t) return;

    // New window: remaining jumped back up, or the reset moved.
    if (last && clamped > last.remaining + RESET_JUMP_PTS) {
      entry.samples = [];
    } else if (
      last &&
      entry.resetAt !== null &&
      resetMs !== null &&
      Math.abs(resetMs - entry.resetAt) > RESET_SHIFT_MS
    ) {
      entry.samples = [];
    }
    entry.resetAt = resetMs;

    const tail = entry.samples[entry.samples.length - 1];
    if (tail) {
      if (t - tail.t < DEDUPE_MS) {
        entry.samples[entry.samples.length - 1] = { t, remaining: clamped };
        entry.touched = t;
        return;
      }
    }
    entry.samples.push({ t, remaining: clamped });
    if (entry.samples.length > MAX_SAMPLES) {
      entry.samples.splice(0, entry.samples.length - MAX_SAMPLES);
    }
    entry.touched = t;
  } catch {
    /* forecast sampling never breaks the request path */
  }
}

/**
 * Forecasts for every sampled quota window of a connection.
 *
 * @param {string} connectionId provider connection id
 * @param {number} [now] clock (epoch ms)
 * @returns {{ [quotaKey: string]: object }} raw quota key → Forecast
 */
export function getQuotaForecasts(connectionId, now) {
  const out = {};
  try {
    if (typeof connectionId !== "string" || !connectionId) return out;
    const t = validNow(now);
    const prefix = `${connectionId}\u0000`;
    for (const [key, entry] of store()) {
      if (!key.startsWith(prefix)) continue;
      const quotaKey = key.slice(prefix.length);
      if (BLOCKED_KEYS.has(quotaKey.toLowerCase())) continue;
      try {
        out[quotaKey] = computeForecast(entry.samples, { resetAt: entry.resetAt, now: t });
      } catch {
        /* a bad entry degrades its own window, not the whole map */
      }
    }
  } catch {
    /* never break the response path */
  }
  return out;
}

const URGENCY = { "will-run-out": 0, tight: 1, "on-track": 2, idle: 3 };

/**
 * Most urgent forecast, for the Home quota watch.
 * Order: will-run-out > tight > on-track > idle; unknown ignored;
 * ties → earliest emptyAt.
 *
 * @param {{ [quotaKey: string]: object }} forecasts map from getQuotaForecasts
 * @returns {(object & { window: string })|null}
 */
export function pickUrgentForecast(forecasts) {
  try {
    if (!forecasts || typeof forecasts !== "object") return null;
    let best = null;
    let bestRank = Infinity;
    let bestEmptyAt = Infinity;
    for (const [window, forecast] of Object.entries(forecasts)) {
      const rank = forecast && typeof forecast === "object" ? URGENCY[forecast.state] : undefined;
      if (rank === undefined) continue;
      const emptyAt = forecast.emptyAt ? Date.parse(forecast.emptyAt) : Infinity;
      const emptyMs = Number.isFinite(emptyAt) ? emptyAt : Infinity;
      if (rank < bestRank || (rank === bestRank && emptyMs < bestEmptyAt)) {
        best = { ...forecast, window };
        bestRank = rank;
        bestEmptyAt = emptyMs;
      }
    }
    return best;
  } catch {
    return null;
  }
}

/** Test helper: clear all forecast samples. */
export function _resetQuotaForecastStore() {
  try {
    store().clear();
  } catch {
    /* ignore */
  }
}
