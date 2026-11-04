// YAN-1547: the only request-time writer of the instance rollout switch.
// Never bootstrap, hash gateway keys or encrypt credentials from this control.
import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { getPrincipal, pristineAdminPrincipal } from "@/lib/users/session.js";
import { isUserSecurityEnforced } from "@/lib/users/securityState.js";
import { can } from "@/lib/users/principal.js";
import { effectiveFor, getMultiUserSwitchState } from "@/lib/users/featureSwitch.js";
import { isCrossSite } from "@/lib/auth/sameOrigin.js";
import {
  countActiveUsersUnscoped,
  getMeta,
  listWorkspacesUnscoped,
  setMultiUserEnabledUnscoped,
} from "@/lib/db/index.js";
import { audit } from "@/lib/users/audit.js";
import { getClientIp } from "@/lib/auth/loginLimiter.js";
import { PENDING_DEFAULT_WORKSPACE } from "@/lib/db/repos/ownership.js";

/**
 * Normal live principal, or the authenticated single-admin authority on a
 * pristine switch-off install. getPrincipal intentionally returns null there;
 * don't turn that permissive null into authorization. Verify session / CLI /
 * login-disabled local-owner proof explicitly without creating an owner row.
 */
async function switchPrincipal() {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);
  // Gateway keys never grant this instance capability, even with login off.
  if (
    headerList.has("authorization") ||
    headerList.has("x-api-key") ||
    headerList.has("x-goog-api-key")
  )
    return null;
  const principal = await getPrincipal();
  if (principal) return principal;
  if (await isUserSecurityEnforced()) return null;
  return pristineAdminPrincipal({ cookies: cookieStore, headers: headerList });
}

export async function multiUserSwitchVisible() {
  try {
    return can(await switchPrincipal(), "instance.settings.manage");
  } catch {
    return false;
  }
}

/**
 * Shared workspaces exclude Default by its stable marker, not its name, and
 * the pending Default of switch-off budgets (YAN-1829), which becomes it.
 */
export async function multiUserSwitchResponse() {
  const [state, activeUsers, workspaces, defaultId, pendingId] = await Promise.all([
    getMultiUserSwitchState(),
    countActiveUsersUnscoped(),
    listWorkspacesUnscoped(),
    getMeta("defaultWorkspaceId"),
    getMeta(PENDING_DEFAULT_WORKSPACE),
  ]);
  return {
    ...state,
    activeUsers,
    sharedWorkspaces: workspaces.filter(
      (w) => w.kind === "shared" && w.id !== defaultId && w.id !== pendingId,
    ).length,
  };
}

export async function handleMultiUserSwitchPatch(request, body) {
  if (isCrossSite(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (Object.keys(body).length !== 1) {
    return NextResponse.json(
      { error: "multiUserEnabled must be the only setting" },
      { status: 400 },
    );
  }
  if (typeof body.multiUserEnabled !== "boolean") {
    return NextResponse.json(
      { error: "Invalid multiUserEnabled: must be a boolean" },
      { status: 400 },
    );
  }
  const principal = await switchPrincipal();
  if (!principal) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(principal, "instance.settings.manage"))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const before = await getMultiUserSwitchState();
  if (before.envLocked) {
    return NextResponse.json(
      { error: "Set by TOKENHOP_MULTI_USER", code: "MULTI_USER_ENV_LOCKED" },
      { status: 409 },
    );
  }
  // Switch write and off→on adoption commit together (one transaction):
  // the owner bootstrap is memoised, so rows written while the switch was off
  // would otherwise stay ownerless. Detached usage history is never adopted;
  // nothing is adopted before first startup activation (no owner row yet).
  const adopt = !before.effective && effectiveFor(body.multiUserEnabled);
  const n = await setMultiUserEnabledUnscoped(body.multiUserEnabled, { adopt });
  if (n) console.log(`[users] Moved ${n} ownerless row(s) into Default`);
  await audit(
    { principal, ip: getClientIp(request) },
    "settings.multi_user",
    { type: "settings" },
    { before: { enabled: before.stored }, after: { enabled: body.multiUserEnabled } },
  );
  return NextResponse.json(
    { multiUserSwitch: await multiUserSwitchResponse() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
