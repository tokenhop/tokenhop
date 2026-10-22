// Users & teams feature switch (YAN-351). The only reader of TOKENHOP_MULTI_USER
// and of the `multiUserEnabled` setting: everything else asks this module.
// Off means exactly today's single-user install.
import { NextResponse } from "next/server";
import { getMultiUserEnabledSettingRaw } from "@/lib/db/repos/settingsRepo.js";

export const MULTI_USER_ENV = "TOKENHOP_MULTI_USER";

/**
 * Parse the env override. Empty counts as unset, like NEXT_PUBLIC_BRAND.
 * @param {string|undefined} raw
 * @returns {boolean|undefined} undefined when unset.
 */
export function parseMultiUserEnv(raw) {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "on") return true;
  if (raw === "off") return false;
  throw new Error(
    `${MULTI_USER_ENV}: invalid value ${JSON.stringify(raw)}; allowed values: "on", "off"`,
  );
}

// Fail fast: a bad value throws when the module loads (instrumentation imports it at startup).
const ENV_OVERRIDE = parseMultiUserEnv(process.env[MULTI_USER_ENV]);

/** Raw boot resolution only; startup must not consume the request-time gate. */
export async function resolveMultiUserAtBoot() {
  if (ENV_OVERRIDE !== undefined) return ENV_OVERRIDE;
  return getMultiUserEnabledSettingRaw();
}

function pendingRestartFor(stored) {
  // Read the shared startup record, not startupReadiness (no import cycle or
  // extra hot-path DB read). No startup record in unit tests means no gate.
  const boot = globalThis[Symbol.for("tokenhop.gatewayKeyStartup")];
  return (
    ENV_OVERRIDE === undefined &&
    stored &&
    boot?.multiUserAtBoot === false &&
    boot?.activation?.status === "skipped-off"
  );
}

/** Env override, else the live setting, gated until first startup activation. */
export async function isMultiUserEnabled() {
  if (ENV_OVERRIDE !== undefined) return ENV_OVERRIDE;
  const stored = await getMultiUserEnabledSettingRaw();
  return stored && !pendingRestartFor(stored);
}

/** Instance-control metadata; the raw stored value is never an effective gate. */
export async function getMultiUserSwitchState() {
  const stored = await getMultiUserEnabledSettingRaw();
  const pendingRestart = pendingRestartFor(stored);
  return {
    stored,
    effective: ENV_OVERRIDE ?? (stored && !pendingRestart),
    envLocked: ENV_OVERRIDE !== undefined,
    envValue: ENV_OVERRIDE === undefined ? null : ENV_OVERRIDE ? "on" : "off",
    pendingRestart,
  };
}

/**
 * Route guard for multi-user routes: a 404 response while the switch is off
 * (as if the route didn't exist), else null.
 * Usage: `const hidden = await requireMultiUser(); if (hidden) return hidden;`
 * @returns {Promise<Response|null>}
 */
export async function requireMultiUser() {
  if (await isMultiUserEnabled()) return null;
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
