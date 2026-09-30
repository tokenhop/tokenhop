/**
 * Shared plain-English formatters live in `@/shared/utils/format` (moved there
 * for the shared routes map, YAN-412); this module keeps the Home-only
 * helpers and re-exports the shared ones so existing imports stay stable.
 */
export { formatCompact, timeAgo, formatReset } from "@/shared/utils/format";

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
  if (num >= 1000) return `${Math.round((num / 1000) * 10) / 10}s`;
  return `${Math.round(num)}ms`;
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
