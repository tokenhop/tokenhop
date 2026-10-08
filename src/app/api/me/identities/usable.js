// YAN-371: shared helpers for the /api/me/identities routes.
import { NextResponse } from "next/server";
import { resolveAuthModes } from "@/lib/auth/authModes.js";
import { getSettings, getUserPasswordHashUnscoped } from "@/lib/db/index.js";

const NO_STORE = { "Cache-Control": "no-store" };
export const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

/**
 * Sign-in methods the user can use right now: SSO providers the current
 * auth mode allows, and password when it's allowed and the user has a hash.
 * @param {string} userId
 * @returns {Promise<{ sso: Set<string>, password: boolean }>}
 */
export async function usableMethods(userId) {
  const modes = resolveAuthModes(await getSettings());
  const sso = new Set(["oidc", "saml"].filter((p) => modes[p]));
  const password = modes.password && Boolean(await getUserPasswordHashUnscoped(userId));
  return { sso, password };
}
