import { BRAND, LEGACY } from "../../src/shared/brand/index.js";

// HTTP status codes
export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_ACCEPTABLE: 406,
  REQUEST_TIMEOUT: 408,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
};

// Dashboard endpoint tag for combo dry-run probes (YAN-299). Probe usage rows
// carry this endpoint and are excluded from aggregated stats/cost.
export const COMBO_PROBE_ENDPOINT = "/api/combos/probe";

// Re-export error config (backward compat)
export { ERROR_TYPES, DEFAULT_ERROR_MESSAGES, BACKOFF_CONFIG, COOLDOWN_MS } from "./errorConfig.js";

// Cache TTLs (seconds)
export const CACHE_TTL = {
  userInfo: 300, // 5 minutes
  modelAlias: 3600, // 1 hour
};

// Memory management config
export const MEMORY_CONFIG = {
  sessionTtlMs: 2 * 60 * 60 * 1000,
  sessionCleanupIntervalMs: 30 * 60 * 1000,
  dnsCacheTtlMs: 5 * 60 * 1000,
  proxyDispatchersMaxSize: 20,
};

// Parse a positive integer env override, falling back to a default.
function envMs(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function envUrl(name, def) {
  const raw = process.env[name]?.trim();
  return raw || def;
}

// SearXNG endpoint used by the unauthenticated web-search provider.
// Configure this for a separate Docker service or remote SearXNG instance.
export const SEARXNG_URL = envUrl("SEARXNG_URL", "http://localhost:8888/search");

// Inter-chunk stall timeout (once tokens are flowing). Generous headroom so
// slow reasoning models aren't aborted mid-stream. Env: STREAM_STALL_TIMEOUT_MS.
export const STREAM_STALL_TIMEOUT_MS = envMs("STREAM_STALL_TIMEOUT_MS", 360 * 1000);

// Time-to-first-token timeout (prompt prefill). Env: STREAM_FIRST_CHUNK_TIMEOUT_MS.
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = envMs("STREAM_FIRST_CHUNK_TIMEOUT_MS", 200 * 1000);

// Combo empty-stream probe: peek at the head of a 2xx SSE/NDJSON body and skip
// members that stream only role/empty-delta/usage/finish_reason/[DONE].
// Env: COMBO_STREAM_PROBE_MAX_BYTES, COMBO_STREAM_PROBE_MAX_MS.
export const COMBO_STREAM_PROBE_MAX_BYTES = envMs("COMBO_STREAM_PROBE_MAX_BYTES", 262144);
export const COMBO_STREAM_PROBE_MAX_MS = envMs("COMBO_STREAM_PROBE_MAX_MS", 10 * 1000);

// Fetch connect timeout: abort if upstream doesn't return response headers within this duration
export const FETCH_CONNECT_TIMEOUT_MS = envMs("FETCH_CONNECT_TIMEOUT_MS", 60 * 1000);

// Gemini native TTS fetch timeout: abort if Google does not return response headers in time.
export const GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS = envMs(
  "GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS",
  45 * 1000,
);

// Default token limits
export const DEFAULT_MAX_TOKENS = 64000;
export const DEFAULT_MIN_TOKENS = 32000;

// Edit predictions (/v1/completions, /v1/fim/completions, /infill), YAN-736.
// Prompt caps keep the text nearest the cursor: prefix tail, suffix head, context head.
export const FIM_MAX_PREFIX_CHARS = 24_000;
export const FIM_MAX_SUFFIX_CHARS = 8_000;
export const FIM_MAX_CONTEXT_CHARS = 32_000;
export const FIM_MAX_EXTRA_TOTAL_CHARS = 32_000;
// Used when the client sends no max_tokens / max_completion_tokens.
export const FIM_DEFAULT_MAX_TOKENS = 128;
// Per-attempt budget (headers + non-stream body) so combo fallback stays within
// the typing budget. Env: FIM_ATTEMPT_TIMEOUT_MS.
export const FIM_ATTEMPT_TIMEOUT_MS = envMs("FIM_ATTEMPT_TIMEOUT_MS", 8000);
// Usage-row endpoint tag for all edit-prediction routes (dashboard Endpoint breakdown).
export const FIM_USAGE_ENDPOINT = "completions";

// Budget reservation estimates (YAN-372, ADR-0007). Used only when a request
// carries no max_tokens / the model has no pricing entry.
// Env: BUDGET_DEFAULT_MAX_TOKENS, BUDGET_FALLBACK_RESERVE_USD (float).
export const BUDGET_DEFAULT_MAX_TOKENS = envMs("BUDGET_DEFAULT_MAX_TOKENS", 4096);
const fallbackUsd = parseFloat(process.env.BUDGET_FALLBACK_RESERVE_USD);
export const BUDGET_FALLBACK_RESERVE_USD =
  Number.isFinite(fallbackUsd) && fallbackUsd >= 0 ? fallbackUsd : 0.01;
// Hold a reservation after the body ends so the async usage commit settles
// first, and cap a hold whose body is never consumed.
export const BUDGET_SETTLE_GRACE_MS = envMs("BUDGET_SETTLE_GRACE_MS", 2000);
export const BUDGET_RESERVATION_MAX_MS = envMs("BUDGET_RESERVATION_MAX_MS", 30 * 60 * 1000);

// Request input: accepted under either brand, new name first.
export const TOKEN_SAVER_HEADER = `${BRAND.headerPrefix}token-saver`;
export const LEGACY_TOKEN_SAVER_HEADER = `${LEGACY.headerPrefix}token-saver`; // legacy(9router): remove in v2

// Retry config for 429 responses (legacy - kept for backward compatibility)
export const RETRY_CONFIG = {
  maxAttempts: 2,
  delayMs: 2000,
};

// Default retry config by status code: { attempts, delayMs }
// Backward compat: if value is a number, treated as attempts with RETRY_CONFIG.delayMs
export const DEFAULT_RETRY_CONFIG = {
  429: { attempts: 0, delayMs: 0 },
  502: { attempts: 3, delayMs: 3000 },
  503: { attempts: 3, delayMs: 2000 },
  504: { attempts: 2, delayMs: 3000 },
};

// Normalize a retry entry to { attempts, delayMs }
export function resolveRetryEntry(entry) {
  if (entry == null) return { attempts: 0, delayMs: RETRY_CONFIG.delayMs };
  if (typeof entry === "number") return { attempts: entry, delayMs: RETRY_CONFIG.delayMs };
  return {
    attempts: entry.attempts != null ? entry.attempts : entry.tries || 0,
    delayMs: entry.delayMs != null ? entry.delayMs : RETRY_CONFIG.delayMs,
  };
}

// Requests containing these texts will bypass provider
export const SKIP_PATTERNS = ["Please write a 5-10 word title for the following conversation:"];
