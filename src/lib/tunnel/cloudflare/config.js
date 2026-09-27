import { parseRelayUrl } from "./relay.js";

// Cloudflare quick tunnel: DNS propagates fast, short timeouts OK
export const HEALTH_CHECK = {
  intervalMs: 2000,
  timeoutMs: 60000,
  fetchTimeoutMs: 5000,
  dnsTimeoutMs: 2000,
};

let cachedRelay;

/**
 * The opt-in tunnel relay: null unless TUNNEL_WORKER_URL points at a relay you
 * run yourself. Parsed on first use (not at import) so a bad value fails the
 * tunnel calls that need it instead of every page that imports this module.
 * @returns {{ origin: string, host: string } | null}
 */
export function getTunnelRelay() {
  if (cachedRelay === undefined) cachedRelay = parseRelayUrl(process.env.TUNNEL_WORKER_URL);
  return cachedRelay;
}
