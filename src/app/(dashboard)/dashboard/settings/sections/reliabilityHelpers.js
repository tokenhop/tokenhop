/**
 * YAN-311 reliability helpers: defaults (verified against
 * open-sse/config/reliabilityPolicy.js RELIABILITY_DEFAULTS), duration
 * formatting, and the full-object PATCH used by the Reliability section.
 */

export const RELIABILITY_UI_DEFAULTS = {
  retryPolicy: {
    502: { tries: 3, delayMs: 3000 },
    503: { tries: 3, delayMs: 2000 },
    504: { tries: 2, delayMs: 3000 },
  },
  cooldowns: {
    rateLimitCapMs: 1800000,
    longMs: 120000,
    shortMs: 5000,
    transientMs: 30000,
  },
  backoff: { startMs: 2000, maxMs: 300000, levels: 15 },
  streamTimeouts: { firstChunkMs: 200000, stallMs: 360000, connectMs: 60000 },
};

export const RETRY_ROW_META = [
  { status: "502", label: "bad gateway" },
  { status: "503", label: "unavailable" },
  { status: "504", label: "timeout" },
];

/** Stored settings keys this section writes. */
export const RELIABILITY_KEYS = ["retryPolicy", "cooldowns", "backoff", "streamTimeouts"];

/** Cooldown fields in board order. */
export const COOLDOWN_FIELDS = [
  { key: "rateLimitCapMs", label: "Rate-limit cap" },
  { key: "transientMs", label: "Transient error" },
  { key: "longMs", label: "Long" },
  { key: "shortMs", label: "Short" },
];

/** Stream-timeout fields in board order, with the env var that overrides each. */
export const TIMEOUT_FIELDS = [
  { key: "firstChunkMs", label: "First chunk", envVar: "STREAM_FIRST_CHUNK_TIMEOUT_MS" },
  { key: "stallMs", label: "Stall", envVar: "STREAM_STALL_TIMEOUT_MS" },
  { key: "connectMs", label: "Connect", envVar: "FETCH_CONNECT_TIMEOUT_MS" },
];

/**
 * Format milliseconds as a compact duration (3s, 2min, 30min, 24h).
 * @param {number} ms
 * @returns {string}
 */
export function formatMs(ms) {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s}s`;
  const m = s / 60;
  if (m < 60) return `${Number.isInteger(m) ? m : m.toFixed(1)}min`;
  const h = m / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}

/**
 * Merge one leaf into the last saved object and PATCH the whole key.
 * Full-object writes are atomic server-side, so concurrent cell edits can't
 * clobber each other the way read-modify-write of a stale draft could.
 *
 * @param {object} base Last saved object (or defaults).
 * @param {Array<string>} leafPath Path to the leaf (e.g. ["502", "tries"]).
 * @param {*} leafValue New leaf value.
 * @returns {object} New object.
 */
export function mergeLeaf(base, leafPath, leafValue) {
  const next = { ...(base && typeof base === "object" ? base : {}) };
  let node = next;
  for (let i = 0; i < leafPath.length - 1; i += 1) {
    const key = leafPath[i];
    node[key] = { ...(node[key] && typeof node[key] === "object" ? node[key] : {}) };
    node = node[key];
  }
  node[leafPath[leafPath.length - 1]] = leafValue;
  return next;
}

/**
 * PATCH all four reliability keys in one request (atomic restore-defaults).
 * @returns {Promise<object>} Safe settings echoed by the server.
 */
export async function patchAllReliability() {
  const body = {};
  for (const key of RELIABILITY_KEYS) body[key] = RELIABILITY_UI_DEFAULTS[key];
  const res = await fetch("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to save setting");
  return data;
}
