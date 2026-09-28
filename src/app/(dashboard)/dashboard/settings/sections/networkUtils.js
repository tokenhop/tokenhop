/**
 * Pure display/gate helpers for the Settings Network section.
 * Kept free of JSX so `tests/unit/settings-network.test.js` can import
 * them in the node environment.
 *
 * Tunnel/Tailscale state mirrors the Endpoint page (`EndpointPageClient.js`):
 * `settingsEnabled` is user intent (survives watchdog restarts), `enabled`
 * means the process is actually reachable.
 */

/**
 * @typedef {object} TunnelProbe
 * @property {boolean} [enabled] Process running and reachable.
 * @property {boolean} [settingsEnabled] User intent (toggle state).
 * @property {string} [tunnelUrl] Direct tunnel URL.
 * @property {string} [publicUrl] Public shortlink (Cloudflare only).
 */

/**
 * Pill for a tunnel/tailscale probe.
 * @param {TunnelProbe|null|undefined} probe GET /api/tunnel/status entry.
 * @returns {{ label: string, variant: "ok"|"warn"|"neutral" }}
 */
export function tunnelDisplay(probe) {
  if (!probe) return { label: "Checking", variant: "neutral" };
  if (probe.enabled) return { label: "Connected", variant: "ok" };
  if (probe.settingsEnabled) return { label: "Starting", variant: "warn" };
  return { label: "Off", variant: "neutral" };
}

/**
 * Pill for a tailscale probe (same shape as tunnel).
 * @param {TunnelProbe|null|undefined} probe GET /api/tunnel/status entry.
 * @returns {{ label: string, variant: "ok"|"warn"|"neutral" }}
 */
export function tailscaleDisplay(probe) {
  return tunnelDisplay(probe);
}

/**
 * Security gate for the Cloudflare tunnel toggle. Same gates as the
 * Endpoint page: login must be on with a custom password, and the API key
 * must be required (the tunnel is public).
 * @param {{ requireLogin: boolean, hasPassword: boolean, requireApiKey: boolean }} flags
 * @returns {string} Empty when the toggle may be used, otherwise the reason.
 */
export function tunnelGateReason({ requireLogin, hasPassword, requireApiKey }) {
  if (!requireLogin) {
    return 'Enable "Require login" and set a custom password before activating the tunnel.';
  }
  if (!hasPassword) {
    return "Change the default dashboard password before activating the tunnel.";
  }
  if (!requireApiKey) {
    return 'Enable "Require API key" before activating the tunnel.';
  }
  return "";
}

/**
 * Security gate for the Tailscale toggle. Same gates as the Endpoint page:
 * login must be on with a custom password (no API-key requirement).
 * @param {{ requireLogin: boolean, hasPassword: boolean }} flags
 * @returns {string} Empty when the toggle may be used, otherwise the reason.
 */
export function tailscaleGateReason({ requireLogin, hasPassword }) {
  if (!requireLogin) {
    return 'Enable "Require login" and set a custom password before activating Tailscale.';
  }
  if (!hasPassword) {
    return "Change the default dashboard password before activating Tailscale.";
  }
  return "";
}
