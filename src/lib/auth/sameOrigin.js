// Next nextUrl can reflect the bind host behind proxies. BASE_URL (then
// NEXT_PUBLIC_BASE_URL) is the authoritative browser-facing origin, read at runtime.
// Forwarded headers are deliberately ignored: clients can forge them.
// Missing Origin leaves authentication to the route's session/token checks.
const warnedKeys = new Set();

export function isCrossSite(request) {
  try {
    if (request.headers.get("sec-fetch-site") === "cross-site") return true;
    const rawOrigin = request.headers.get("origin");
    if (rawOrigin === null) return false;
    const origin = new URL(rawOrigin);
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      /[?#]/.test(rawOrigin)
    )
      return true;

    const baseUrl = (process.env.BASE_URL || "").trim();
    const key = baseUrl ? "BASE_URL" : "NEXT_PUBLIC_BASE_URL";
    const configured = baseUrl || (process.env.NEXT_PUBLIC_BASE_URL || "").trim();
    if (configured) {
      let canonical;
      try {
        canonical = new URL(configured);
        if (
          !["http:", "https:"].includes(canonical.protocol) ||
          canonical.username ||
          canonical.password ||
          canonical.search ||
          canonical.hash ||
          /[?#]/.test(configured)
        )
          canonical = null;
      } catch {
        canonical = null;
      }
      if (!canonical) {
        if (!warnedKeys.has(key)) {
          warnedKeys.add(key);
          console.warn(`[auth] Invalid ${key}; rejecting Origin-bearing requests.`);
        }
        return true;
      }
      return canonical.origin !== origin.origin;
    }

    const host = request.headers.get("host");
    if (!host || /[/?#@\s]/.test(host)) return true;
    const validated = new URL(`http://${host}`);
    if (validated.username || validated.password || validated.pathname !== "/") return true;
    // Reparse with Origin's scheme to strip its default port, preserving IPv6.
    return new URL(`${origin.protocol}//${host}`).host !== origin.host;
  } catch {
    return true;
  }
}

export function isJson(request) {
  return (request.headers.get("content-type") || "").toLowerCase().includes("application/json");
}
