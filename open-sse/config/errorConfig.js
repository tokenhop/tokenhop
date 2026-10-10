// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" },
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout",
};

// Exponential backoff config for rate limits
export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15,
};

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 30 * 1000;

// Hard cap for provider-reported rate limit cooldown (e.g. codex resets_at can be 5-6h)
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

// Anthropic subscription 400 when a feature billed only to extra usage (e.g. fast
// mode) finds no credits left. No leading "You're" so either apostrophe matches.
export const EXTRA_USAGE_EXHAUSTED_TEXT = "out of extra usage";

// Cooldown durations (ms)
const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
  none: 0,
};

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, cooldownMs?, backoff? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - cooldownMs: fixed cooldown duration
 *   - backoff: true = use exponential backoff (rate limit)
 */
export const ERROR_RULES = [
  // --- Text-based rules (checked first, order = priority) ---
  { text: "no credentials", cooldownMs: COOLDOWN.long },
  { text: "request not allowed", cooldownMs: COOLDOWN.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  { text: "rate limit", backoff: true },
  { text: "too many requests", backoff: true },
  { text: "quota exceeded", backoff: true },
  // Can be scoped to one request (a feature billed to extra usage), so rotate to the
  // next account/combo model without locking this one: a lock would block requests
  // the plan still covers. Once every account is tried, the client gets the
  // upstream's actionable message.
  { text: EXTRA_USAGE_EXHAUSTED_TEXT, cooldownMs: COOLDOWN.none },
  { text: "capacity", backoff: true },
  { text: "overloaded", backoff: true },
  // Codex returns 400 when the account's ChatGPT plan can't serve the model.
  // Lock that model on this account (model-scoped lock) so other accounts and
  // combo members are tried instead (YAN-660).
  { text: "not supported when using codex with a chatgpt account", cooldownMs: COOLDOWN.long },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 429, backoff: true },
];

// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};

// --- Billing / credit exhaustion (YAN-1041) ---
// Account-wide lock (connection.billingLock), not a model lock; only API-key
// connections can be locked (enforced in src/sse/services/auth.js). Generic
// 400/403/429 are NEVER billing: only the specific wording / structured codes
// below. A 429 rate_limit_exceeded / slow_down stays an ordinary transient limit.
export const BILLING_RULES = {
  // Anthropic 400 invalid_request_error. Wording is empirical/undocumented
  // (no Anthropic API returns prepaid balance for an inference key).
  anthropic: {
    // Real Anthropic API-key endpoints only. `claude` (Claude Code OAuth) is
    // subscription traffic with its own extra-usage handling and is not listed.
    providers: ["anthropic"],
    status: 400,
    texts: [
      "credit balance is too low",
      "specified api usage limits",
      "specified workspace api usage limits",
    ],
  },
  // Structured upstream codes (OpenAI 429 error.code / error.type, Anthropic 429
  // error.details.error_code). parseUpstreamError surfaces them as `[code=...]`.
  codes: [
    "credit_balance_exhausted",
    "insufficient_quota",
    "billing_hard_limit_reached",
    "billing_not_active",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
    "enforced_spend_limit_reached",
  ],
  // 403 is deliberately absent: a manufactured "insufficient_quota" on a plain
  // 403 must never classify; only a structured upstream code on 402/429 does.
  codeStatuses: [402, 429],
  // Plain 402 counts for API-key connections, except providers with their own
  // special 402 handling (grok-cli spending-limit, commandcode).
  statuses: [402],
  excludedProviders: ["grok-cli", "commandcode"],
};

// Structured upstream codes are appended to the error text as `[code=a,b]` so
// text-based classification (chat.js loop and combo.js) sees them independently.
export const UPSTREAM_CODE_MARKER = "code=";

export const BILLING_LOCK_REASON = "credit_exhausted";
export const BILLING_UNAVAILABLE_MESSAGE = "Connection out of credit";

// Fixed persisted messages (per trigger reason): NEVER upstream free text,
// so no secret or PII can reach the lock or the probe route response.
export const BILLING_LOCK_MESSAGES = {
  credit: "Upstream reported exhausted credit or spend limit",
  limit: "Upstream reported a spend or usage limit",
  payment: "Upstream requires payment to continue",
};

// Only API-key connections can hold a billing lock (subscription/OAuth plans
// have their own extra-usage handling and no per-token bill).
export const BILLING_LOCK_AUTH_TYPES = ["apikey", "api_key"];

// Background recovery probe: ONE minimal real inference through the shared
// executor (a models list / auth check / count_tokens does not prove billable
// inference works). Only allowlisted providers whose probe target resolves
// (pinned override or cheapest priced non-reasoning registry chat model) can be
// billing-locked, so a connection can never be locked with no way to recover
// it. No fallback to "the provider's first model": that may be the most
// expensive one.
export const BILLING_PROBE_CONFIG = {
  intervalMs: 3 * 60 * 60 * 1000, // default re-probe interval
  jitterRatio: 0.1, // +/-10% of the interval
  concurrency: 2,
  timeoutMs: 30 * 1000,
  tickMs: 60 * 1000, // scheduler wake-up; per-connection nextProbeAt gates probes
  prompt: "hi",
  // Manual "probe now" cooldown (server-side, enforced inside the DB claim).
  manualMinIntervalMs: 5 * 60 * 1000,
  // Pinned overrides below: format = request/response shape the validator
  // checks; maxTokens is the provider's documented minimum. Any probe model must
  // also have pricing config (getPricingForModel), otherwise the probe refuses
  // to run rather than spend on an unpriced model.
  // Research-derived: max_tokens:1 is documented-safe ONLY for these
  // providers; everything else is excluded until its safe minimum is verified
  // (never inferred from the transport format). Entries here are explicit
  // pinned overrides; allowlisted providers without an override pick the
  // cheapest priced non-reasoning chat model from the registry.
  // `claude` (Claude Code) is the OAuth/subscription provider (registry
  // category "oauth") and stays out: no billing lock can be set on it.
  providers: {
    // Anthropic Messages accepts max_tokens:1 with thinking off; the cheapest
    // PRICED model is the Haiku entry (kept in the `claude` registry).
    // OpenRouter: documented max_tokens >= 1, but selection needs a priced
    // non-reasoning registry model (none in the static registry — live catalog),
    // so it resolves to an explicit exclusion until one is pinned here.
    anthropic: {
      format: "claude",
      model: "claude-haiku-4-5-20251001",
      maxTokens: 1,
      maxTokensField: "max_tokens",
    },
    // DeepSeek pro/max models are thinking-only; the cheapest chat model accepts
    // max_tokens:1. Registry-driven selection also proves this, but it is pinned
    // so the probe never picks a thinking sibling if pricing changes.
    deepseek: {
      format: "openai",
      model: "deepseek-chat",
      maxTokens: 1,
      maxTokensField: "max_tokens",
      disableThinking: true,
    },
  },
  // Sources (YAN-1041 research): api-docs.deepseek.com/api/create-chat-completion
  // documents max_tokens >= 1 + thinking disable; openrouter.ai/docs
  // /api_reference/parameters.md documents max_tokens >= 1 (mandatory-reasoning
  // models CANNOT disable reasoning and are excluded from probe selection).
  // Groq/MiniMax/GLM docs do not establish a min-1 contract and their reasoning
  // models may burn reasoning budget on empty replies — excluded until each
  // provider's safe minimum is verified. Never inferred from transport format.
  allowlist: ["anthropic", "openai", "deepseek", "openrouter"],
  // Internal accounting tag for the request-detail row (never a user-stats row).
  usageEndpoint: "/internal/billing-probe",
};

// Allowlisted probe failure codes persisted as billingLock.lastProbeError —
// upstream free text is NEVER stored there.
export const BILLING_PROBE_ERROR_CODES = [
  "billing", // still exhausted
  "auth", // 401/403
  "rate_limited", // 429 non-billing
  "server_error", // 5xx
  "timeout",
  "network",
  "invalid_response", // 200 but empty/invalid completion
  "probe_model_unavailable", // 404 / model-specific 400 / missing pricing or spec
  "unknown",
];
