// YAN-358: browser-mutation guard for the password routes. Cross-site when the
// fetch metadata says so, or when an Origin header names another host. A
// missing Origin (non-browser client) is left to the route's session check.
export function isCrossSite(request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== request.nextUrl.host;
  } catch {
    return true;
  }
}

export function isJson(request) {
  return (request.headers.get("content-type") || "").toLowerCase().includes("application/json");
}
