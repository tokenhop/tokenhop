// Usage hub switch and provider set (YAN-2019, YAN-2447). Pure: safe to
// import from the edge, the hub routes and the quota snapshot poller.

export const USAGE_HUB_ENV = "TOKENHOP_USAGE_HUB";

/**
 * The usage hub switch: on only for exactly `TOKENHOP_USAGE_HUB=on`. Off (the
 * default) hides the hub routes and key management and keeps the poller's
 * start rule unchanged. Read per call so tests and restarts see the env.
 */
export function isUsageHubEnabled() {
  return process.env[USAGE_HUB_ENV] === "on";
}

/**
 * Providers the T3 Code usage hub lists (YAN-2018 contract §7). grok-cli
 * joins once its quota snapshots record usage windows (YAN-2446).
 */
export const HUB_PROVIDERS = Object.freeze(["claude", "codex", "antigravity"]);
