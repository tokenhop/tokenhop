// Users & teams feature switch (YAN-351). The only reader of TOKENHOP_MULTI_USER
// and of the `multiUserEnabled` setting: everything else asks this module.
// Off means exactly today's single-user install.
import { NextResponse } from "next/server";
import { getSettings } from "@/lib/db/index.js";

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

/**
 * Env override, else the stored instance setting, else off.
 * @returns {Promise<boolean>}
 */
export async function isMultiUserEnabled() {
  if (ENV_OVERRIDE !== undefined) return ENV_OVERRIDE;
  const settings = await getSettings();
  return settings?.multiUserEnabled === true;
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
