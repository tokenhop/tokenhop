const PROXY_ERROR_PREFIX = "[ProxyFetch]";
const PROXY_ERROR_CODES = new Set([
  "ERR_RELAY_OUTDATED",
  "ERR_PINNED_RELAY",
  "ERR_PINNED_MISUSE",
  "ERR_REDIRECT_REFUSED",
]);

export const UPSTREAM_PROXY_ERROR = Object.freeze({
  status: 502,
  message: "Upstream proxy unavailable",
});
export const UPSTREAM_REDIRECT_REFUSED_ERROR = Object.freeze({
  status: 502,
  message: "Upstream redirect refused",
});

function scrubSensitiveUrlText(text) {
  return String(text)
    .replace(/\/\/[^/@\s]+@/g, "//")
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s)]*/g, "$1");
}

function proxyErrorDetail(error) {
  const parts = [];
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && depth < 4 && !seen.has(current); depth += 1) {
    seen.add(current);
    const message = scrubSensitiveUrlText(current.message || String(current));
    parts.push(current.code ? `${current.code}: ${message}` : message);
    current = current.cause;
  }
  return parts.join(" | caused by: ");
}

/**
 * Identify failures raised by the outbound proxy layer rather than a provider.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isProxyFetchError(error) {
  if (!error || typeof error !== "object") return false;
  return (
    (typeof error.message === "string" && error.message.startsWith(PROXY_ERROR_PREFIX)) ||
    PROXY_ERROR_CODES.has(error.code)
  );
}

/**
 * Log internal proxy detail and return the stable client-facing error envelope.
 * @param {unknown} error
 * @param {string} [context]
 * @returns {{ status: 502, message: string } | null}
 */
export function mapProxyFetchError(error, context = "Gateway") {
  if (!isProxyFetchError(error)) return null;
  const detail = proxyErrorDetail(error);
  console.warn(`[${context}] Upstream proxy request failed: ${detail}`);
  if (error.code === "ERR_REDIRECT_REFUSED") return { ...UPSTREAM_REDIRECT_REFUSED_ERROR };
  return { ...UPSTREAM_PROXY_ERROR };
}

/**
 * Preserve existing non-proxy errors while hiding internal proxy detail.
 * @param {unknown} error
 * @param {string} fallback
 * @param {string} [context]
 * @returns {string}
 */
export function clientErrorMessage(error, fallback, context) {
  return mapProxyFetchError(error, context)?.message || error?.message || fallback;
}
