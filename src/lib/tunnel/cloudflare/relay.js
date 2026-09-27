// Optional stable-URL relay for Cloudflare quick tunnels.
//
// A quick tunnel gets a new *.trycloudflare.com hostname on every start. A relay
// worker can hand out a stable `r<shortId>.<relay host>` URL instead, but only if
// you run one yourself: set TUNNEL_WORKER_URL to its https origin. Unset (the
// default) means no relay — nothing is registered with any third party and the
// direct tunnel URL is the public URL.

/**
 * Parse TUNNEL_WORKER_URL. Empty means "no relay"; anything else must be a
 * valid https URL, otherwise startup fails instead of silently misrouting.
 * @param {string|undefined} raw
 * @returns {{ origin: string, host: string } | null}
 */
export function parseRelayUrl(raw) {
  const value = (raw || "").trim();
  if (!value) return null;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`TUNNEL_WORKER_URL is not a valid URL: ${value}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`TUNNEL_WORKER_URL must use https: ${value}`);
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`TUNNEL_WORKER_URL must be a bare https origin: ${value}`);
  }
  return { origin: url.origin, host: url.host };
}

/**
 * The URL clients should use for the tunnel: the relay URL when a relay is
 * configured, otherwise the direct tunnel URL.
 * @param {{ shortId?: string, tunnelUrl?: string, relay?: { host: string } | null }} opts
 * @returns {string}
 */
export function buildPublicUrl({ shortId, tunnelUrl, relay }) {
  if (relay && shortId) return `https://r${shortId}.${relay.host}`;
  return tunnelUrl || "";
}
