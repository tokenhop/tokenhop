"use strict";

/**
 * Brand module: the brand switch, every product-name value, and the registry of
 * legacy 9router names (the only place legacy literals may live).
 *
 * Dependency-free CommonJS so the Next.js server and client bundles, open-sse/
 * and the CLI can all load it. `index.js` is the ESM entry; the CLI build copies
 * this file into the CLI package (cli/scripts/build-cli.js).
 *
 * `NEXT_PUBLIC_BRAND` overrides the default for dev, CI and tokenhop beta images
 * (the Dockerfile build arg). Next.js inlines it into bundles at build time, so
 * keep the literal `process.env.NEXT_PUBLIC_BRAND` expression (no destructuring)
 * or the inlining stops working. Server code and the CLI read it at runtime. The v1.0.0 release flips DEFAULT_BRAND_ID to "tokenhop".
 */

const BRAND_IDS = Object.freeze(["9router", "tokenhop"]);
const DEFAULT_BRAND_ID = "9router";

function assertBrandId(id, source) {
  if (BRAND_IDS.includes(id)) return id;
  const allowed = BRAND_IDS.map((b) => `"${b}"`).join(", ");
  throw new Error(`${source}: unknown brand ${JSON.stringify(id)}; allowed values: ${allowed}`);
}

function resolveActiveBrandId(value) {
  // Empty counts as unset, the way .env files and Compose pass "NAME=".
  if (value === undefined || value === "") return DEFAULT_BRAND_ID;
  return assertBrandId(value, "NEXT_PUBLIC_BRAND");
}

const ACTIVE_BRAND_ID = resolveActiveBrandId(process.env.NEXT_PUBLIC_BRAND);

function isActiveBrand(id) {
  return assertBrandId(id, "isActiveBrand") === ACTIVE_BRAND_ID;
}

/** tokenhop values (rebrand handbook §2). */
const BRAND = Object.freeze({
  name: "tokenhop",
  slug: "tokenhop",
  envPrefix: "TOKENHOP_",
  headerPrefix: "x-tokenhop-",
  jcodeApiKeyEnv: "JCODE_TOKENHOP_API_KEY",
  defaultApiKey: "sk_tokenhop",
  dataDirName: "tokenhop",
  samlIssuerDefault: "urn:tokenhop:sp",
  mitmCaCommonName: "tokenhop MITM Root CA",
  mitmCaOrg: "tokenhop",
  mitmCertFile: "tokenhop-root-ca.crt",
  pidFile: "tokenhop.pid",
  autostartLabel: "dev.tokenhop.autostart",
  autostartDesktopFile: "tokenhop.desktop",
  autostartVbsFile: "tokenhop.vbs",
  clientConfigKey: "tokenhop",
  customModelIdPrefix: "custom:tokenhop-",
  storageKeyPrefix: "tokenhop.",
  eventPrefix: "tokenhop:",
  backupFilePrefix: "tokenhop-backup-",
  npmPackage: "tokenhop",
  appPackage: "tokenhop-app",
  repoSlug: "tokenhop/tokenhop",
  repoUrl: "https://github.com/tokenhop/tokenhop",
  imageName: "ghcr.io/tokenhop/tokenhop",
  websiteUrl: "https://tokenhop.ai",
  docsUrl: "https://tokenhop.dev",
  // Brand assets (public/brand/ + cli/src/cli/tray/).
  wordmark: "tokenhop",
  favicon: "/brand/favicon.svg",
  faviconIco: "/brand/favicon.ico",
  appIcon192: "/brand/icons/icon-192.svg",
  appIcon512: "/brand/icons/icon-512.svg",
  trayIconName: "icon-tokenhop",
  // The mono tray glyph is a true macOS template icon (alpha only).
  trayIconTemplate: true,
});

/**
 * 9router values, keyed like BRAND. Keys with several spellings are plural
 * arrays, primary spelling first. legacy(9router): remove in v2
 */
const LEGACY = Object.freeze({
  names: Object.freeze(["9Router", "9router"]),
  slug: "9router",
  envPrefixes: Object.freeze(["NINEROUTER_", "NINE_ROUTER_"]),
  headerPrefix: "x-9router-",
  jcodeApiKeyEnv: "JCODE_9ROUTER_API_KEY",
  defaultApiKey: "sk_9router",
  dataDirName: "9router",
  samlIssuerDefault: "urn:9router:sp",
  mitmCaCommonName: "9Router MITM Root CA",
  mitmCaOrg: "9Router",
  mitmCertFile: "9router-root-ca.crt",
  pidFile: "9router.pid",
  autostartLabel: "com.9router.autostart",
  autostartDesktopFile: "9router.desktop",
  autostartVbsFile: "9router.vbs",
  clientConfigKeys: Object.freeze(["9router", "9Router"]),
  customModelIdPrefix: "custom:9Router-",
  storageKeyPrefix: "9router.",
  eventPrefix: "9router:",
  backupFilePrefix: "9router-backup-",
  npmPackage: "9router",
  appPackage: "9router-app",
  repoSlug: "yandy-r/9router",
  repoUrl: "https://github.com/yandy-r/9router",
  imageName: "ghcr.io/yandy-r/9router",
  // No websiteUrl/docsUrl: the 9router site is upstream's service, never ours.
  // Brand assets keep pointing at the legacy files, which still exist.
  wordmark: "router",
  favicon: "/favicon.svg",
  faviconIco: "/favicon.ico",
  appIcon192: "/icons/icon-192.svg",
  appIcon512: "/icons/icon-512.svg",
  trayIconName: "icon",
  // The full-color RGBA icon is not a macOS template icon; template mode
  // would render it as a solid white square (only alpha is used).
  trayIconTemplate: false,
});

/**
 * Identifiers sent to third-party APIs, the same for every brand. Renaming one
 * needs evidence the upstream ignores it plus a real provider smoke test, so
 * they keep their 9router values (YAN-330 audit).
 * legacy(9router): upstream-facing, keep
 */
const UPSTREAM_CLIENT_IDS = Object.freeze({
  kimiPlatform: "9router", // Kimi X-Msh-Platform
  clineUserAgentProduct: "9Router", // Cline User-Agent "<product>/<version>"
  clineClientType: "9router", // Cline X-CLIENT-TYPE
  devinMcpClientName: "9router", // devin acp initialize clientInfo.name
  coworkMcpClientName: "9router", // Cowork MCP probe initialize clientInfo.name
  cursorMcpProvider: "9router", // Cursor MCP server_name/identifier/provider_identifier
});

// The repo and image already moved, and the 9router site is upstream's, so
// these stay on the tokenhop values whichever brand is active.
const BRAND_INDEPENDENT_KEYS = new Set([
  "repoSlug",
  "repoUrl",
  "imageName",
  "websiteUrl",
  "docsUrl",
]);
const LEGACY_PLURAL_KEYS = {
  name: "names",
  envPrefix: "envPrefixes",
  clientConfigKey: "clientConfigKeys",
};

function legacyPrimary(key) {
  const value = LEGACY[LEGACY_PLURAL_KEYS[key] || key];
  return Array.isArray(value) ? value[0] : value;
}

/** The active brand's values; behind-the-switch call sites read this. */
const ACTIVE =
  ACTIVE_BRAND_ID === "tokenhop"
    ? BRAND
    : Object.freeze(
        Object.fromEntries(
          Object.keys(BRAND).map((key) => [
            key,
            BRAND_INDEPENDENT_KEYS.has(key) ? BRAND[key] : legacyPrimary(key),
          ]),
        ),
      );

const warned = new Set();

/**
 * Log one deprecation line per (kind, oldName) per process. Silent unless the
 * active brand is tokenhop. Returns true when it logged.
 */
function warnLegacyOnce(kind, oldName, newName) {
  if (ACTIVE_BRAND_ID !== "tokenhop") return false;
  const key = `${kind}\u0000${oldName}`;
  if (warned.has(key)) return false;
  warned.add(key);
  console.warn(
    `[tokenhop] deprecated ${kind} "${oldName}" → use "${newName}" (legacy support ends in v2.0.0)`,
  );
  return true;
}

const ENV_SUFFIX = /^[A-Z0-9]+(_[A-Z0-9]+)*$/;

function envName(suffix) {
  if (typeof suffix !== "string" || !ENV_SUFFIX.test(suffix)) {
    throw new Error(
      `envName: invalid suffix ${JSON.stringify(suffix)}; expected e.g. "PEER_TOKEN"`,
    );
  }
  return BRAND.envPrefix + suffix;
}

/**
 * `TOKENHOP_<suffix>` when defined (even if empty), otherwise the first defined
 * legacy spelling, warning once. `undefined` when none is defined.
 */
function readEnv(suffix, env = process.env) {
  const name = envName(suffix);
  if (env[name] !== undefined) return env[name];
  // legacy(9router): remove in v2
  for (const prefix of LEGACY.envPrefixes) {
    const legacyName = prefix + suffix;
    if (env[legacyName] !== undefined) {
      warnLegacyOnce("env var", legacyName, name);
      return env[legacyName];
    }
  }
  return undefined;
}

// Bare header name, e.g. "connection-id"; the brand prefix is added here.
const HEADER_NAME = /^(?!x-)[a-z0-9]+(-[a-z0-9]+)*$/;

function assertHeaderName(name, source) {
  if (typeof name !== "string" || !HEADER_NAME.test(name)) {
    throw new Error(
      `${source}: invalid header name ${JSON.stringify(name)}; expected a bare lowercase name like "connection-id"`,
    );
  }
  return name;
}

/** The active brand's header, e.g. header("connection-id") → "x-9router-connection-id". */
function header(name) {
  return ACTIVE.headerPrefix + assertHeaderName(name, "header");
}

/** Legacy spellings of a header other than header(name); empty under the default brand. */
function legacyHeaderNames(name) {
  const current = header(name);
  return [LEGACY.headerPrefix + name].filter((h) => h !== current);
}

module.exports = {
  BRAND_IDS,
  DEFAULT_BRAND_ID,
  ACTIVE_BRAND_ID,
  isActiveBrand,
  BRAND,
  LEGACY,
  ACTIVE,
  UPSTREAM_CLIENT_IDS,
  envName,
  readEnv,
  warnLegacyOnce,
  header,
  legacyHeaderNames,
};
