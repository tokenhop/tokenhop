// Pure resolvers for YAN-312 settings: env-precedence runtime flags, the
// startPage/density preferences, and the allowlisted environment readout.
// No imports: safe for server routes, middleware-adjacent code, and tests.

// Localhost/base dashboards + every NAV_GROUPS href: the only legal startPage values.
export const START_PAGE_ALLOWLIST_VALUES = [
  "/dashboard",
  "/dashboard/providers",
  "/dashboard/combos",
  "/dashboard/endpoint",
  "/dashboard/usage",
  "/dashboard/quota",
  "/dashboard/console-log",
  "/dashboard/token-saver",
  "/dashboard/cli-tools",
  "/dashboard/media-providers",
  "/dashboard/proxy-pools",
  "/dashboard/skills",
  "/dashboard/settings",
  "/dashboard/translator",
];

// Localhost/base dashboards + every NAV_GROUPS href: the only legal startPage values.
export const START_PAGE_ALLOWLIST = new Set(START_PAGE_ALLOWLIST_VALUES);

export const DEFAULT_START_PAGE = "/dashboard";
export const DENSITIES = new Set(["comfortable", "compact"]);
export const DEFAULT_DENSITY = "comfortable";

// Non-secret env values the Environment section may show. Secrets
// (JWT_SECRET, INITIAL_PASSWORD, API_KEY_SECRET, MACHINE_ID_SALT, OAuth
// client secrets, tokens/keys) must never be added here.
export const ENV_ALLOWLIST = [
  "PORT",
  "DATA_DIR",
  "BASE_URL",
  "CLOUD_URL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SEARXNG_URL",
  "STREAM_FIRST_CHUNK_TIMEOUT_MS",
  "STREAM_STALL_TIMEOUT_MS",
  "FETCH_CONNECT_TIMEOUT_MS",
];

const ENV_DENYLIST = ["JWT_SECRET", "INITIAL_PASSWORD", "API_KEY_SECRET", "MACHINE_ID_SALT"];

/**
 * Resolve a runtime flag: env var set (any value) wins; else the stored
 * setting; else the default.
 * @param {string} envVar ENABLE_REQUEST_LOGS | ENABLE_TRANSLATOR
 * @param {boolean|undefined} stored Stored settings value.
 * @param {boolean} [defaultValue=false]
 * @returns {{ value: boolean, overridden: boolean }}
 */
export function resolveFlagSetting(envVar, stored, defaultValue = false) {
  const raw = process.env[envVar];
  if (raw !== undefined) {
    return { value: String(raw).toLowerCase() === "true", overridden: true };
  }
  if (typeof stored === "boolean") return { value: stored, overridden: false };
  return { value: defaultValue, overridden: false };
}

/**
 * Validate a startPage: must be a known in-dashboard route, else /dashboard.
 * @param {*} value
 * @returns {string}
 */
export function resolveStartPage(value) {
  if (typeof value === "string" && START_PAGE_ALLOWLIST.has(value)) return value;
  return DEFAULT_START_PAGE;
}

/**
 * Validate a density preference.
 * @param {*} value
 * @returns {"comfortable"|"compact"}
 */
export function resolveDensity(value) {
  return DENSITIES.has(value) ? value : DEFAULT_DENSITY;
}

/**
 * Replace embedded credentials in a URL with ***. Covers URL userinfo
 * (scheme + schemeless) and secret-looking query params (token, password,
 * api key, secret).
 * @param {*} value
 * @returns {*} Original value when no credentials are present.
 */
export function maskUrlCredentials(value) {
  if (typeof value !== "string") return value;
  let masked = value;
  if (masked.includes("@")) {
    try {
      const url = new URL(masked);
      if (url.username || url.password) {
        url.username = "***";
        url.password = "";
        // URL keeps the trailing "@" only when a username exists.
        const maskedUrl = url.toString();
        // URL.toString() appends "/" to bare origins; keep the input shape.
        masked =
          !value.endsWith("/") && maskedUrl.endsWith("/") && !url.pathname.slice(1)
            ? maskedUrl.slice(0, -1)
            : maskedUrl;
      }
    } catch {
      // Not a parseable URL: still hide userinfo-looking prefixes.
      masked = masked.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1***@");
    }
    // Schemeless userinfo (user:pass@host:port): no scheme for URL to parse.
    masked = masked.replace(/^([^/@:/?#]+:[^/@]*@)/, "***@");
  }
  // Secret-looking query params: ?client_secret=, &access_token=, api_key,
  // api-key, secret, password, token (YAN-313: config export must not leak
  // secrets embedded in OIDC SSO URLs and similar).
  const maskedQuery = masked.replace(
    /([?&])((?:client[_-]?)?secret|(?:access[_-]?|refresh[_-]?)?token|password|api[_-]?key|private[_-]?key)=[^&#]*/gi,
    "$1$2=***",
  );
  return maskedQuery;
}

/**
 * Build the allowlisted, credential-masked environment readout. The denylist
 * always wins, even if a key lands on a custom allowlist by mistake.
 * @param {string[]} [allowlist=ENV_ALLOWLIST]
 * @returns {Record<string, string>}
 */
export function buildEnvironmentReadout(allowlist = ENV_ALLOWLIST) {
  const readout = {};
  for (const key of allowlist || []) {
    if (ENV_DENYLIST.includes(key)) continue;
    const raw = process.env[key];
    if (raw === undefined || raw === "") continue;
    readout[key] = maskUrlCredentials(raw);
  }
  return readout;
}
