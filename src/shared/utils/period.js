/**
 * Canonical dashboard period model shared by Home, Usage, and Token saver.
 *
 * Pure ESM — no React, no DOM at import time — so the node test runner can
 * import it directly. Storage helpers default to `window.localStorage` when
 * available and degrade to no-ops when storage is denied or absent.
 */

/** Ordered period descriptors (value + UI label) in ascending range order. */
export const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "60d", label: "60d" },
];

/** Every valid period value, in ascending range order. */
export const PERIOD_VALUES = PERIODS.map((p) => p.value);

/** Periods whose APIs the Home and Token saver summaries accept. */
export const SUMMARY_PERIODS = ["today", "7d", "30d"];

/** Safe-storage key for the remembered period. */
export const PERIOD_STORAGE_KEY = "signal.period";

/** Period used when nothing valid is stored or present in the URL. */
export const DEFAULT_PERIOD = "today";

/**
 * True when `value` is one of the known period strings.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPeriod(value) {
  return PERIOD_VALUES.includes(value);
}

/**
 * Map `value` onto `allowed`.
 *
 * A known value outside the subset upgrades to the first allowed period at or
 * above its rank (24h→7d, 60d→30d on summary pages). An unknown value falls
 * back to the default (or the first allowed period when even the default is
 * not allowed).
 * @param {unknown} value
 * @param {string[]} [allowed]
 * @returns {string}
 */
export function coercePeriod(value, allowed = PERIOD_VALUES) {
  if (!Array.isArray(allowed) || allowed.length === 0) {
    throw new TypeError("coercePeriod: allowed must be a non-empty period array");
  }
  const rank = PERIOD_VALUES.indexOf(value);
  if (rank >= 0) {
    if (allowed.includes(value)) return value;
    return (
      PERIOD_VALUES.slice(rank).find((p) => allowed.includes(p)) ??
      PERIOD_VALUES.findLast((p) => allowed.includes(p))
    );
  }
  return allowed.includes(DEFAULT_PERIOD) ? DEFAULT_PERIOD : allowed[0];
}

/**
 * Resolve the effective period: valid URL value first, then valid stored
 * value, then the default — each coerced into `allowed`.
 * @param {{urlValue?: unknown, storedValue?: unknown, allowed?: string[]}} input
 * @returns {string}
 */
export function resolvePeriod({ urlValue, storedValue, allowed = PERIOD_VALUES }) {
  if (urlValue != null && isPeriod(urlValue)) return coercePeriod(urlValue, allowed);
  if (storedValue != null && isPeriod(storedValue)) return coercePeriod(storedValue, allowed);
  return coercePeriod(DEFAULT_PERIOD, allowed);
}

/**
 * PERIODS filtered to `allowed`, keeping canonical order.
 * @param {string[]} allowed
 */
export function periodOptions(allowed) {
  return PERIODS.filter((p) => allowed.includes(p.value));
}

const DAY_COUNTS = { today: 0, "24h": 0, "7d": 7, "30d": 30, "60d": 60 };

/**
 * Inclusive start (ms) of `period`.
 *
 * `today` is local midnight; `24h` is a rolling now−24h window; `7d/30d/60d`
 * are calendar windows starting at local midnight of (today − (N−1)) so every
 * bucket start is at or before the corresponding API window start.
 * @param {string} period
 * @param {number} [now]
 * @returns {number}
 */
export function periodStart(period, now = Date.now()) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  switch (period) {
    case "today":
      return midnight.getTime();
    case "24h":
      return now - 24 * 60 * 60 * 1000;
    case "7d":
    case "30d":
    case "60d":
      return midnight.getTime() - (DAY_COUNTS[period] - 1) * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Unknown period: ${period}`);
  }
}

/**
 * Smallest allowed period whose start is at or before `lastAt` (the most
 * recent request). Future timestamps count as "today". Null/invalid input,
 * or no allowed period matching, yields null.
 * @param {string|number|Date|null} lastAt
 * @param {string[]} [allowed]
 * @param {number} [now]
 * @returns {string|null}
 */
export function smallestPeriodWithData(lastAt, allowed = PERIOD_VALUES, now = Date.now()) {
  const t = lastAt instanceof Date ? lastAt.getTime() : new Date(lastAt).getTime();
  if (Number.isNaN(t)) return null;
  for (const period of allowed) {
    if (periodStart(period, now) <= t) return period;
  }
  return null;
}

function defaultStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Read the remembered period. Never throws; a garbage or unavailable value
 * yields null.
 * @param {Storage|null} [storage]
 * @returns {string|null}
 */
export function loadStoredPeriod(storage = defaultStorage()) {
  try {
    const raw = storage?.getItem?.(PERIOD_STORAGE_KEY);
    return isPeriod(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Persist the period. Never throws (private-mode storage may deny writes).
 * @param {string} value
 * @param {Storage|null} [storage]
 */
export function saveStoredPeriod(value, storage = defaultStorage()) {
  try {
    if (isPeriod(value)) storage?.setItem?.(PERIOD_STORAGE_KEY, value);
  } catch {
    // Storage denied: the choice simply does not persist.
  }
}

/**
 * Per-period copy for the shared quiet empty state: `title` when the period is
 * quiet, `actionLabel` for the "jump to a period with data" button. The keys
 * are ones the i18n extractor reads, so the locale coverage guard checks them.
 */
export const QUIET_COPY = {
  today: { title: "Quiet today", actionLabel: "Show today" },
  "24h": { title: "Quiet in the last 24h", actionLabel: "Show 24h" },
  "7d": { title: "Quiet in the last 7d", actionLabel: "Show 7d" },
  "30d": { title: "Quiet in the last 30d", actionLabel: "Show 30d" },
  "60d": { title: "Quiet in the last 60d", actionLabel: "Show 60d" },
};

/**
 * Localized elapsed-time copy such as "2 days ago", clamped so it never
 * claims a future moment. Invalid input yields "".
 * @param {string} iso
 * @param {string} [locale]
 * @param {number} [now]
 * @returns {string}
 */
export function formatRelativeFromNow(iso, locale = "en", now = Date.now()) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Math.max(0, now - t);
  let rtf;
  try {
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
  } catch {
    rtf = new Intl.RelativeTimeFormat("en", { numeric: "always" });
  }
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff >= day) return rtf.format(-Math.floor(diff / day), "day");
  if (diff >= hour) return rtf.format(-Math.floor(diff / hour), "hour");
  return rtf.format(-Math.max(1, Math.floor(diff / minute)), "minute");
}
