import { NextResponse } from "next/server";
import { getSettings, updateComboStrategies, updateSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resolveDensity, resolveFlagSetting, resolveStartPage } from "@/lib/settingsFlags";
import { resetComboRotation } from "open-sse/services/combo.js";
import { validateComboStrategySettings } from "open-sse/services/comboStrategy.js";
import { validateSectionSettings } from "./validateSectionSettings.js";
import {
  RELIABILITY_KEYS,
  mergeReliabilityPatch,
  validateReliabilitySettings,
} from "./validateReliabilitySettings.js";
import { syncReliabilityAfterPatch } from "@/lib/reliability/initReliabilityPolicy";
import { SECRET_SETTING_KEYS } from "@/lib/settingsConfigDoc";
import bcrypt from "bcryptjs";
import { isOidcConfigured } from "@/lib/auth/oidc";
import { isSamlConfigured } from "@/lib/auth/saml.js";
import { resolveAuthModes } from "@/lib/auth/authModes";
import { revokeOwnerSessions, singleUserModeAllowed } from "@/lib/users/session";
import { handleEstablishedOwnerPassword } from "@/lib/auth/ownerPassword.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SETTINGS_RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
};

// Secrets must never be mass-assigned from request body (CWE-915).
// The MITM internal verifier rides the internal settings lifecycle only —
// user PATCH can't smuggle it in alongside the password/mitmSudoEncrypted
// strip above.
const PROTECTED_SETTING_KEYS = ["password", "mitmSudoEncrypted", "mitmInternalVerifier"];
const VALID_COMBO_NAME = /^[a-zA-Z0-9_.-]+$/;
const BLOCKED_COMBO_NAMES = new Set(["__proto__", "constructor", "prototype"]);

// Credentials (hashes, encrypted sudo password, private keys, …) never leave the server.
function omitSecrets(settings) {
  const safeSettings = Object.fromEntries(
    Object.entries(settings).filter(([key]) => !SECRET_SETTING_KEYS.has(key)),
  );
  // YAN-351: the users & teams switch stays off the API until the v1.1.0 release.
  delete safeSettings.multiUserEnabled;
  safeSettings.oidcConfigured = !!(
    settings.oidcIssuerUrl &&
    settings.oidcClientId &&
    settings.oidcClientSecret
  );
  return safeSettings;
}

function safeSettingsResponse(settings) {
  const safeSettings = omitSecrets(settings);
  safeSettings.startPage = resolveStartPage(safeSettings.startPage);
  safeSettings.uiDensity = resolveDensity(safeSettings.uiDensity);
  return NextResponse.json(safeSettings, { headers: SETTINGS_RESPONSE_HEADERS });
}

async function handleComboStrategyPatch(body) {
  const { name, patch } = body.comboStrategyPatch || {};
  if (typeof name !== "string" || !VALID_COMBO_NAME.test(name) || BLOCKED_COMBO_NAMES.has(name)) {
    return NextResponse.json({ error: "Invalid combo name" }, { status: 400 });
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return NextResponse.json({ error: "Invalid combo strategy patch" }, { status: 400 });
  }
  // Preserve fusion settings edits; reject unknown keys instead of silently storing them.
  const allowed = new Set(["fallbackStrategy", "weights", "judgeModel", "fusionTuning"]);
  if (Object.keys(patch).some((key) => !allowed.has(key))) {
    return NextResponse.json({ error: "Invalid combo strategy patch" }, { status: 400 });
  }
  const error = validateComboStrategySettings({ comboStrategies: { [name]: patch } });
  if (error) return NextResponse.json({ error }, { status: 400 });

  // Validation against the merged entry happens inside the transaction too (weight-count cap).
  let mergedError;
  let missingWeightedEntry = false;
  let settings;
  try {
    settings = await updateComboStrategies((strategies) => {
      const base = Object.hasOwn(strategies, name) ? strategies[name] : {};
      if (
        Object.hasOwn(patch, "weights") &&
        !Object.hasOwn(patch, "fallbackStrategy") &&
        base?.fallbackStrategy !== "weighted"
      ) {
        missingWeightedEntry = true;
        return strategies;
      }
      const next = { ...base, ...patch };
      if (patch.weights) next.weights = { ...base?.weights, ...patch.weights };
      mergedError = validateComboStrategySettings({ comboStrategies: { [name]: next } });
      if (mergedError) return strategies;
      const updated = { ...strategies };
      // An explicit "fallback" is stored: deleting the entry would make the combo
      // silently inherit the global comboStrategy instead (YAN-679).
      if (!next.fallbackStrategy) {
        delete updated[name];
      } else {
        updated[name] = next;
      }
      return updated;
    }, name);
  } catch (error) {
    if (error.code === "COMBO_NOT_FOUND") {
      return NextResponse.json({ error: "Combo not found" }, { status: 409 });
    }
    throw error;
  }
  if (missingWeightedEntry) return NextResponse.json({ error: "Combo not found" }, { status: 409 });
  if (mergedError) return NextResponse.json({ error: mergedError }, { status: 400 });

  resetComboRotation();
  import("@/shared/services/quotaSnapshotPoller")
    .then(({ syncQuotaSnapshotPoller }) => syncQuotaSnapshotPoller())
    .catch((error) => console.warn("[QuotaSnapshotPoller] settings update failed:", error.message));
  return safeSettingsResponse(settings);
}

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
  for (const key of ["requireLogin", "requireApiKey", "tunnelDashboardAccess"]) {
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
  if (!String(patch.oidcClientSecret ?? "").trim())
    next.oidcClientSecret = current.oidcClientSecret;
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

function isPlainObject(value) {
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

/**
 * Every boundary check PATCH applies to a settings body, in PATCH order.
 * Shared with config import so it can never store what PATCH would reject.
 * @param {object} body Plain settings object.
 * @returns {string} Error message, or "" when valid.
 */
export function validateSettingsBody(body) {
  const comboStrategyError = validateComboStrategySettings(body);
  if (comboStrategyError) return comboStrategyError;
  if (!validAccountSettings(body)) return "Invalid account strategy settings";
  return validSecuritySettings(body) || validateSectionSettings(body) || "";
}

export async function GET() {
  try {
    const settings = await getSettings();
    const safeSettings = omitSecrets(settings);

    const requestLogs = resolveFlagSetting(
      "ENABLE_REQUEST_LOGS",
      settings.requestLogsEnabled,
      false,
    );
    const translator = resolveFlagSetting("ENABLE_TRANSLATOR", settings.translatorEnabled, false);
    // YAN-311 stream-timeout env precedence: an explicit env var wins over the
    // stored setting; the UI shows ".env overrides" and disables the field.
    // Only non-empty values count — envMs() falls back on garbage, matching
    // streamEnvOverrides so the badge never lies about the effective value.
    const hasEnv = (name) => {
      const raw = process.env[name];
      if (raw == null || raw === "") return false;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n > 0;
    };
    const streamEnvOverrides = {
      ...(hasEnv("STREAM_FIRST_CHUNK_TIMEOUT_MS") ? { firstChunkMs: true } : {}),
      ...(hasEnv("STREAM_STALL_TIMEOUT_MS") ? { stallMs: true } : {}),
      ...(hasEnv("FETCH_CONNECT_TIMEOUT_MS") ? { connectMs: true } : {}),
    };

    // YAN-310 read-only env values: surfaced, never writable (PATCH rejects them).
    const { CLAUDE_CLI_VERSION } = await import("open-sse/config/claudeCliFingerprint.js");
    const { CODEX_CLI_VERSION } = await import("open-sse/config/codexCliFingerprint.js");
    const { GROK_CLI_VERSION } = await import("open-sse/config/grokCli.js");
    const { ZED_CLIENT_VERSION } = await import("open-sse/config/zedClientFingerprint.js");

    return NextResponse.json(
      {
        ...safeSettings,
        enableRequestLogs: requestLogs.value,
        enableTranslator: translator.value,
        requestLogsOverridden: requestLogs.overridden,
        translatorOverridden: translator.overridden,
        startPage: resolveStartPage(settings.startPage),
        uiDensity: resolveDensity(settings.uiDensity),
        hasPassword: !!settings.password,
        searxngUrl: process.env.SEARXNG_URL?.trim() || "",
        headroomUrlFromEnv: !!process.env.HEADROOM_URL?.trim(),
        requestLogEnvOverride: requestLogs.overridden,
        streamEnvOverrides,

        CLAUDE_CLI_VERSION,
        CODEX_CLI_VERSION,
        GROK_CLI_VERSION,
        ZED_CLIENT_VERSION,
      },
      { headers: SETTINGS_RESPONSE_HEADERS },
    );
  } catch (error) {
    console.log("Error getting settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();
    if (!isPlainObject(body)) {
      return NextResponse.json({ error: "Settings body must be an object" }, { status: 400 });
    }

    // Established install: password change goes only through the owner session
    // + change-password route. Pristine falls through to the legacy path below.
    const ownerPasswordResponse = await handleEstablishedOwnerPassword(request, body);
    if (ownerPasswordResponse) return ownerPasswordResponse;

    if (Object.hasOwn(body, "comboStrategyPatch") && Object.keys(body).length !== 1) {
      return NextResponse.json(
        { error: "comboStrategyPatch must be the only setting" },
        { status: 400 },
      );
    }

    // Strip protected secrets before any internal handling sets them
    for (const key of PROTECTED_SETTING_KEYS) delete body[key];

    if (Object.hasOwn(body, "comboStrategyPatch")) {
      return await handleComboStrategyPatch(body);
    }

    const settingsError = validateSettingsBody(body);
    if (settingsError) {
      return NextResponse.json({ error: settingsError }, { status: 400 });
    }
    // Reliability keys are nested objects; the store merges top-level only, so
    // fold partial patches over the current value to keep every leaf.
    // (Concurrent leaf PATCHes can still race; the store has no transaction —
    // same as every other key on this route.)
    const currentReliability = await getSettings();
    const reliabilityError = validateReliabilitySettings(body, currentReliability);
    if (reliabilityError) {
      return NextResponse.json({ error: reliabilityError }, { status: 400 });
    }
    const lockoutError = ssoLockoutError(currentReliability, body);
    if (lockoutError) return NextResponse.json({ error: lockoutError }, { status: 400 });
    if (body.requireLogin === false && !(await singleUserModeAllowed())) {
      const error = "Login can't be turned off while more than one active user exists.";
      return NextResponse.json({ error }, { status: 409 });
    }
    if (RELIABILITY_KEYS.some((key) => Object.hasOwn(body, key))) {
      for (const key of RELIABILITY_KEYS) {
        if (Object.hasOwn(body, key))
          body[key] = mergeReliabilityPatch(currentReliability[key], body[key]);
      }
    }

    // Password updates hash into `password`; raw password keys must never persist (CWE-915).
    // Raw password material for verification/hashing only; never persisted (CWE-915).
    const rawNewPassword = typeof body.newPassword === "string" ? body.newPassword : "";
    const attemptedCurrent = typeof body.currentPassword === "string" ? body.currentPassword : "";
    delete body.newPassword;
    delete body.currentPassword;
    if (rawNewPassword) {
      const settings = await getSettings();
      const currentHash = settings.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!attemptedCurrent) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(attemptedCurrent, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      } else if (attemptedCurrent && attemptedCurrent !== "123456") {
        // First time setting password, no current password needed
        return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
      }

      const salt = await bcrypt.genSalt(10);
      body.password = await bcrypt.hash(rawNewPassword, salt);
    }

    if (Object.hasOwn(body, "oidcClientSecret")) {
      if (!body.oidcClientSecret || !String(body.oidcClientSecret).trim()) {
        delete body.oidcClientSecret;
      }
    }

    // A password change signs the owner out everywhere else (ADR-0004). Owner
    // first: if that fails, the old password and sessions stay as they were.
    if (rawNewPassword) await revokeOwnerSessions(request, { passwordHash: body.password });
    const settings = await updateSettings(body);

    // Full-object reliability edits (nested UI writes) re-resolve here; the
    // sync is additive and never touches other keys.
    syncReliabilityAfterPatch(body, settings);

    // Apply outbound proxy settings immediately (no restart required)
    if (
      Object.hasOwn(body, "outboundProxyEnabled") ||
      Object.hasOwn(body, "outboundProxyUrl") ||
      Object.hasOwn(body, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    // Refresh the request-logger runtime gate (env var still wins when set).
    if (Object.hasOwn(body, "requestLogsEnabled")) {
      import("open-sse/utils/requestLogger.js")
        .then(({ notifyRequestLogsEnabled }) =>
          notifyRequestLogsEnabled(settings.requestLogsEnabled === true),
        )
        .catch((error) => console.warn("[RequestLogger] settings update failed:", error.message));
    }

    // Invalidate combo rotation state when strategy settings change
    if (
      Object.hasOwn(body, "comboStrategy") ||
      Object.hasOwn(body, "comboStickyRoundRobinLimit") ||
      Object.hasOwn(body, "comboStrategies")
    ) {
      resetComboRotation();
    }

    if (
      Object.hasOwn(body, "fallbackStrategy") ||
      Object.hasOwn(body, "stickyRoundRobinLimit") ||
      Object.hasOwn(body, "providerStrategies")
    ) {
      // Reset in-memory SWRR state when account strategy changes. Lazy import keeps
      // auth.js's DB imports out of the route's static graph.
      import("@/sse/services/auth")
        .then(({ resetAccountSelection }) => resetAccountSelection?.())
        .catch((error) => console.warn("[AccountSelection] reset failed:", error.message));
    }

    if (Object.hasOwn(body, "claudeAutoPing") || Object.hasOwn(body, "codexAutoPing")) {
      // Keep the scheduler absent when no account opted in; load its provider graph only on demand.
      import("@/shared/services/quotaAutoPing")
        .then(({ configureQuotaAutoPing }) => {
          configureQuotaAutoPing(settings);
        })
        .catch((error) => console.warn("[AutoPing] settings update failed:", error.message));
    }

    if (
      Object.hasOwn(body, "fallbackStrategy") ||
      Object.hasOwn(body, "providerStrategies") ||
      Object.hasOwn(body, "comboStrategies") ||
      Object.hasOwn(body, "comboStrategy")
    ) {
      // Weighted gating changed: start/stop the snapshot backfill poller (YAN-259).
      import("@/shared/services/quotaSnapshotPoller")
        .then(({ syncQuotaSnapshotPoller }) => {
          syncQuotaSnapshotPoller();
        })
        .catch((error) =>
          console.warn("[QuotaSnapshotPoller] settings update failed:", error.message),
        );
    }

    return safeSettingsResponse(settings);
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
