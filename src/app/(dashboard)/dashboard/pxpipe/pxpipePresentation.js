const REASON_LABELS = {
  applied: "Prompt exceeded threshold",
  below_threshold: "Below size threshold",
  not_profitable: "Compression not profitable",
  below_min_chars: "Below minimum chars",
  below_min_tokens: "Below minimum tokens",
  unsupported_model: "Model not in allowlist",
  unsupported_format: "Non-Claude request format",
  timeout: "Compression timed out",
  transform_error: "Transform error",
  passthrough: "Passthrough",
  disabled: "Disabled",
  not_installed: "Not installed",
};

/**
 * Format a token count compactly (999, 1.5K, 2.50M).
 *
 * @param {number} n Token count.
 * @returns {string} Compact label.
 */
export function formatTokens(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n || 0);
}

/**
 * Format an uptime duration in ms (5m, 2h10m, or an em dash when unknown).
 *
 * @param {number} ms Uptime in milliseconds.
 * @returns {string} Human label.
 */
export function formatUptime(ms) {
  if (!ms || ms <= 0) return "—";
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

/**
 * Resolve the PXPIPE service status label.
 *
 * @param {object|null} status `/api/pxpipe/status` payload.
 * @param {object|null} health `/api/pxpipe/health` payload.
 * @returns {string} Status label.
 */
export function statusLabel(status, health) {
  if (!status) return "—";
  if (!status.installed) return "Not installed";
  if (health?.healthy) return "Healthy";
  if (status.running) return "Running";
  return "Stopped";
}

/**
 * Map a PXPIPE skip reason code to a human label, falling back to raw.
 *
 * @param {string} reason Reason code from stats events.
 * @returns {string} Human label.
 */
export function reasonLabel(reason) {
  return REASON_LABELS[reason] || reason;
}
