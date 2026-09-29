const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

const URGENCY_ORDER = ["will-run-out", "tight", "on-track", "idle"];

const TONE_BY_STATE = {
  "will-run-out": "err",
  tight: "warn",
  "on-track": "muted",
  idle: "muted",
};

const ICON_BY_STATE = {
  "will-run-out": "warning",
  tight: "hourglass_top",
  "on-track": "check_circle",
  idle: "bedtime",
};

/**
 * Approximate a duration for forecast display: "<1m", "~Nm", "~Nh",
 * "~Nd Nh" (< 7d, drops "0h"), "~Nd" (>= 7d). Null for non-finite/negative.
 *
 * @param {number} ms Duration in milliseconds.
 * @returns {string|null} Approximate duration text or null when unusable.
 */
export function formatApproxDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < MINUTE_MS) return "<1m";
  // Round to the displayed unit first so 59.6m reads "~1h", not "~60m".
  const minutes = Math.round(ms / MINUTE_MS);
  if (minutes < 60) return `~${minutes}m`;
  const hours = Math.round(ms / HOUR_MS);
  if (hours < 24) return `~${hours}h`;
  if (ms >= WEEK_MS) return `~${Math.round(ms / DAY_MS)}d`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `~${days}d` : `~${days}d ${rest}h`;
}

function toTime(value) {
  if (value == null) return null;
  const time = typeof value === "string" ? Date.parse(value) : Number(value);
  return Number.isFinite(time) ? time : null;
}

/** Matches the server's IDLE_PCT_PER_HOUR: burn at or below it reads as ~0. */
const IDLE_BURN_PCT_PER_HOUR = 0.1;

function burnText(burn) {
  if (burn == null || !Number.isFinite(burn) || burn <= IDLE_BURN_PCT_PER_HOUR) return "~0%/h";
  return `~${burn.toFixed(1)}%/h`;
}

/**
 * Describe a forecast for the compact line component. Null for
 * missing/unknown forecasts.
 *
 * @param {object|null|undefined} forecast Forecast object from the server contract.
 * @param {number} [now=Date.now()] Reference time in ms.
 * @returns {{ state: string, tone: string, icon: string, emptyIn: string|null, resetsIn: string|null, burnRate: string, sampleWindow: string }|null}
 */
export function describeForecast(forecast, now = Date.now()) {
  if (!forecast || forecast.state === "unknown" || !(forecast.state in TONE_BY_STATE)) return null;
  const { state } = forecast;
  const tone = TONE_BY_STATE[state];
  const icon = ICON_BY_STATE[state];
  const showsEmpty = state === "will-run-out" || state === "tight";
  const emptyAt = showsEmpty ? toTime(forecast.emptyAt) : null;
  const emptyIn = emptyAt == null ? null : formatApproxDuration(emptyAt - now);
  const resetAt = toTime(forecast.resetAt);
  const resetsIn = resetAt == null ? null : formatApproxDuration(resetAt - now);
  const burn = Number.isFinite(forecast.burnPctPerHour) ? forecast.burnPctPerHour : null;
  const burnRate = burnText(burn);
  const sampleWindow = formatApproxDuration(Number(forecast.sampleSpanMs)) ?? "<1m";
  return { state, tone, icon, emptyIn, resetsIn, burnRate, sampleWindow };
}

/**
 * Pick the most urgent known forecast from labeled items.
 * Order: will-run-out > tight > on-track > idle; unknown/null ignored;
 * ties break by earliest emptyAt.
 *
 * @param {Array<{ label: string, forecast: object|null|undefined }>} items Labeled forecasts.
 * @returns {{ label: string, forecast: object }|null} Most urgent item or null.
 */
export function worstForecast(items) {
  if (!Array.isArray(items)) return null;
  let best = null;
  for (const item of items) {
    const forecast = item?.forecast;
    if (!forecast) continue;
    const rank = URGENCY_ORDER.indexOf(forecast.state);
    if (rank < 0) continue;
    if (!best) {
      best = { item, rank };
      continue;
    }
    if (rank < best.rank) {
      best = { item, rank };
      continue;
    }
    if (rank === best.rank) {
      const emptyAt = toTime(forecast.emptyAt);
      const bestEmptyAt = toTime(best.item.forecast.emptyAt);
      if (emptyAt != null && (bestEmptyAt == null || emptyAt < bestEmptyAt)) {
        best = { item, rank };
      }
    }
  }
  return best ? { label: best.item.label, forecast: best.item.forecast } : null;
}
