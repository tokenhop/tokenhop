import { resolveDensity, resolveStartPage } from "@/lib/settingsFlags";
import { validateComboStrategySettings } from "open-sse/services/comboStrategy.js";
import { isOidcConfigured } from "@/lib/auth/oidc";
import { isSamlConfigured } from "@/lib/auth/saml.js";
import { resolveAuthModes } from "@/lib/auth/authModes";
import {
  DEFAULT_SETTINGS,
  SSO_POLICY_KEYS,
  GRANT_POLICY_KEYS,
} from "@/lib/db/repos/settingsRepo.js";
import { getAdapter } from "@/lib/db/driver.js";
import { validateSectionSettings } from "./validateSectionSettings.js";

const ACCOUNT_STRATEGIES = new Set(["fill-first", "round-robin", "weighted"]);
const AUTH_MODES = new Set(["password", "sso", "both", "saml", "oidc"]);
const SSO_TYPES = new Set(["oidc", "saml"]);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_TEXT_LEN = 256;
const MAX_URL_LEN = 2048;
const MAX_PASSWORD_LEN = 256;
const MAX_CERT_LEN = 16384;

function validStickyLimit(value) {
  return Number.isInteger(value) && value >= 1 && value <= 100;
}

function validText(value, max = MAX_TEXT_LEN) {
  return typeof value === "string" && value.length <= max;
}

// Empty clears the value; otherwise require an http(s) URL.
function validUrl(value) {
  if (typeof value !== "string" || value.length > MAX_URL_LEN) return false;
  if (!value.trim()) return true;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Boundary validation for keys touched by the YAN-309 Settings page:
 * security toggles, auth mode/protocol, OIDC + SAML fields, passwords.
 * Returns an error message string, or "" when valid.
 */
function validSecuritySettings(body) {
  for (const key of [
    "requireLogin",
    "requireApiKey",
    "tunnelDashboardAccess",
    // YAN-369: instance ToS override for personal connection grants.
    "allowPersonalConnectionGrants",
  ]) {
    if (Object.hasOwn(body, key) && typeof body[key] !== "boolean") {
      return `Invalid ${key}: must be a boolean`;
    }
  }
  // YAN-312 runtime flags: stored preference only; the env var wins at read time.
  for (const key of ["requestLogsEnabled", "translatorEnabled"]) {
    if (Object.hasOwn(body, key) && typeof body[key] !== "boolean") {
      return `Invalid ${key}: must be a boolean`;
    }
  }
  if (Object.hasOwn(body, "startPage")) {
    if (typeof body.startPage !== "string" || resolveStartPage(body.startPage) !== body.startPage) {
      return "Invalid startPage: must be a dashboard route";
    }
  }
  if (
    Object.hasOwn(body, "uiDensity") &&
    (typeof body.uiDensity !== "string" || resolveDensity(body.uiDensity) !== body.uiDensity)
  ) {
    return "Invalid uiDensity: must be comfortable or compact";
  }
  // YAN-371: the workspace switcher's persisted last active workspace.
  if (
    Object.hasOwn(body, "lastWorkspaceId") &&
    (typeof body.lastWorkspaceId !== "string" ||
      body.lastWorkspaceId.length < 1 ||
      body.lastWorkspaceId.length > 128)
  ) {
    return "Invalid lastWorkspaceId: must be a string of 1-128 characters";
  }
  if (Object.hasOwn(body, "authMode") && !AUTH_MODES.has(body.authMode)) {
    return "Invalid authMode";
  }
  if (Object.hasOwn(body, "ssoType") && !SSO_TYPES.has(body.ssoType)) {
    return "Invalid ssoType";
  }
  for (const key of ["oidcClientId", "oidcScopes", "oidcLoginLabel"]) {
    if (Object.hasOwn(body, key) && !validText(body[key])) {
      return `Invalid ${key}`;
    }
  }
  if (Object.hasOwn(body, "oidcIssuerUrl") && !validUrl(body.oidcIssuerUrl)) {
    return "Invalid oidcIssuerUrl: must be an http(s) URL";
  }
  if (Object.hasOwn(body, "oidcClientSecret") && !validText(body.oidcClientSecret, MAX_URL_LEN)) {
    return "Invalid oidcClientSecret";
  }
  if (Object.hasOwn(body, "samlEntryPoint") && !validUrl(body.samlEntryPoint)) {
    return "Invalid samlEntryPoint: must be an http(s) URL";
  }
  for (const key of ["samlIssuer", "samlLoginLabel", "samlAttributeEmail", "samlAttributeName"]) {
    if (Object.hasOwn(body, key) && !validText(body[key])) {
      return `Invalid ${key}`;
    }
  }
  if (Object.hasOwn(body, "samlCert") && !validText(body.samlCert, MAX_CERT_LEN)) {
    return "Invalid samlCert";
  }
  for (const key of ["currentPassword", "newPassword"]) {
    if (
      Object.hasOwn(body, key) &&
      (typeof body[key] !== "string" || body[key].length > MAX_PASSWORD_LEN)
    ) {
      return `Invalid ${key}`;
    }
  }
  return "";
}

/** Keys whose PATCH could turn on SSO-only; triggers the lockout guard. */
const AUTH_PATCH_KEYS = [
  "authMode",
  "ssoType",
  "oidcIssuerUrl",
  "oidcClientId",
  "oidcClientSecret",
  "samlEntryPoint",
  "samlCert",
];

/**
 * Lockout guard, shared with config import: reject a settings patch that
 * leaves an SSO-only mode whose protocol is not fully configured, which would
 * close both sign-in paths at once. A blank `oidcClientSecret` keeps the
 * stored one (PATCH drops it before saving; import never carries secrets).
 * @param {object} current Stored settings.
 * @param {object} patch Incoming settings keys.
 * @returns {string} Error message, or "" when the result stays reachable.
 */
export function ssoLockoutError(current, patch) {
  if (!AUTH_PATCH_KEYS.some((key) => Object.hasOwn(patch, key))) return "";
  const next = { ...current, ...patch };
  if (!String(patch.oidcClientSecret ?? "").trim()) {
    // Presence without exposure: metadata-mode current has no secret value,
    // only secretsConfigured — that still proves OIDC reachable.
    next.oidcClientSecret =
      typeof current.oidcClientSecret === "string" && current.oidcClientSecret.trim()
        ? current.oidcClientSecret
        : current.secretsConfigured?.oidcClientSecret
          ? "__configured__"
          : "";
  }
  const modes = resolveAuthModes(next);
  if (!modes.ssoOnly) return "";
  if (modes.saml && !isSamlConfigured(next)) {
    return 'Cannot enable SSO-only sign-in: SAML is not fully configured (entry point and certificate are required). Configure and test it with "Password + SSO" first.';
  }
  if (modes.oidc && !isOidcConfigured(next)) {
    return 'Cannot enable SSO-only sign-in: OIDC is not fully configured (issuer URL, client ID and client secret are required). Configure and test it with "Password + SSO" first.';
  }
  return "";
}

export function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function validAccountSettings(body) {
  if (Object.hasOwn(body, "fallbackStrategy") && !ACCOUNT_STRATEGIES.has(body.fallbackStrategy)) {
    return false;
  }
  if (
    Object.hasOwn(body, "stickyRoundRobinLimit") &&
    !validStickyLimit(body.stickyRoundRobinLimit)
  ) {
    return false;
  }
  if (Object.hasOwn(body, "providerStrategies")) {
    if (!isPlainObject(body.providerStrategies)) return false;
    for (const [provider, strategy] of Object.entries(body.providerStrategies)) {
      if (
        provider !== provider.trim() ||
        !provider ||
        UNSAFE_KEYS.has(provider) ||
        !isPlainObject(strategy) ||
        Object.keys(strategy).some((key) => UNSAFE_KEYS.has(key))
      ) {
        return false;
      }
      if (
        Object.hasOwn(strategy, "fallbackStrategy") &&
        !ACCOUNT_STRATEGIES.has(strategy.fallbackStrategy)
      ) {
        return false;
      }
      if (
        Object.hasOwn(strategy, "stickyRoundRobinLimit") &&
        !validStickyLimit(strategy.stickyRoundRobinLimit)
      ) {
        return false;
      }
    }
  }
  return true;
}

const SSO_MAX_LIST = 100;
const SSO_MAX_CLAIM_DEPTH = 5;
const SSO_MAP_ROLES = new Set(["manager", "member", "viewer"]);

/** Whether `body` carries any rollout-gated policy key (YAN-359 six + YAN-369 grants toggle). */
export function hasSsoPolicyKeys(body) {
  return (
    !!body &&
    typeof body === "object" &&
    [...SSO_POLICY_KEYS, ...GRANT_POLICY_KEYS].some((k) => Object.hasOwn(body, k))
  );
}

const nonEmptyText = (v) => typeof v === "string" && v.length > 0 && v.length <= MAX_TEXT_LEN;

/**
 * Shape check for the six SSO group-policy keys (YAN-359). Not pure: it
 * deduplicates the two group lists on `body` in place. Returns an error or "".
 * @param {object} body Plain settings object.
 */
export function validateSsoPolicy(body) {
  if (Object.hasOwn(body, "ssoGroupsClaim")) {
    const v = body.ssoGroupsClaim;
    const parts = typeof v === "string" ? v.split(".") : [];
    if (
      !nonEmptyText(v) ||
      parts.length > SSO_MAX_CLAIM_DEPTH ||
      parts.some((p) => !p || UNSAFE_KEYS.has(p))
    ) {
      return "Invalid ssoGroupsClaim";
    }
  }
  if (Object.hasOwn(body, "samlAttributeGroups")) {
    const v = body.samlAttributeGroups;
    if (!nonEmptyText(v) || UNSAFE_KEYS.has(v)) return "Invalid samlAttributeGroups";
  }
  for (const key of ["ssoAllowedGroups", "ssoAdminGroups"]) {
    if (!Object.hasOwn(body, key)) continue;
    const v = body[key];
    if (!Array.isArray(v) || v.length > SSO_MAX_LIST || !v.every(nonEmptyText)) {
      return `Invalid ${key}`;
    }
    body[key] = [...new Set(v)];
  }
  if (Object.hasOwn(body, "ssoDefaultRole") && !["pending", "user"].includes(body.ssoDefaultRole)) {
    return "Invalid ssoDefaultRole";
  }
  if (Object.hasOwn(body, "ssoGroupWorkspaceMap")) {
    const v = body.ssoGroupWorkspaceMap;
    const ok =
      Array.isArray(v) &&
      v.length <= SSO_MAX_LIST &&
      v.every(
        (e) =>
          isPlainObject(e) &&
          Object.keys(e).length === 3 &&
          nonEmptyText(e.group) &&
          nonEmptyText(e.workspaceId) &&
          SSO_MAP_ROLES.has(e.role),
      );
    if (!ok) return "Invalid ssoGroupWorkspaceMap";
  }
  return "";
}

/**
 * Async DB check: every mapped workspace must be an existing shared one.
 * Call after `validateSsoPolicy`, before any write.
 * @param {Array<{ workspaceId: string }>} map
 * @returns {Promise<string>} Error message, or "".
 */
export async function validateSsoWorkspaceTargets(map) {
  const ids = [...new Set((map ?? []).map((e) => e.workspaceId))];
  if (!ids.length) return "";
  const db = await getAdapter();
  const rows = db.all(
    `SELECT id FROM workspaces WHERE kind = 'shared' AND id IN (${ids.map(() => "?").join(",")})`,
    ids,
  );
  const found = new Set(rows.map((r) => r.id));
  return ids.every((id) => found.has(id))
    ? ""
    : "Invalid ssoGroupWorkspaceMap: unknown or personal workspace";
}

/**
 * Every boundary check PATCH applies to a settings body, in PATCH order.
 * Shared with config import so it can never store what PATCH would reject.
 * @param {object} body Plain settings object.
 * @returns {string} Error message, or "" when valid.
 */
export function validateSettingsBody(body) {
  const ssoPolicyError = validateSsoPolicy(body);
  if (ssoPolicyError) return ssoPolicyError;
  const comboStrategyError = validateComboStrategySettings(body);
  if (comboStrategyError) return comboStrategyError;
  if (!validAccountSettings(body)) return "Invalid account strategy settings";
  return validSecuritySettings(body) || validateSectionSettings(body) || "";
}

// Keys the dashboard PATCHes that DEFAULT_SETTINGS does not list (YAN-362):
// every other dashboard key is a DEFAULT_SETTINGS key or a section-validated one.
const EXTRA_KNOWN_KEYS = [
  "providerThinking",
  "ccFilterNaming",
  "claudeAutoPing",
  "codexAutoPing",
  "headroomCodeAware",
  "headroomKompress",
  "currentPassword",
  "newPassword",
];

/** Every settings key PATCH /api/settings may receive in split mode. */
export const KNOWN_SETTING_KEYS = new Set([...Object.keys(DEFAULT_SETTINGS), ...EXTRA_KNOWN_KEYS]);
