import { platform, arch } from "os";
import {
  CLAUDE_CLI_VERSION,
  CLAUDE_CLI_SDK_VERSION,
  CLAUDE_CLI_RUNTIME_VERSION,
  CLAUDE_CLI_USER_AGENT,
  CLAUDE_CLI_BETA_FLAGS,
  BETA_FLAG,
} from "../config/claudeCliFingerprint.js";

export { CLAUDE_CLI_VERSION, CLAUDE_CLI_USER_AGENT };

// === OS/Arch helpers (Stainless fingerprint) ===
export function mapStainlessOs() {
  switch (platform()) {
    case "darwin":
      return "MacOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    case "freebsd":
      return "FreeBSD";
    default:
      return `Other::${platform()}`;
  }
}

export function mapStainlessArch() {
  switch (arch()) {
    case "x64":
      return "x64";
    case "arm64":
      return "arm64";
    case "ia32":
      return "x86";
    default:
      return `other::${arch()}`;
  }
}

// Anthropic API version (single source — reused across claude-format providers/executors)
export const ANTHROPIC_API_VERSION = "2023-06-01";

// Shared Claude-compatible API headers (reused across claude-format providers)
export const CLAUDE_API_HEADERS = {
  "Anthropic-Version": ANTHROPIC_API_VERSION,
  "Anthropic-Beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
};

const ANTHROPIC_BETA_HEAVY_AGENT = ["advanced-tool-use-2025-11-20", "effort-2025-11-24"];

// Heavy-agent beta flags are gated to opus/sonnet — cheaper models don't need them.
// `redact-thinking` asks Anthropic to return signature-only thinking blocks, which
// is right for clients that never render thinking but blanks the summaries a
// client explicitly requested with `thinking.display: "summarized"`.
const ANTHROPIC_BETA_REDACT_THINKING = "redact-thinking-2026-02-12";

// Fast mode bills only from extra usage, even with plan usage left, so the beta
// is sent only when the request opts in with `speed: "fast"` (as Claude Code does) —
// even if a CLAUDE_CLI_BETA_FLAGS override lists it.
export const ANTHROPIC_BETA_FAST_MODE = "fast-mode-2026-02-01";

export function isFastModeRequest(body) {
  return body?.speed === "fast";
}

/**
 * Full Claude CLI fingerprint headers (base list + heavy-agent betas), as sent
 * for an opus/sonnet request. Callers that know the model should override
 * Anthropic-Beta with selectAnthropicBeta().
 * @param {{ os?: string, arch?: string }} [host] - X-Stainless-Os/Arch; defaults to this host
 */
export function buildClaudeCliHeaders({
  os = mapStainlessOs(),
  arch: cpuArch = mapStainlessArch(),
} = {}) {
  return {
    "Anthropic-Version": ANTHROPIC_API_VERSION,
    // Static headers never see a request body, so they never opt into fast mode.
    "Anthropic-Beta": [
      ...CLAUDE_CLI_BETA_FLAGS.filter((flag) => flag !== ANTHROPIC_BETA_FAST_MODE),
      ...ANTHROPIC_BETA_HEAVY_AGENT,
    ].join(","),
    "Anthropic-Dangerous-Direct-Browser-Access": "true",
    "User-Agent": CLAUDE_CLI_USER_AGENT,
    "X-App": "cli",
    "X-Stainless-Retry-Count": "0",
    "X-Stainless-Runtime-Version": CLAUDE_CLI_RUNTIME_VERSION,
    "X-Stainless-Package-Version": CLAUDE_CLI_SDK_VERSION,
    "X-Stainless-Runtime": "node",
    "X-Stainless-Lang": "js",
    "X-Stainless-Arch": cpuArch,
    "X-Stainless-Os": os,
    "X-Stainless-Timeout": "600",
  };
}

// Full Claude CLI fingerprint — required by providers that gate on client identity (e.g. agentrouter)
export const CLAUDE_CLI_SPOOF_HEADERS = buildClaudeCliHeaders();

export function wantsThinkingSummaries(body) {
  return body?.thinking?.display === "summarized";
}

export function selectAnthropicBeta(model = "", body = null) {
  const dropRedactThinking = wantsThinkingSummaries(body);
  const flags = CLAUDE_CLI_BETA_FLAGS.filter(
    (flag) =>
      flag !== ANTHROPIC_BETA_FAST_MODE &&
      !(flag === ANTHROPIC_BETA_REDACT_THINKING && dropRedactThinking),
  );
  if (/^claude-(opus|sonnet)/.test(model)) flags.push(...ANTHROPIC_BETA_HEAVY_AGENT);
  if (isFastModeRequest(body)) flags.push(ANTHROPIC_BETA_FAST_MODE);
  return flags.join(",");
}

// Merge a native Claude Code client's own anthropic-beta into the selected list
// (YAN-655: new body fields like `safeguards` need their flag). Client flags must
// be well-formed and can't override the gateway's deliberate choices: no 1M
// context (the [1m] marker is stripped), no redact-thinking when summaries were
// asked for, and fast mode (extra-usage billing) only when the body opts in.
export function mergeClientAnthropicBeta(selected, clientBeta, body = null) {
  const keepRedact = !wantsThinkingSummaries(body);
  const keepFast = isFastModeRequest(body);
  const client = String(clientBeta || "")
    .split(",")
    .map((s) => s.trim())
    .filter(
      (flag) =>
        BETA_FLAG.test(flag) &&
        !flag.startsWith("context-1m-") &&
        (keepRedact || flag !== ANTHROPIC_BETA_REDACT_THINKING) &&
        (keepFast || flag !== ANTHROPIC_BETA_FAST_MODE),
    );
  const base = String(selected || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...base, ...client])].join(",");
}

// True when an anthropic-compatible base URL targets official Anthropic
// (empty → ANTHROPIC_COMPAT_BASE). Exact host, not a substring match.
export function isOfficialAnthropicBaseUrl(baseUrl) {
  if (!baseUrl) return true;
  try {
    return new URL(baseUrl).hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}

// Shared baseUrls
export const KIMI_CODING_BASE_URL = "https://api.kimi.com/coding/v1/messages";

// Default base for dynamic compat providers (openai-compatible-* / anthropic-compatible-*) when user gives no baseUrl
export const OPENAI_COMPAT_BASE = "https://api.openai.com/v1";
export const ANTHROPIC_COMPAT_BASE = "https://api.anthropic.com/v1";

// Official Antigravity IDE Desktop 2.11.0 fingerprint captured from macOS arm64.
// Keep this static even when tokenhop runs on Linux: the provider profile is
// intentionally matching the IDE client, not the server host.
export const ANTIGRAVITY_IDE_VERSION = "2.11.0";
export const ANTIGRAVITY_IDE_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_IDE_USER_AGENT = `antigravity/ide/${ANTIGRAVITY_IDE_VERSION} darwin/arm64`;

// Google "installed app" OAuth clients (Antigravity IDE, Gemini CLI). Kept out of
// source control — supply them via env. When unset, OAuth login and token refresh
// for these providers fail with an error naming the missing variables.
const OAUTH_CLIENT_ENV = {
  antigravity: ["ANTIGRAVITY_OAUTH_CLIENT_ID", "ANTIGRAVITY_OAUTH_CLIENT_SECRET"],
  gemini: ["GEMINI_OAUTH_CLIENT_ID", "GEMINI_OAUTH_CLIENT_SECRET"],
};

function oauthClientFromEnv([idVar, secretVar]) {
  return {
    clientId: process.env[idVar]?.trim() || undefined,
    clientSecret: process.env[secretVar]?.trim() || undefined,
  };
}

// Antigravity OAuth client (shared by the antigravity registry, usage.js and src/lib/oauth)
export const ANTIGRAVITY_OAUTH_CLIENT = oauthClientFromEnv(OAUTH_CLIENT_ENV.antigravity);

// Gemini (Google) OAuth client (shared by gemini, gemini-cli and src/lib/oauth)
export const GOOGLE_OAUTH_CLIENT = oauthClientFromEnv(OAUTH_CLIENT_ENV.gemini);

/**
 * Throw if a Google OAuth client was not configured via env.
 * @param {{ clientId?: string, clientSecret?: string }} client
 * @param {"antigravity"|"gemini"} kind
 */
export function assertOAuthClient({ clientId, clientSecret } = {}, kind) {
  if (clientId && clientSecret) return;
  throw new Error(
    `${kind} OAuth client not configured: set ${OAUTH_CLIENT_ENV[kind].join(" and ")}`,
  );
}
