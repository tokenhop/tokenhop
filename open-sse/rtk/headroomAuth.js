// Headroom proxy token (Headroom >= 0.37, HEADROOM_PROXY_TOKEN). When the
// sidecar sets it, non-loopback requests to non-exempt paths need this header
// or they get 401. tokenhop reads the token from its own env, server-side only:
// it is never stored, returned by an API, logged or sent to the browser.

export const HEADROOM_PROXY_TOKEN_ENV = "HEADROOM_PROXY_TOKEN";
export const HEADROOM_PROXY_TOKEN_HEADER = "x-headroom-proxy-token";

/** @returns {string|null} The configured token, or null when unset/blank. */
export function getHeadroomProxyToken() {
  const raw = globalThis.process?.env?.[HEADROOM_PROXY_TOKEN_ENV];
  const token = typeof raw === "string" ? raw.trim() : "";
  return token || null;
}

/**
 * Headers for a server-side request to Headroom: `base` plus the proxy token
 * header when HEADROOM_PROXY_TOKEN is set. Read per call so env changes apply.
 * @param {Record<string, string>} [base]
 * @returns {Record<string, string>}
 */
export function headroomRequestHeaders(base = {}) {
  const token = getHeadroomProxyToken();
  return token ? { ...base, [HEADROOM_PROXY_TOKEN_HEADER]: token } : { ...base };
}
