const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * Parse a listen port from env or argv. Prefers PORT, then `--port`/`-p`.
 * @param {Record<string, string|undefined>} [env]
 * @param {string[]} [argv]
 * @returns {number|null}
 */
export function resolveListenPort(env = {}, argv = []) {
  const fromEnv = Number(env?.PORT);
  if (Number.isInteger(fromEnv) && fromEnv >= MIN_PORT && fromEnv <= MAX_PORT) return fromEnv;
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--port" || args[i] === "-p") {
      const value = Number(args[i + 1]);
      if (Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT) return value;
    }
  }
  return null;
}

/**
 * Shape the GET /api/gateway/status body. No secrets, no env dump.
 * @param {{ uptimeSeconds: number, nowMs: number, port: number|null }} input
 * @returns {{ ok: boolean, uptimeSeconds: number, startedAt: string, port: number|null }}
 */
export function shapeGatewayStatus({ uptimeSeconds, nowMs, port }) {
  const floored = Math.max(0, Math.floor(Number(uptimeSeconds) || 0));
  return {
    ok: true,
    uptimeSeconds: floored,
    startedAt: new Date(nowMs - floored * 1000).toISOString(),
    port: typeof port === "number" ? port : null,
  };
}

const SECOND = 1;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Humanize uptime seconds: 45s, 1m 30s, 1h, 3h 4m, 3d 4h.
 * @param {number} totalSeconds
 * @returns {string}
 */
export function formatUptime(totalSeconds) {
  const total = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  if (total < MINUTE) return `${total}s`;
  if (total < HOUR) {
    const minutes = Math.floor(total / MINUTE);
    const seconds = total % MINUTE;
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  if (total < DAY) {
    const hours = Math.floor(total / HOUR);
    const minutes = Math.floor((total % HOUR) / MINUTE);
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(total / DAY);
  const hours = Math.floor((total % DAY) / HOUR);
  return hours ? `${days}d ${hours}h` : `${days}d`;
}

/**
 * Seconds elapsed since an ISO start time, for ticking uptime locally.
 * @param {string|null} startedAt
 * @param {number} nowMs
 * @returns {number|null} null when startedAt is missing or invalid
 */
export function uptimeSecondsSince(startedAt, nowMs) {
  const start = Date.parse(startedAt ?? "");
  if (!Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((nowMs - start) / 1000));
}

// Gateway heartbeat (YAN-408): 15 one-minute request buckets ending at now,
// and the pulse-dot duration that follows live traffic.
export const HEARTBEAT_BUCKETS = 15;
const HEARTBEAT_MINUTE_MS = 60_000;
const HEARTBEAT_WINDOW_MS = HEARTBEAT_BUCKETS * HEARTBEAT_MINUTE_MS;

/**
 * Requests per minute over the last 15 minutes as 15 integer buckets, oldest
 * first, ending at the current (partial) minute. Timestamps outside the
 * window, in the future, or unparsable are dropped.
 * @param {Array<string>} timestamps ISO timestamps
 * @param {number} nowMs
 * @returns {number[]} 15 request counts
 */
export function buildMinuteBuckets(timestamps, nowMs) {
  const buckets = new Array(HEARTBEAT_BUCKETS).fill(0);
  const startMs = nowMs - HEARTBEAT_WINDOW_MS;
  for (const timestamp of timestamps || []) {
    const ms = Date.parse(timestamp ?? "");
    if (!Number.isFinite(ms) || ms < startMs || ms > nowMs) continue;
    const index = Math.min(HEARTBEAT_BUCKETS - 1, Math.floor((ms - startMs) / HEARTBEAT_MINUTE_MS));
    buckets[index] += 1;
  }
  return buckets;
}

/** Pulse-dot bounds: slow when idle, fast when busy (ms per cycle). */
export const PULSE_IDLE_MS = 2400;
export const PULSE_BUSY_MS = 900;
/** Requests in the newest minute that count as fully busy. */
export const PULSE_BUSY_RPM = 60;

/**
 * Pulse-dot duration for a given requests-per-minute: 2.4s idle → 0.9s busy,
 * linear in between, clamped at both ends. Non-numeric/negative input is idle.
 * @param {number} requestsPerMinute requests in the newest heartbeat bucket
 * @returns {number} milliseconds per pulse cycle
 */
export function pulseDurationMs(requestsPerMinute) {
  const rpm = Number(requestsPerMinute);
  if (!Number.isFinite(rpm) || rpm <= 0) return PULSE_IDLE_MS;
  if (rpm >= PULSE_BUSY_RPM) return PULSE_BUSY_MS;
  return Math.round(PULSE_IDLE_MS - ((PULSE_IDLE_MS - PULSE_BUSY_MS) / PULSE_BUSY_RPM) * rpm);
}
