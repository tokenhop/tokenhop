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
