import { NextResponse } from "next/server";
import { updateSettings } from "@/lib/localDb";
import { cliTokenAccepted, hasValidSession, revokeOwnerSessions } from "@/lib/users/session";
import { isUserSecurityEnforced } from "@/lib/users/securityState.js";
import { getOwnerUnscoped, setUserPasswordUnscoped } from "@/lib/db/index.js";
import { isLocalRequest } from "@/dashboardGuard";

const NO_STORE = { "Cache-Control": "no-store" };

// Reset dashboard password to default by clearing the stored hash.
// Local-only (enforced by dashboardGuard). Never returns the default literal.
export async function POST(request) {
  try {
    if (await isUserSecurityEnforced()) return resetEstablished(request);
    // Owner first, like PATCH /api/settings: a failure leaves both unchanged.
    await revokeOwnerSessions(null, { passwordHash: null });
    await updateSettings({ password: null });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// YAN-358: re-check the guard's local-only rule here (CLI token, or a live
// session from a loopback browser), then clear the owner hash and its settings
// mirror in one transaction. The flag forces a new password on next login;
// sv bumps once, so every owner session ends. No cookie is issued.
async function resetEstablished(request) {
  try {
    const local =
      (await cliTokenAccepted(request)) ||
      (isLocalRequest(request) && (await hasValidSession(request)));
    if (!local)
      return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
    const owner = await getOwnerUnscoped();
    if (!owner)
      return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
    await setUserPasswordUnscoped(owner.id, {
      passwordHash: null,
      mustChangePassword: true,
      expectedSessionVersion: owner.sessionVersion,
    });
    return NextResponse.json({ success: true }, { headers: NO_STORE });
  } catch (err) {
    const status = err?.code === "API_KEY_STATE_INVALID" ? 503 : 500;
    return NextResponse.json({ error: "Password reset failed" }, { status, headers: NO_STORE });
  }
}
