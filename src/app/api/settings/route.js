import { NextResponse } from "next/server";
import { getSettings, updateComboStrategies, updateSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resolveDensity, resolveFlagSetting, resolveStartPage } from "@/lib/settingsFlags";
import { getLegacyPasswordHash } from "@/lib/db/repos/workspaceSettingsRepo.js";
import { classifyKey } from "@/lib/settings/settingsScope.js";
import {
  RELIABILITY_KEYS,
  mergeReliabilityPatch,
  validateReliabilitySettings,
} from "./validateReliabilitySettings.js";
import { syncReliabilityAfterPatch } from "@/lib/reliability/initReliabilityPolicy";
import { SECRET_SETTING_KEYS } from "@/lib/settingsConfigDoc";
import bcrypt from "bcryptjs";
import { revokeOwnerSessions, singleUserModeAllowed } from "@/lib/users/session";
import { can } from "@/lib/users/principal.js";
import { audit } from "@/lib/users/audit.js";
import { getClientIp } from "@/lib/auth/loginLimiter.js";
import { principalScope } from "@/lib/users/workspaceScope.js";
import { handleEstablishedOwnerPassword } from "@/lib/auth/ownerPassword.js";
import { applyComboStrategyPatch } from "./comboStrategyPatch.js";
import { runSettingsSideEffects } from "./settingsSideEffects.js";
import {
  KNOWN_SETTING_KEYS,
  isPlainObject,
  ssoLockoutError,
  validateSettingsBody,
} from "./validateSettings.js";

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
  const result = await applyComboStrategyPatch(body, updateComboStrategies);
  if (result.response) return result.response;
  runSettingsSideEffects({ comboStrategyPatch: true }, result.settings);
  return safeSettingsResponse(result.settings);
}

// Split mode (YAN-362): this route carries instance keys only. Workspace and
// user keys moved to their own routes; password keys moved to the owner
// password lifecycle. Unknown keys are rejected here and nowhere else.
function splitKeyError(body) {
  for (const key of Object.keys(body)) {
    const scope = classifyKey(key);
    if (scope === "workspace" || key === "comboStrategyPatch") {
      return "moved: use /api/workspaces/:id/settings";
    }
    if (scope === "user") return "moved: use /api/me/preferences";
    if (scope === "removed") return "moved: use /api/auth/change-password";
    if (scope === "instance" && !KNOWN_SETTING_KEYS.has(key)) return `Unknown setting: ${key}`;
  }
  return "";
}

// Split mode: workspace/user keys never ride the instance view.
function instanceOnly(settings) {
  return Object.fromEntries(
    Object.entries(settings).filter(([key]) => {
      const scope = classifyKey(key);
      return scope !== "workspace" && scope !== "user";
    }),
  );
}

export async function GET() {
  try {
    const split = await principalScope();
    if (split instanceof Response) return split;

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

    const payload = {
      ...safeSettings,
      enableRequestLogs: requestLogs.value,
      enableTranslator: translator.value,
      requestLogsOverridden: requestLogs.overridden,
      translatorOverridden: translator.overridden,
      startPage: resolveStartPage(settings.startPage),
      uiDensity: resolveDensity(settings.uiDensity),
      hasPassword: !!(await getLegacyPasswordHash(settings)),
      searxngUrl: process.env.SEARXNG_URL?.trim() || "",
      headroomUrlFromEnv: !!process.env.HEADROOM_URL?.trim(),
      requestLogEnvOverride: requestLogs.overridden,
      streamEnvOverrides,

      CLAUDE_CLI_VERSION,
      CODEX_CLI_VERSION,
      GROK_CLI_VERSION,
      ZED_CLIENT_VERSION,
    };
    return NextResponse.json(split ? instanceOnly(payload) : payload, {
      headers: SETTINGS_RESPONSE_HEADERS,
    });
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

    if (body.requireLogin === false && !(await singleUserModeAllowed())) {
      return NextResponse.json(
        { error: "Login can't be turned off while more than one active user exists." },
        { status: 409 },
      );
    }

    // Split mode (2+ users): instance keys only (YAN-362). Switch off or
    // single user: today's flat path, byte-identical.
    const split = await principalScope();
    if (split instanceof Response) return split;
    if (split) {
      if (!can(split.ctx, "instance.settings.manage")) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      const movedError = splitKeyError(body);
      if (movedError) return NextResponse.json({ error: movedError }, { status: 400 });
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
      const currentHash = await getLegacyPasswordHash(settings);

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

    runSettingsSideEffects(body, settings);

    // YAN-367: audit the change — key names only; secret VALUES never enter the
    // audit path (the helper's allow-list would drop them; names are the signal).
    await audit(
      { principal: split?.ctx ?? null, ip: getClientIp(request) },
      "settings.update",
      { type: "settings" },
      { after: { keyNames: Object.keys(body).filter((k) => k !== "password") } },
    );
    if (rawNewPassword) {
      await audit(
        { principal: split?.ctx ?? null, ip: getClientIp(request) },
        "user.passwordChange",
        { type: "user" },
        {},
      );
    }

    return safeSettingsResponse(settings);
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
