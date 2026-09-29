/**
 * Shared plain-English formatters (moved from the Home command center).
 * No React/DOM. All output is plain English literals (translated at render).
 */

/**
 * Compact number: 2481 -> "2.5k", 1200000 -> "1.2M".
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
