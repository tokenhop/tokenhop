/**
 * YAN-310 server-side validation for the Settings sections:
 * Routing, Network, Token saver, Providers & models, Observability & logs.
 *
 * Pure module (no imports): the settings PATCH route calls
 * `validateSectionSettings(body)` and returns its message as a 400.
 * Only keys present (own property) are checked; absent keys pass.
 * Unknown top-level keys pass (other pages own them); read-only
 * env/client-pin keys and prototype keys are rejected.
 *
 * Key names, types and defaults verified against code:
 * - defaults: src/lib/db/repos/settingsRepo.js (DEFAULT_SETTINGS)
 * - routing consumers: open-sse/services/comboStrategy.js
 *   (resolveComboStrategy reads `comboStickyRoundRobinLimit` — NOT
 *   `comboStickyLimit`), src/sse/services/auth.js
 * - proxy consumer: src/lib/network/outboundProxy.js (schemes +
 *   char blocklist mirrored here)
 * - auto-ping consumer: src/shared/services/quotaAutoPing.js
 *   (per-connection `connections` maps only, no global toggle)
 * - thinking writers: providers/[id]/page.js (`{ [provider]: { mode } }`)
 * - visibility writers: Quota page (`{ [provider]: { hidden: [] } }`)
 * - observability consumer: requestDetailsRepo.js
 *   (`observabilityMaxJsonSize` is kilobytes — multiplied by 1024 in code)
 */

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Read-only env / client-pin keys: surfaced in UI, never writable via the API.
const READ_ONLY_KEYS = new Set([
  "tunnelProvider",
  "SEARXNG_URL",
  "CLAUDE_CLI_VERSION",
  "CODEX_CLI_VERSION",
  "ZED_CLIENT_VERSION",
  "GROK_CLI_VERSION",
]);

const MAX_URL_LEN = 2048;
const MAX_TEXT_LEN = 2048;

// Control chars must be rejected explicitly: the URL parser strips
// tabs/newlines instead of throwing, which would hide injected headers.
// Biome forbids control-char regex literals, so compare char codes instead.
function hasControlChars(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
// Mirrors validateProxyUrl in src/lib/network/outboundProxy.js.
const PROXY_BAD_CHARS = /[\n\r`$]/;
const PROXY_SCHEMES = new Set(["http:", "https:", "socks5:", "socks4:", "socks5h:", "socks4a:"]);

const ACCOUNT_STRATEGIES = new Set(["fill-first", "round-robin", "weighted"]);
// providerStrategies entries also carry non-routing keys written by other pages:
// NoAuthProxyCard (proxyPoolId, rotateStrategy). Routing validation only checks
// the known keys below and passes the rest through untouched.
const ROTATE_STRATEGIES = new Set(["round-robin", "random"]);
const CAPACITY_ADAPTER_CAPS = new Set(["vision", "pdf", "audioInput", "videoInput"]);
const CAPACITY_ENTRY_KEYS = new Set(["enabled", "roundRobin", "models"]);
const CAVEMAN_LEVELS = new Set(["lite", "full", "ultra", "wenyan-lite", "wenyan", "wenyan-ultra"]);
const PONYTAIL_LEVELS = new Set(["lite", "full", "ultra"]);
// Union of selectable levels in open-sse/providers/thinkingLevels.js
// (FORMAT_LEVELS sets + codex "codex" range) plus "auto" (delete marker).
const THINKING_MODES = new Set([
  "auto",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "thinking",
]);
const AUTO_PING_KEYS = new Set(["enabled", "connections"]);

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function intInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function validMapKey(key, maxLen = 256) {
  return (
    typeof key === "string" &&
    key.length > 0 &&
    key.length <= maxLen &&
    key === key.trim() &&
    !UNSAFE_KEYS.has(key)
  );
}

/** Empty clears the value; otherwise require an http(s) URL with no control chars. */
function validHttpUrl(value) {
  if (typeof value !== "string" || value.length > MAX_URL_LEN) return false;
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (hasControlChars(value)) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Empty clears the value; otherwise require a proxy URL the consumer would apply. */
function validProxyUrl(value) {
  if (typeof value !== "string" || value.length > MAX_URL_LEN) return false;
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (PROXY_BAD_CHARS.test(value)) return false;
  try {
    return PROXY_SCHEMES.has(new URL(trimmed).protocol);
  } catch {
    return false;
  }
}

/** CSV host list: each non-empty entry must be a bare host (no scheme/whitespace). */
function validNoProxy(value) {
  if (typeof value !== "string" || value.length > MAX_TEXT_LEN) return false;
  if (!value.trim()) return true;
  if (hasControlChars(value) || /[`$]/.test(value)) return false;
  for (const entry of value.split(",")) {
    const host = entry.trim();
    if (!host) continue;
    if (host.length > 253 || /\s/.test(host) || host.includes("://")) return false;
  }
  return true;
}

function validProviderStrategies(value) {
  if (!isPlainObject(value)) return false;
  for (const [provider, strategy] of Object.entries(value)) {
    if (!validMapKey(provider, 128)) return false;
    if (!isPlainObject(strategy)) return false;
    for (const key of Object.keys(strategy)) {
      if (UNSAFE_KEYS.has(key)) return false;
    }
    if (
      Object.hasOwn(strategy, "fallbackStrategy") &&
      !ACCOUNT_STRATEGIES.has(strategy.fallbackStrategy)
    ) {
      return false;
    }
    if (
      Object.hasOwn(strategy, "stickyRoundRobinLimit") &&
      !intInRange(strategy.stickyRoundRobinLimit, 1, 100)
    ) {
      return false;
    }
    // Non-routing keys owned by other pages: NoAuthProxyCard writes
    // proxyPoolId (a pool id string) + rotateStrategy (none/round-robin/random).
    if (
      Object.hasOwn(strategy, "proxyPoolId") &&
      (typeof strategy.proxyPoolId !== "string" ||
        !strategy.proxyPoolId.trim() ||
        strategy.proxyPoolId.length > 256)
    ) {
      return false;
    }
    if (
      Object.hasOwn(strategy, "rotateStrategy") &&
      !ROTATE_STRATEGIES.has(strategy.rotateStrategy)
    ) {
      return false;
    }
  }
  return true;
}

function validCapacityAdapter(value) {
  if (!isPlainObject(value)) return false;
  for (const [cap, entry] of Object.entries(value)) {
    if (!CAPACITY_ADAPTER_CAPS.has(cap)) return false;
    // Legacy array form was persisted by older Combos clients; consumer still supports it.
    if (Array.isArray(entry)) {
      if (entry.length > 500) return false;
      for (const item of entry) {
        if (
          !(typeof item === "string" && item.trim() && item.length <= 256) &&
          !(
            isPlainObject(item) &&
            typeof item.model === "string" &&
            item.model.trim() &&
            item.model.length <= 256 &&
            Object.keys(item).every((key) => key === "model" || key === "enabled") &&
            (!Object.hasOwn(item, "enabled") || typeof item.enabled === "boolean")
          )
        )
          return false;
      }
      continue;
    }
    if (!isPlainObject(entry)) return false;
    for (const key of Object.keys(entry)) {
      if (!CAPACITY_ENTRY_KEYS.has(key)) return false;
    }
    if (
      (Object.hasOwn(entry, "enabled") && typeof entry.enabled !== "boolean") ||
      (Object.hasOwn(entry, "roundRobin") && typeof entry.roundRobin !== "boolean")
    ) {
      return false;
    }
    if (Object.hasOwn(entry, "models")) {
      if (!Array.isArray(entry.models) || entry.models.length > 500) return false;
      for (const model of entry.models) {
        if (typeof model !== "string" || !model.trim() || model.length > 256) return false;
      }
    }
  }
  return true;
}

function validProviderThinking(value) {
  if (!isPlainObject(value)) return false;
  if (Object.keys(value).length > 500) return false;
  for (const [provider, cfg] of Object.entries(value)) {
    if (!validMapKey(provider, 128)) return false;
    if (!isPlainObject(cfg)) return false;
    if (Object.keys(cfg).some((key) => key !== "mode" || UNSAFE_KEYS.has(key))) return false;
    if (!Object.hasOwn(cfg, "mode") || !THINKING_MODES.has(cfg.mode)) return false;
  }
  return true;
}

/** Per-connection maps only: { enabled?: boolean, connections: { [id]: boolean } }. */
function validAutoPing(value) {
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (!AUTO_PING_KEYS.has(key)) return false;
  }
  if (Object.hasOwn(value, "enabled") && typeof value.enabled !== "boolean") return false;
  // Historic provider page writes preserve only its own toggles; empty config
  // remains valid and means no selected connections.
  if (value.connections === undefined) return true;
  if (!isPlainObject(value.connections)) return false;
  const ids = Object.entries(value.connections);
  if (ids.length > 10000) return false;
  for (const [id, on] of ids) {
    if (!validMapKey(id) || typeof on !== "boolean") return false;
  }
  return true;
}

/** Page shape: { [provider]: { hidden: string[], ...preserved } }. */
function validQuotaVisibility(value) {
  if (!isPlainObject(value)) return false;
  if (Object.keys(value).length > 500) return false;
  for (const [provider, entry] of Object.entries(value)) {
    if (!validMapKey(provider, 128)) return false;
    if (!isPlainObject(entry)) return false;
    for (const key of Object.keys(entry)) {
      if (UNSAFE_KEYS.has(key)) return false;
    }
    if (!Object.hasOwn(entry, "hidden") || !Array.isArray(entry.hidden)) return false;
    if (entry.hidden.length > 1000) return false;
    for (const key of entry.hidden) {
      if (typeof key !== "string" || !key.trim() || key.length > 256) return false;
    }
  }
  return true;
}

/**
 * Validate YAN-310 section keys in a settings PATCH body.
 * @param {object} body JSON-parsed PATCH body.
 * @returns {string | null} Error message, or null when valid.
 */
export function validateSectionSettings(body) {
  if (!isPlainObject(body)) return null;

  for (const key of Object.keys(body)) {
    if (UNSAFE_KEYS.has(key)) return `Invalid setting "${key}"`;
    if (READ_ONLY_KEYS.has(key)) return `Invalid ${key}: read-only`;
  }

  // Routing
  if (Object.hasOwn(body, "fallbackStrategy") && !ACCOUNT_STRATEGIES.has(body.fallbackStrategy)) {
    return "Invalid fallbackStrategy";
  }
  if (
    Object.hasOwn(body, "stickyRoundRobinLimit") &&
    !intInRange(body.stickyRoundRobinLimit, 1, 100)
  ) {
    return "Invalid stickyRoundRobinLimit: must be an integer between 1 and 100";
  }
  if (
    Object.hasOwn(body, "comboStickyRoundRobinLimit") &&
    !intInRange(body.comboStickyRoundRobinLimit, 1, 100)
  ) {
    return "Invalid comboStickyRoundRobinLimit: must be an integer between 1 and 100";
  }
  if (
    Object.hasOwn(body, "providerStrategies") &&
    !validProviderStrategies(body.providerStrategies)
  ) {
    return "Invalid providerStrategies";
  }
  if (Object.hasOwn(body, "capacityAdapter") && !validCapacityAdapter(body.capacityAdapter)) {
    return "Invalid capacityAdapter";
  }

  // Network
  for (const key of ["outboundProxyEnabled", "tunnelEnabled", "tailscaleEnabled"]) {
    if (Object.hasOwn(body, key) && typeof body[key] !== "boolean") {
      return `Invalid ${key}: must be a boolean`;
    }
  }
  if (Object.hasOwn(body, "outboundProxyUrl") && !validProxyUrl(body.outboundProxyUrl)) {
    return "Invalid outboundProxyUrl: must be an http/https/socks proxy URL";
  }
  if (Object.hasOwn(body, "outboundNoProxy") && !validNoProxy(body.outboundNoProxy)) {
    return "Invalid outboundNoProxy: must be a comma-separated host list";
  }

  // Token saver (headroomCodeAware/headroomKompress are Token-saver-page-owned
  // booleans validated by the same message below).
  for (const key of [
    "rtkEnabled",
    "headroomEnabled",
    "headroomCompressUserMessages",
    "headroomCodeAware",
    "headroomKompress",
    "cavemanEnabled",
    "ponytailEnabled",
    "pxpipeEnabled",
    "pxpipeAutoInstall",
  ]) {
    if (Object.hasOwn(body, key) && typeof body[key] !== "boolean") {
      return `Invalid ${key}: must be a boolean`;
    }
  }
  if (Object.hasOwn(body, "headroomUrl") && !validHttpUrl(body.headroomUrl)) {
    return "Invalid headroomUrl: must be an http(s) URL";
  }
  if (Object.hasOwn(body, "headroomTimeoutMs") && !intInRange(body.headroomTimeoutMs, 1, 300000)) {
    return "Invalid headroomTimeoutMs: must be an integer between 1 and 300000";
  }
  if (Object.hasOwn(body, "cavemanLevel") && !CAVEMAN_LEVELS.has(body.cavemanLevel)) {
    return "Invalid cavemanLevel";
  }
  if (Object.hasOwn(body, "ponytailLevel") && !PONYTAIL_LEVELS.has(body.ponytailLevel)) {
    return "Invalid ponytailLevel";
  }
  if (Object.hasOwn(body, "pxpipeMinChars") && !intInRange(body.pxpipeMinChars, 0, 10000000)) {
    return "Invalid pxpipeMinChars: must be an integer between 0 and 10000000";
  }
  if (Object.hasOwn(body, "pxpipeTimeoutMs") && !intInRange(body.pxpipeTimeoutMs, 1, 600000)) {
    return "Invalid pxpipeTimeoutMs: must be an integer between 1 and 600000";
  }

  // Providers & models
  if (Object.hasOwn(body, "providerThinking") && !validProviderThinking(body.providerThinking)) {
    return "Invalid providerThinking";
  }
  for (const key of ["claudeAutoPing", "codexAutoPing"]) {
    if (Object.hasOwn(body, key) && !validAutoPing(body[key])) {
      return `Invalid ${key}: must be a per-connection map`;
    }
  }
  if (Object.hasOwn(body, "ccFilterNaming") && typeof body.ccFilterNaming !== "boolean") {
    return "Invalid ccFilterNaming: must be a boolean";
  }
  if (Object.hasOwn(body, "quotaVisibility") && !validQuotaVisibility(body.quotaVisibility)) {
    return "Invalid quotaVisibility";
  }
  if (Object.hasOwn(body, "mitmRouterBaseUrl") && !validHttpUrl(body.mitmRouterBaseUrl)) {
    return "Invalid mitmRouterBaseUrl: must be an http(s) URL";
  }

  // Observability & logs (observabilityMaxJsonSize is kilobytes in code)
  if (Object.hasOwn(body, "enableObservability") && typeof body.enableObservability !== "boolean") {
    return "Invalid enableObservability: must be a boolean";
  }
  if (
    Object.hasOwn(body, "observabilityMaxRecords") &&
    !intInRange(body.observabilityMaxRecords, 1, 10000000)
  ) {
    return "Invalid observabilityMaxRecords: must be an integer between 1 and 10000000";
  }
  if (
    Object.hasOwn(body, "observabilityBatchSize") &&
    !intInRange(body.observabilityBatchSize, 1, 10000)
  ) {
    return "Invalid observabilityBatchSize: must be an integer between 1 and 10000";
  }
  if (
    Object.hasOwn(body, "observabilityFlushIntervalMs") &&
    !intInRange(body.observabilityFlushIntervalMs, 1, 3600000)
  ) {
    return "Invalid observabilityFlushIntervalMs: must be an integer between 1 and 3600000";
  }
  if (
    Object.hasOwn(body, "observabilityMaxJsonSize") &&
    !intInRange(body.observabilityMaxJsonSize, 1, 1048576)
  ) {
    return "Invalid observabilityMaxJsonSize: must be an integer number of kilobytes";
  }

  return null;
}
