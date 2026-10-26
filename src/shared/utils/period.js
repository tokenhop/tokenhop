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
  { value: "90d", label: "90d" },
  { value: "all", label: "All time" },
];

/** Every valid period value, in ascending range order. */
export const PERIOD_VALUES = PERIODS.map((p) => p.value);

/**
 * Periods served from usageRollup only (never usageHistory): usage stats,
 * chart and compare totals for these must not scan history.
 */
export const ROLLUP_ONLY_PERIODS = ["90d", "all"];

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
 * True when `value` is a rollup-only period (see ROLLUP_ONLY_PERIODS).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRollupOnlyPeriod(value) {
  return ROLLUP_ONLY_PERIODS.includes(value);
}

/**
 * Map `value` onto `allowed`.
 *
 * A known value outside the subset upgrades to the first allowed period at or
 * above its rank (24h→7d, 60d→30d for a today/7d/30d list). An unknown value falls
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

/**
 * Calendar-day length of each multi-day period. `all` is deliberately absent:
 * it has no fixed length (callers treat a PERIOD_DAYS hit as "day-grain window").
 */
export const PERIOD_DAYS = { "7d": 7, "30d": 30, "60d": 60, "90d": 90 };

/**
 * Inclusive start (ms) of `period` — the single window definition for every
 * usage endpoint (server and client).
 *
 * `today` is local midnight (server's local time on the server); `24h` is a
 * rolling now−24h window; `7d/30d/60d` are calendar windows starting at local
 * midnight of (today − (N−1)) so every bucket start is at or before the
 * corresponding API window start; `90d` is the same calendar window; `all` is
 * the epoch (0).
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
    case "90d":
      // Calendar days (setDate), not 24h multiples, so DST shifts keep local midnight.
      midnight.setDate(midnight.getDate() - (PERIOD_DAYS[period] - 1));
      return midnight.getTime();
    case "all":
      return 0;
    default:
      throw new Error(`Unknown period: ${period}`);
  }
}

/**
 * Window of equal length immediately before the current `period` window
 * `[periodStart(period, now), now)` — the baseline for tile trends.
 *
 * `today` compares the same elapsed time slice of yesterday (midnight
 * shifted back one calendar day via setDate, so DST days stay at local
 * midnight); `24h` is the preceding rolling 24h; `7d/30d/60d` end at the
 * current start. `all` has no previous window and yields null.
 * @param {string} period
 * @param {number} [now]
 * @returns {{start: number, end: number}|null}
 */
export function previousPeriodRange(period, now = Date.now()) {
  if (period === "all") return null;
  const currentStart = periodStart(period, now);
  if (period === "today") {
    const yesterday = new Date(currentStart);
    yesterday.setDate(yesterday.getDate() - 1);
    return { start: yesterday.getTime(), end: yesterday.getTime() + (now - currentStart) };
  }
  return { start: currentStart - (now - currentStart), end: currentStart };
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
  // new Date(null) is the epoch, which `all` (start 0) would now match.
  if (lastAt == null) return null;
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
 * quiet, `actionLabel` for the "jump to a period with data" button (`default`
 * covers an unmapped period). The keys
 * are ones the i18n extractor reads, so the locale coverage guard checks them.
 */
export const QUIET_COPY = {
  today: { title: "Quiet today", actionLabel: "Show today" },
  "24h": { title: "Quiet in the last 24h", actionLabel: "Show 24h" },
  "7d": { title: "Quiet in the last 7d", actionLabel: "Show 7d" },
  "30d": { title: "Quiet in the last 30d", actionLabel: "Show 30d" },
  "60d": { title: "Quiet in the last 60d", actionLabel: "Show 60d" },
  "90d": { title: "Quiet in the last 90d", actionLabel: "Show 90d" },
  all: { title: "No requests in this view", actionLabel: "Show all time" },
  custom: { title: "No requests in this date range" },
  default: { title: "Quiet in this period" },
};

/**
 * Custom date ranges (YAN-426). `custom` is deliberately NOT in PERIODS /
 * PERIOD_VALUES: it has no fixed window, so periodStart/coercePeriod and every
 * named-period consumer keep rejecting it. A custom range is a pair of
 * inclusive local-day keys (`YYYY-MM-DD`, the same keys as usageDaily.dateKey).
 */
export const CUSTOM_PERIOD = "custom";

/** Longest allowed custom range, as an inclusive day count. */
export const MAX_CUSTOM_RANGE_DAYS = 366;

/**
 * True when `value` is the custom-range period string.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCustomPeriod(value) {
  return value === CUSTOM_PERIOD;
}

const pad2 = (n) => String(n).padStart(2, "0");
const keyOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Local `YYYY-MM-DD` of `now` (same key shape as the usage rollup's dateKey).
 * @param {number} [now]
 * @returns {string}
 */
export function localTodayKey(now = Date.now()) {
  return keyOf(new Date(now));
}

/**
 * True for a well-formed `YYYY-MM-DD` that is a real calendar day (rejects 2026-02-30).
 * @param {unknown} key
 * @returns {boolean}
 */
export function isValidDateKey(key) {
  if (typeof key !== "string" || !DATE_KEY_RE.test(key)) return false;
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/**
 * Day key `n` calendar days after `key` (negative = before). Steps with
 * setDate on a local date, never millisecond math, so DST shifts keep days whole.
 * @param {string} key valid `YYYY-MM-DD`
 * @param {number} n
 * @returns {string}
 */
export function shiftDateKey(key, n) {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + n);
  return keyOf(date);
}

/**
 * Whole days from `fromKey` to `toKey` (`to - from`; 0 for the same day).
 * Computed on UTC calendar dates so DST never skews the count.
 * @param {string} fromKey valid `YYYY-MM-DD`
 * @param {string} toKey valid `YYYY-MM-DD`
 * @returns {number}
 */
export function daysBetweenDateKeys(fromKey, toKey) {
  const [fy, fm, fd] = fromKey.split("-").map(Number);
  const [ty, tm, td] = toKey.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

// Each message is nested under `message` so scripts/i18n-literals.mjs extracts it.
const RANGE_MESSAGES = {
  range_missing: { message: "Choose a start and end date" },
  range_format: { message: "Dates must be valid YYYY-MM-DD days" },
  range_order: { message: "Start date must be on or before end date" },
  range_future: { message: "End date can't be in the future" },
  range_span: { message: "Range can't be longer than 366 days" },
};

const rangeError = (reason) => ({ ok: false, reason, message: RANGE_MESSAGES[reason].message });

/**
 * Validate an inclusive custom day range. Checks run in order: both present,
 * real `YYYY-MM-DD` days, from <= to, to <= today, span <= MAX_CUSTOM_RANGE_DAYS.
 * @param {unknown} from
 * @param {unknown} to
 * @param {string} todayKey local `YYYY-MM-DD` of "now" (see localTodayKey)
 * @param {{futureToleranceDays?: number}} [opts] `to` may be up to this many days after `todayKey`
 * @returns {{ok: true, from: string, to: string, days: number} | {ok: false, reason: string, message: string}}
 */
export function parseDateRange(from, to, todayKey, { futureToleranceDays = 0 } = {}) {
  if (from == null || from === "" || to == null || to === "") return rangeError("range_missing");
  if (!isValidDateKey(from) || !isValidDateKey(to)) return rangeError("range_format");
  if (from > to) return rangeError("range_order");
  if (todayKey && to > shiftDateKey(todayKey, futureToleranceDays)) {
    return rangeError("range_future");
  }
  const days = daysBetweenDateKeys(from, to) + 1;
  if (days > MAX_CUSTOM_RANGE_DAYS) return rangeError("range_span");
  return { ok: true, from, to, days };
}

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
