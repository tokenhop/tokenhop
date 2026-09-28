/**
 * Settings section registry: the single source of truth for the
 * `/dashboard/settings` page shell. Each section declares its id, title,
 * subtitle, icon and rows (key, label, description, keywords, tags). The
 * registry drives rendering, the anchor nav, search, and the command-palette
 * registration (YAN-294 — no palette exists yet, so `toCommandItems` exports
 * the items ready to plug in).
 *
 * Rows are metadata only; interactive controls live in the section components.
 */

/**
 * @typedef {object} SettingsRow
 * @property {string} key Stored settings key (or pseudo-key for actions).
 * @property {string} label Row label shown in the UI.
 * @property {string} [description] Short explainer.
 * @property {string} [keywords] Extra search terms (space-separated).
 * @property {Array<"new"|"env"|"experimental">} [tags] Board tags.
 */

/**
 * @typedef {object} SettingsSection
 * @property {string} id Anchor id.
 * @property {string} title Section title.
 * @property {string} subtitle Section subtitle.
 * @property {string} icon Material Symbols Outlined icon name.
 * @property {string} [statusPill] Optional status pill label.
 * @property {SettingsRow[]} rows Searchable rows in this section.
 */

/** @type {SettingsSection[]} */
export const SETTINGS_SECTIONS = [
  {
    id: "general",
    title: "General",
    subtitle: "Look, language and where you land.",
    icon: "tune",
    rows: [
      {
        key: "theme",
        label: "Theme",
        description: "Dark, light, or follow your system.",
        keywords: "dark light system appearance color mode",
      },
      {
        key: "language",
        label: "Language",
        description: "Dashboard language.",
        keywords: "locale i18n display language",
      },
      {
        key: "startPage",
        label: "Start page",
        description: "Where you land after login and on `/`.",
        keywords: "start page home landing default route",
      },
      {
        key: "uiDensity",
        label: "Density",
        description: "Compact tightens spacing and row heights.",
        keywords: "density compact comfortable spacing rows",
      },
    ],
  },
  {
    id: "security",
    title: "Security & access",
    subtitle: "Who can reach the dashboard and the API.",
    icon: "shield",
    statusPill: "Protected",
    rows: [
      {
        key: "requireLogin",
        label: "Require login",
        description: "Ask for the dashboard password first.",
        keywords: "login auth password required",
      },
      {
        key: "password",
        label: "Password",
        description: "Change the dashboard password. Replace the default before exposing anything.",
        keywords: "change set update password",
      },
      {
        key: "requireApiKey",
        label: "Require API key",
        description: "Requests without a valid key get a 401. Needed for the tunnel.",
        keywords: "api key auth 401 endpoint",
      },
      {
        key: "tunnelDashboardAccess",
        label: "Dashboard over tunnel",
        description: "Serve this dashboard on the public tunnel URL too.",
        keywords: "tunnel tailscale remote access dashboard",
      },
      {
        key: "AUTH_COOKIE_SECURE",
        label: "Secure session cookie",
        description: "HTTPS-only cookie for the login session. Read-only.",
        keywords: "cookie secure https session auth env",
        tags: ["env"],
      },
    ],
  },
  {
    id: "sso",
    title: "Single sign-on",
    subtitle: "Sign in with your identity provider.",
    icon: "lock_open",
    rows: [
      {
        key: "authMode",
        label: "Sign-in method",
        keywords: "auth mode sso password both oidc saml",
      },
      { key: "ssoType", label: "Protocol", keywords: "protocol oidc saml" },
      { key: "oidcIssuerUrl", label: "Issuer URL", keywords: "oidc issuer url openid" },
      { key: "oidcClientId", label: "Client ID", keywords: "oidc client id" },
      { key: "oidcClientSecret", label: "Client secret", keywords: "oidc secret write-only" },
      { key: "oidcScopes", label: "Scopes", keywords: "oidc scopes openid profile email" },
      { key: "oidcLoginLabel", label: "Button label", keywords: "oidc button label" },
      {
        key: "samlEntryPoint",
        label: "Single Sign-On Service URL",
        keywords: "saml sso url entry point idp",
      },
      {
        key: "samlIssuer",
        label: "SP Entity ID / Audience",
        keywords: "saml issuer entity audience sp",
      },
      {
        key: "samlCert",
        label: "IdP X.509 Certificate",
        keywords: "saml cert certificate x509 pem",
      },
      { key: "samlLoginLabel", label: "Login button label", keywords: "saml login button label" },
      {
        key: "samlAttributeEmail",
        label: "Email claim attribute",
        keywords: "saml attribute email claim nameid",
      },
      {
        key: "samlAttributeName",
        label: "Display name claim",
        keywords: "saml attribute name display claim",
      },
      {
        key: "ssoRedirect",
        label: "Redirect URI / ACS URL",
        keywords: "redirect acs metadata callback url copy",
      },
      {
        key: "ssoTest",
        label: "Test sign-in",
        keywords: "test sign-in verify connection guides okta entra keycloak aws",
      },
    ],
  },
  {
    id: "routing",
    title: "Routing",
    subtitle: "How accounts and combos take turns.",
    icon: "route",
    rows: [
      {
        key: "fallbackStrategy",
        label: "Account strategy",
        description: "Picks between accounts of the same provider.",
        keywords: "account strategy fallback round robin weighted fill first accounts",
      },
      {
        key: "stickyRoundRobinLimit",
        label: "Sticky limit",
        description: "Calls per account before rotating. Round robin and weighted only.",
        keywords: "sticky limit rotate accounts round robin weighted",
      },
      {
        key: "comboStrategy",
        label: "Combo round robin",
        description: "Rotate inside combos by default instead of falling back in order.",
        keywords: "combo round robin fallback rotate combos",
      },
      {
        key: "comboStickyRoundRobinLimit",
        label: "Combo sticky limit",
        description: "Calls per combo model before rotating.",
        keywords: "combo sticky limit rotate models",
      },
      {
        key: "providerStrategies",
        label: "Per-provider overrides",
        description: "Beat the global strategy for one provider.",
        keywords: "provider override per-provider strategy sticky",
      },
      {
        key: "capacityAdapter",
        label: "Capability adapter",
        description: "Images or audio go to a capable model when the chosen one can't read them.",
        keywords: "capability adapter vision audio images capacity combos",
      },
    ],
  },
  {
    id: "reliability",
    title: "Reliability",
    subtitle: "Retries, cooldowns and timeouts.",
    icon: "restart_alt",
    rows: [
      {
        key: "retryPolicy",
        label: "Retries on upstream errors",
        description: "Tries and delay per status. 429s never retry.",
        keywords: "retry retries 502 503 504 tries delay backoff upstream errors",
        tags: ["new"],
      },
      {
        key: "cooldowns",
        label: "Cooldowns",
        description: "How long an account sits out after it fails.",
        keywords: "cooldown rate limit transient long short account lockout",
        tags: ["new"],
      },
      {
        key: "backoff",
        label: "Backoff",
        description: "Grows with each repeated failure.",
        keywords: "backoff exponential start max levels rate limit",
        tags: ["new"],
      },
      {
        key: "streamTimeouts",
        label: "Stream timeouts",
        description: "When to give up on a slow or stalled upstream.",
        keywords: "timeout stream stall first chunk connect .env overrides",
        tags: ["new"],
      },
    ],
  },
  {
    id: "network",
    title: "Network",
    subtitle: "How 9router reaches providers, and how you reach it.",
    icon: "public",
    rows: [
      {
        key: "outboundProxyEnabled",
        label: "Outbound proxy",
        description: "Send OAuth and provider calls through a proxy. Applies without restart.",
        keywords: "outbound proxy oauth provider proxy test apply",
      },
      {
        key: "outboundProxyUrl",
        label: "Proxy URL",
        description: "Proxy server URL.",
        keywords: "proxy url http socks server address",
      },
      {
        key: "outboundNoProxy",
        label: "Skip for",
        description: "Comma-separated hosts that bypass the proxy.",
        keywords: "no proxy skip bypass hosts localhost",
      },
      {
        key: "tunnelEnabled",
        label: "Cloudflare tunnel",
        description: "Public HTTPS URL. Needs Require API key.",
        keywords: "cloudflare tunnel public https remote",
      },
      {
        key: "tailscaleEnabled",
        label: "Tailscale",
        description: "Private mesh access.",
        keywords: "tailscale mesh vpn private funnel",
      },
      {
        key: "tunnelProvider",
        label: "Tunnel provider",
        description: "Active tunnel backend. Read-only.",
        keywords: "tunnel provider backend cloudflare read-only",
      },
      {
        key: "SEARXNG_URL",
        label: "Web search backend",
        description: "SearXNG instance used by web search. Read-only.",
        keywords: "searxng web search backend env",
      },
    ],
  },
  {
    id: "token-saver",
    title: "Token saver",
    subtitle: "Compress tool output, context and replies.",
    icon: "bolt",
    rows: [
      {
        key: "rtkEnabled",
        label: "Compress tool output",
        description: "git/grep/ls/tree/logs → fewer input tokens (RTK).",
        keywords: "rtk compress tool output tokens",
      },
      {
        key: "headroomEnabled",
        label: "Compress context",
        description: "Compress prompts via Headroom before routing to the model.",
        keywords: "headroom compress context prompts",
      },
      {
        key: "headroomUrl",
        label: "Headroom URL",
        description: "Local proxy or external sidecar.",
        keywords: "headroom url proxy sidecar",
      },
      {
        key: "headroomTimeoutMs",
        label: "Headroom timeout",
        description: "Request timeout, in milliseconds.",
        keywords: "headroom timeout ms",
      },
      {
        key: "headroomCompressUserMessages",
        label: "Compress user messages",
        description: "Also compress user turns, not just tool output.",
        keywords: "headroom compress user messages",
      },
      {
        key: "cavemanEnabled",
        label: "Compress LLM output",
        description: "Terse-style system prompt → fewer output tokens (Caveman).",
        keywords: "caveman compress llm output terse",
      },
      {
        key: "cavemanLevel",
        label: "Caveman level",
        description: "Lite, full or ultra.",
        keywords: "caveman level lite full ultra",
      },
      {
        key: "ponytailEnabled",
        label: "Lazy senior dev",
        description: "Bias the model toward minimal code (Ponytail).",
        keywords: "ponytail lazy senior dev minimal",
      },
      {
        key: "ponytailLevel",
        label: "Ponytail level",
        description: "Lite, full or ultra.",
        keywords: "ponytail level lite full ultra",
      },
      {
        key: "pxpipeEnabled",
        label: "Prompts as images",
        description: "Large context becomes optimized images before the LLM (PXPIPE).",
        keywords: "pxpipe prompts images experimental",
        tags: ["experimental"],
      },
      {
        key: "pxpipeMinChars",
        label: "Minimum prompt size",
        description: "Requests smaller than this bypass PXPIPE as-is (chars).",
        keywords: "pxpipe min chars size threshold",
        tags: ["experimental"],
      },
      {
        key: "pxpipeTimeoutMs",
        label: "PXPIPE timeout",
        description: "Request timeout, in milliseconds.",
        keywords: "pxpipe timeout ms",
        tags: ["experimental"],
      },
      {
        key: "pxpipeAutoInstall",
        label: "Auto-install PXPIPE",
        description: "Install the proxy package on first use when missing.",
        keywords: "pxpipe auto install",
        tags: ["experimental"],
      },
    ],
  },
  {
    id: "providers",
    title: "Providers & models",
    subtitle: "Defaults that apply across providers.",
    icon: "dns",
    rows: [
      {
        key: "providerThinking",
        label: "Default thinking level",
        description: "Used when a request doesn't ask for one.",
        keywords: "provider thinking level default reasoning",
      },
      {
        key: "claudeAutoPing",
        label: "Auto-ping · Claude Code",
        description: "A tiny request keeps quota windows warm. Per connection only.",
        keywords: "auto ping claude quota warm connections",
      },
      {
        key: "codexAutoPing",
        label: "Auto-ping · Codex",
        description: "A tiny request keeps quota windows warm. Per connection only.",
        keywords: "auto ping codex quota warm connections",
      },
      {
        key: "ccFilterNaming",
        label: "Filter naming requests",
        description: "Drop Claude Code title-naming calls to save quota.",
        keywords: "cc filter naming title claude",
      },
      {
        key: "quotaVisibility",
        label: "Quota rows shown",
        description: "Pick which limits appear on the Quota page.",
        keywords: "quota visibility rows limits shown hide",
      },
      {
        key: "mitmRouterBaseUrl",
        label: "Intercept (MITM) router URL",
        description: "Base URL the MITM server routes through.",
        keywords: "mitm router url intercept base",
      },
    ],
  },
  {
    id: "logs",
    title: "Observability & logs",
    subtitle: "What gets recorded, and for how long.",
    icon: "monitoring",
    rows: [
      {
        key: "enableObservability",
        label: "Record request details",
        description: "Full payloads in Usage → Request log.",
        keywords: "observability record request details log",
      },
      {
        key: "observabilityMaxRecords",
        label: "Max records",
        description: "Stored request details cap.",
        keywords: "observability max records storage limits",
      },
      {
        key: "observabilityBatchSize",
        label: "Batch size",
        description: "Write batch size.",
        keywords: "observability batch size",
      },
      {
        key: "observabilityFlushIntervalMs",
        label: "Flush every",
        description: "Flush interval, in milliseconds.",
        keywords: "observability flush interval ms",
      },
      {
        key: "observabilityMaxJsonSize",
        label: "Max payload size",
        description: "Kilobytes per payload.",
        keywords: "observability max payload size json kb",
      },
      {
        key: "requestLogsEnabled",
        label: "Log every request to console",
        description: "Writes request/response logs under logs/ for debugging.",
        keywords: "log request console debug ENABLE_REQUEST_LOGS env",
        tags: ["env"],
      },
      {
        key: "translatorEnabled",
        label: "Show Translator page",
        description: "Debug tool for format translation.",
        keywords: "translator debug format page ENABLE_TRANSLATOR env",
        tags: ["env"],
      },
    ],
  },
  {
    id: "pricing",
    title: "Pricing",
    subtitle: "What cost estimates use, in $ per 1M tokens.",
    icon: "savings",
    rows: [
      {
        key: "pricingOverview",
        label: "Pricing overview",
        description: "Model count, provider count, custom overrides.",
        keywords: "pricing models providers custom cost overview",
      },
      {
        key: "pricingEdit",
        label: "Edit pricing",
        description: "Override per-model rates.",
        keywords: "edit pricing modal override rates",
      },
      {
        key: "pricingReset",
        label: "Reset to defaults",
        description: "Restore standard rates.",
        keywords: "reset defaults restore pricing",
      },
    ],
  },
  {
    id: "data",
    title: "Data & backup",
    subtitle: "Everything lives in one SQLite file.",
    icon: "database",
    rows: [
      {
        key: "databasePath",
        label: "Database",
        description: "SQLite file location.",
        keywords: "database sqlite location path size data dir",
      },
      {
        key: "backup",
        label: "Backup",
        description: "Download or import a password-gated backup.",
        keywords: "backup download import export restore password",
      },
      {
        key: "cloudEnabled",
        label: "Cloud sync",
        description: "Keep settings and connections in sync across machines.",
        keywords: "cloud sync backup remote machines",
        tags: ["new"],
      },
    ],
  },
  {
    id: "environment",
    title: "Environment",
    subtitle: "Read from .env at startup. Edit the file and restart.",
    icon: "terminal",
    rows: [
      {
        key: "PORT",
        label: "Port",
        description: "Read-only server port.",
        keywords: "port env environment server",
        tags: ["env"],
      },
      {
        key: "DATA_DIR",
        label: "Data directory",
        description: "Read-only data directory.",
        keywords: "data dir env environment path",
        tags: ["env"],
      },
      {
        key: "envValues",
        label: "Environment values",
        description: "Read-only allowlisted env values with credentials masked.",
        keywords: "env environment proxy base url cloud searxng timeout",
        tags: ["env"],
      },
    ],
  },
  {
    id: "danger",
    title: "Danger zone",
    subtitle: "End sessions and stop the server.",
    icon: "warning",
    rows: [
      {
        key: "logout",
        label: "Log out",
        description: "End this dashboard session.",
        keywords: "logout sign out session",
      },
      {
        key: "shutdown",
        label: "Shut down 9router",
        description: "Your tools lose their endpoint until you start it again.",
        keywords: "shutdown stop close server power",
      },
    ],
  },
];

export const SETTINGS_GROUPS = [
  {
    id: "account",
    title: "Account",
    icon: "manage_accounts",
    sections: ["general", "security", "sso"],
  },
  {
    id: "traffic",
    title: "Traffic",
    icon: "route",
    sections: ["routing", "reliability", "network", "token-saver"],
  },
  {
    id: "models",
    title: "Models & usage",
    icon: "dns",
    sections: ["providers", "logs", "pricing"],
  },
  { id: "system", title: "System", icon: "settings", sections: ["data", "environment", "danger"] },
];

/** Anchor nav entries in section order: [{ id, title }]. */
export const SETTINGS_ANCHORS = SETTINGS_SECTIONS.map(({ id, title }) => ({ id, title }));

/**
 * Section anchors in registry order.
 * @returns {Array<{ id: string, title: string }>}
 */
export function sectionAnchors() {
  return SETTINGS_ANCHORS.map((anchor) => ({ ...anchor }));
}

function rowMatches(row, query) {
  const haystack =
    `${row.key} ${row.label} ${row.description ?? ""} ${row.keywords ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/**
 * Filter registry rows by label, description, key and keywords.
 * Empty query returns every section untouched.
 * @param {string} query Search text.
 * @returns {SettingsSection[]} Sections with at least one matching row.
 */
export function filterRows(query) {
  if (!query?.trim()) return SETTINGS_SECTIONS;
  return SETTINGS_SECTIONS.map((section) => ({
    ...section,
    rows: section.rows.filter((row) => rowMatches(row, query)),
  })).filter((section) => section.rows.length > 0);
}

/**
 * Command-palette items for every registry row, ready to register with the
 * YAN-294 palette when it lands.
 * @returns {Array<{ id: string, label: string, hint: string, href: string }>}
 */
export function toCommandItems() {
  return SETTINGS_SECTIONS.flatMap((section) =>
    section.rows.map((row) => ({
      id: `settings:${row.key}`,
      group: "Settings",
      label: `${section.title} — ${row.label}`,
      hint: row.description || "",
      keywords: `${section.title} ${row.label} ${row.description || ""} ${row.keywords || ""}`,
      icon: section.icon || "settings",
      href: `/dashboard/settings#${section.id}`,
      run: { type: "navigate", href: `/dashboard/settings#${section.id}` },
    })),
  );
}
