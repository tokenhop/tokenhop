// Claude Code client fingerprint — the identity tokenhop presents to Anthropic
// on OAuth (`claude` provider) traffic.
//
// Defaults were captured from a real Claude Code 2.1.280 `/v1/messages` request.
// These values ship together in every Claude Code release, so when bumping
// CLAUDE_CLI_VERSION, re-capture and bump the rest too (see .env.example):
//   CLAUDE_CLI_VERSION          → User-Agent `claude-cli/<v>` + billing `cc_version=<v>.<build>`
//   CLAUDE_CLI_SDK_VERSION      → X-Stainless-Package-Version (bundled @anthropic-ai/sdk)
//   CLAUDE_CLI_RUNTIME_VERSION  → X-Stainless-Runtime-Version (Node version the CLI reports)
//   CLAUDE_CLI_BETA_FLAGS       → Anthropic-Beta base list (comma-separated)
//
// Env values are validated at module load: a malformed override throws instead
// of silently sending a fingerprint no real client would produce.

import { envString, envList } from "./envOverride.js";

const SEMVER = /^\d+\.\d+\.\d+$/;
const NODE_VERSION = /^v\d+\.\d+\.\d+$/;
const BETA_FLAG = /^[a-z0-9]+(?:-[a-z0-9]+)*-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;

export const CLAUDE_CLI_VERSION = envString("CLAUDE_CLI_VERSION", "2.1.280", SEMVER);
export const CLAUDE_CLI_SDK_VERSION = envString("CLAUDE_CLI_SDK_VERSION", "0.112.1", SEMVER);
export const CLAUDE_CLI_RUNTIME_VERSION = envString(
  "CLAUDE_CLI_RUNTIME_VERSION",
  "v26.3.0",
  NODE_VERSION,
);
export const CLAUDE_CLI_USER_AGENT = `claude-cli/${CLAUDE_CLI_VERSION} (external, sdk-cli)`;

// Sent by Claude Code 2.1.280 on every OAuth request regardless of model, plus
// flags tokenhop's own features depend on (structured outputs, redacted thinking —
// the latter is dropped per-request in selectAnthropicBeta). The fast-mode beta is
// not here: fast mode bills only from extra usage, so selectAnthropicBeta adds it
// per request, when the body opts in.
export const CLAUDE_CLI_BETA_FLAGS = envList(
  "CLAUDE_CLI_BETA_FLAGS",
  [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "thinking-token-count-2026-05-13",
    "context-management-2025-06-27",
    "prompt-caching-scope-2026-01-05",
    "mid-conversation-system-2026-04-07",
    "extended-cache-ttl-2025-04-11",
    "structured-outputs-2025-12-15",
    "redact-thinking-2026-02-12",
  ],
  BETA_FLAG,
);
