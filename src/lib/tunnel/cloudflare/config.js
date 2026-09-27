import { parseRelayUrl } from "./relay.js";

// Cloudflare quick tunnel: DNS propagates fast, short timeouts OK
export const HEALTH_CHECK = {
  intervalMs: 2000,
  timeoutMs: 60000,
  fetchTimeoutMs: 5000,
  dnsTimeoutMs: 2000,
};

// Opt-in only: null unless TUNNEL_WORKER_URL points at a relay you run yourself.
export const TUNNEL_RELAY = parseRelayUrl(process.env.TUNNEL_WORKER_URL);
