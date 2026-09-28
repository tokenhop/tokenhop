/**
 * Pure formatters for the Test-this-route panel (YAN-299). Kept JSX-free so
 * vitest can import them without a DOM transform; the component lives in
 * RouteTestPanel.js.
 */

/**
 * Format a latency in ms the way the board shows it: "180ms" under a second,
 * "1.20s" / "1.38s" above.
 * @param {number} ms - Latency in milliseconds.
 * @returns {string} Formatted latency.
 */
export function formatProbeLatency(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(2)}s`;
}

/**
 * "Last run 2 min ago" relative label for a probe timestamp.
 * @param {string|null} iso - ISO timestamp of the last run.
 * @param {number} [now] - Now in ms (injectable for tests).
 * @returns {string|null} Relative label, or null when never run.
 */
export function probeLastRunLabel(iso, now = Date.now()) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const diffSec = Math.max(0, Math.round((now - t) / 1000));
  if (diffSec < 10) return "Last run just now";
  if (diffSec < 60) return `Last run ${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `Last run ${diffMin} min ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `Last run ${diffH}h ago`;
  return `Last run ${Math.floor(diffH / 24)}d ago`;
}
