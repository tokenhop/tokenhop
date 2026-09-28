/**
 * Pure formatting helpers for the Home command center (YAN-292).
 * No React/DOM. All output is plain English literals (translated at render).
 */

/**
 * Compact number: 2481 -> "2,481" locale grouped is formatInt; compact is 12.4K style.
 * @param {number} value
 * @returns {string}
 */
export function formatCompact(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "0";
  if (Math.abs(num) >= 1_000_000) return `${trimZero(num / 1_000_000)}M`;
  if (Math.abs(num) >= 1_000) return `${trimZero(num / 1_000)}k`;
  return String(Math.round(num));
}

function trimZero(num) {
  return String(Math.round(num * 10) / 10);
}

/**
 * Grouped integer: 2481 -> "2,481".
 * @param {number} value
 * @returns {string}
 */
export function formatInt(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "0";
  return Math.round(num).toLocaleString("en-US");
}

/**
 * USD estimate: 18.4 -> "$18.40".
 * @param {number} value
 * @returns {string}
 */
export function formatMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "$0.00";
  return `$${num.toFixed(2)}`;
}

/**
 * Latency ms -> "1.8s" / "320ms".
 * @param {number} ms
 * @returns {string}
 */
export function formatLatency(ms) {
  const num = Number(ms);
  if (!Number.isFinite(num) || num < 0) return "—";
  if (num >= 1000) return `${trimZero(num / 1000)}s`;
  return `${Math.round(num)}ms`;
}

/**
 * Timestamp -> relative "now" / "12s" / "1m" / "2h" / "3d".
 * @param {string|number|Date} timestamp
 * @param {number} [nowMs]
 * @returns {string}
 */
export function timeAgo(timestamp, nowMs = Date.now()) {
  const then = new Date(timestamp).getTime();
  if (Number.isNaN(then)) return "—";
  const diffSec = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (diffSec < 5) return "now";
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  return `${Math.floor(diffHr / 24)}d`;
}

/**
 * Mask a full API key for display: first 6 + bullets + last 4.
 * Mirrors the endpoint page mask so keys read the same everywhere.
 * @param {string} fullKey
 * @returns {string}
 */
export function maskApiKey(fullKey) {
  if (!fullKey || typeof fullKey !== "string") return "—";
  if (fullKey.length <= 10) return `${fullKey.charAt(0)}••••`;
  return `${fullKey.slice(0, 6)}${"•".repeat(fullKey.length - 10)}${fullKey.slice(-4)}`;
}

/**
 * Reset timestamp -> "Resets in 3h 12m" / "Resets Oct 1" / "" when unknown.
 * @param {string|number|null|undefined} resetsAt
 * @param {number} [nowMs]
 * @returns {string}
 */
export function formatReset(resetsAt, nowMs = Date.now()) {
  if (!resetsAt) return "";
  const then = new Date(resetsAt).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = then - nowMs;
  if (diffMs <= 0) return "Reset pending";
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return `Resets in ${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 48) {
    const rest = diffMin % 60;
    return rest > 0 ? `Resets in ${diffHr}h ${rest}m` : `Resets in ${diffHr}h`;
  }
  const label = new Date(then).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `Resets ${label}`;
}

/**
 * Cached-token share of prompt tokens as a whole percent.
 * @param {number} cachedTokens
 * @param {number} promptTokens
 * @returns {number|null} null when there is no base to divide by
 */
export function cachedShare(cachedTokens, promptTokens) {
  const cached = Number(cachedTokens) || 0;
  const prompt = Number(promptTokens) || 0;
  if (prompt <= 0) return null;
  return Math.round((cached / prompt) * 100);
}
