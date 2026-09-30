// Grok CLI version reported to cli-chat-proxy.grok.com and auth.x.ai on
// `grok-cli` traffic: User-Agent `grok-shell/<v>` + x-grok-client-version.
// Upstream returns 426 for clients older than its minimum supported version.
// Bump the default with `grok --version`, or set GROK_CLI_VERSION; a malformed
// value throws at module load.

import { envString } from "./envOverride.js";

export const GROK_CLI_VERSION = envString("GROK_CLI_VERSION", "1.0.44", /^\d+\.\d+\.\d+$/);
export const GROK_CLI_MODEL = "grok-build";
export const GROK_CLI_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
export const GROK_CLI_CLIENT_IDENTIFIER = "grok-shell";
export const GROK_CLI_USER_AGENT = `grok-shell/${GROK_CLI_VERSION} (linux; x86_64)`;

export function supportsGrokCliReasoningEffort(model) {
  // ponytail: unknown models omit effort until live metadata reaches dispatch.
  return /^grok-4\.5(?:$|-)/.test(String(model || ""));
}
