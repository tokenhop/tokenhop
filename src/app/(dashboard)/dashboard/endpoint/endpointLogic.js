/**
 * Endpoint & keys pure business logic:
 * - Security state derivation across all combinations of key, login, tunnel, dashboard access
 * - Quick connect snippet generation
 * - Key masking, relative time formatting, and newness tagging
 */

/**
 * Derives the security card's status and message.
 * Priority:
 * 1. Warn if an external tunnel/tailscale is active and requireApiKey is false.
 * 2. Warn if dashboard-over-tunnel is active and requireLogin is false.
 * 3. Warn if dashboard-over-tunnel is active and default password is used.
 * 4. Otherwise: ok ("Locked down").
 *
 * @param {object} params
 * @param {boolean} [params.requireApiKey]
 * @param {boolean} [params.requireLogin]
 * @param {boolean} [params.hasPassword]
 * @param {boolean} [params.tunnelEnabled]
 * @param {boolean} [params.tsEnabled]
 * @param {boolean} [params.tunnelDashboardAccess]
 * @param {boolean} [params.remoteHost] Dashboard served from non-localhost (UI hint only).
 * @returns {{ variant: "ok"|"warn", message: string, fix?: { label: string, href: string } }}
 */
export function deriveSecurityState({
  requireApiKey = false,
  requireLogin = true,
  hasPassword = true,
  tunnelEnabled = false,
  tsEnabled = false,
  tunnelDashboardAccess = false,
  remoteHost = false,
} = {}) {
  const isExposed = Boolean(tunnelEnabled || tsEnabled || remoteHost);
  const loginRequired = requireLogin !== false;
  const passwordSet = Boolean(hasPassword);

  if (isExposed && !requireApiKey) {
    return {
      variant: "warn",
      message:
        "Require API key is off while public tunnel or remote access is active. Your endpoint accepts unauthenticated requests.",
      fix: { label: "Enable", href: "#require-api-key" },
    };
  }

  if (isExposed && tunnelDashboardAccess && !loginRequired) {
    return {
      variant: "warn",
      message:
        "Require login is off while dashboard is exposed over the tunnel. Anyone with your tunnel URL can open your dashboard.",
      fix: { label: "Security settings", href: "/dashboard/profile" },
    };
  }

  if (!passwordSet) {
    return {
      variant: "warn",
      message: "Dashboard is using the default password. Change it in Security settings.",
      fix: { label: "Change password", href: "/dashboard/profile" },
    };
  }

  if (!loginRequired && !isExposed) {
    return {
      variant: "ok",
      message: "Local only: login disabled, but remote exposure is off.",
    };
  }

  if (isExposed && !tunnelDashboardAccess) {
    return {
      variant: "ok",
      message: "Locked down: key required, dashboard access over tunnel disabled.",
    };
  }

  return {
    variant: "ok",
    message: "Locked down: key required, login on.",
  };
}

/**
 * Check whether login state is unsafe for remote exposure.
 */
export function isLoginUnsafe({ requireLogin = true, hasPassword = true } = {}) {
  return requireLogin === false || !hasPassword;
}

/**
 * Security gate: can the tunnel or Tailscale be enabled safely?
 */
export function canExposeRemote({
  requireLogin = true,
  hasPassword = true,
  requireApiKey = false,
} = {}) {
  return !isLoginUnsafe({ requireLogin, hasPassword }) && Boolean(requireApiKey);
}

/**
 * Quote a value safely for POSIX shell (single-quoted, escapes interior single quotes).
 */
function shellEscape(val) {
  if (val == null) return "''";
  const s = String(val);
  if (/^[A-Za-z0-9_./:=+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Escape a value safely for double-quoted JSON/Python strings.
 */
function pyEscape(val) {
  if (val == null) return "";
  return String(val).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Display vs clipboard snippets for one key. The screen string always embeds
 * the mask; the copy string embeds the real key and is never rendered.
 *
 * @param {"shell"|"curl"|"python"} kind
 * @param {string} baseUrl
 * @param {{ key?: string }|null} selected
 * @returns {{ display: string, copy: string|null }}
 */
export function quickConnectSnippets(kind, baseUrl, selected) {
  const real = selected?.key;
  if (!real) return { display: buildQuickConnectSnippet(kind, baseUrl, ""), copy: null };
  return {
    display: buildQuickConnectSnippet(kind, baseUrl, maskKey(real)),
    copy: buildQuickConnectSnippet(kind, baseUrl, real),
  };
}

/**
 * Disambiguate duplicate key names with the last 4 characters. Unique names stay as-is.
 * @param {{ name: string, key?: string }} key
 * @param {Array<{ name: string }>} keys
 * @returns {string}
 */
export function duplicateKeyLabel(key, keys) {
  const name = key?.name || "";
  const duplicated = (keys || []).filter((item) => item.name === name).length > 1;
  if (!duplicated) return name;
  return `${name} \u2026${String(key.key || "").slice(-4)}`;
}

const KEY_NAME_MAX = 64;

/**
 * Key-name check shared by the API and the rename field. Error literal, or null.
 * @param {unknown} name
 * @returns {string|null}
 */
export function validateKeyName(name) {
  if (typeof name !== "string") return "Name is required";
  const trimmed = name.trim();
  if (!trimmed) return "Name is required";
  if (trimmed.length > KEY_NAME_MAX) return "Name must be 64 characters or fewer";
  // C0, DEL and C1 control characters (code-point check keeps the regex linter quiet).
  const hasControl = [...trimmed].some((ch) => {
    const code = ch.codePointAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
  if (hasControl) return "Name can't include control characters";
  return null;
}

/**
 * Build Quick Connect code snippet.
 *
 * @param {"shell"|"curl"|"python"} kind
 * @param {string} baseUrl e.g. "http://localhost:20128/v1"
 * @param {string} apiKey
 * @returns {string}
 */
export function buildQuickConnectSnippet(kind, baseUrl, apiKey) {
  const url = baseUrl || "http://localhost:20128/v1";
  const key = apiKey || "sk-9r-••••••••";

  switch (kind) {
    case "shell": {
      return `export OPENAI_BASE_URL=${shellEscape(url)}\nexport OPENAI_API_KEY=${shellEscape(key)}`;
    }
    case "curl": {
      return `curl ${url}/chat/completions \\
  -H "Content-Type: application/json" \\
  -H 'Authorization: Bearer ${shellEscape(key)}' \\
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`;
    }
    case "python": {
      return `from openai import OpenAI

client = OpenAI(
    base_url="${pyEscape(url)}",
    api_key="${pyEscape(key)}",
)

response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)`;
    }
    default:
      throw new Error(`buildQuickConnectSnippet: unknown snippet kind "${kind}"`);
  }
}

/**
 * Mask an API key showing prefix and last 4 characters.
 * E.g. sk-7d189a0934a299d0-59pm05-08db2e01 -> sk-7d18••••2e01
 */
export function maskKey(fullKey) {
  if (!fullKey || typeof fullKey !== "string") return "";
  if (fullKey.length <= 10) return fullKey;
  const prefix = fullKey.startsWith("sk-9r-") ? "sk-9r-" : fullKey.slice(0, 6);
  const suffix = fullKey.slice(-4);
  return `${prefix}••••${suffix}`;
}

/**
 * Formats a relative timestamp (or 'Never' for null/empty).
 */
export function formatLastUsed(isoDate) {
  if (!isoDate) return "Never";
  const time = new Date(isoDate).getTime();
  if (Number.isNaN(time)) return "Never";
  const diffSec = Math.floor((Date.now() - time) / 1000);
  if (diffSec < 0 || diffSec < 60) return "Just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays} days ago`;
  return new Date(isoDate).toLocaleDateString();
}

/**
 * Returns true if a key was created within the last 48 hours.
 */
export function isNewKey(isoDate) {
  if (!isoDate) return false;
  const time = new Date(isoDate).getTime();
  if (Number.isNaN(time)) return false;
  const diff = Date.now() - time;
  return diff >= 0 && diff < 48 * 3600 * 1000;
}

/**
 * Formats a number with commas.
 */
export function formatNumber(n) {
  const num = Number(n);
  if (Number.isNaN(num) || n == null) return "0";
  return num.toLocaleString();
}
