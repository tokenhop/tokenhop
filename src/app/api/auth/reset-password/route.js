import { NextResponse } from "next/server";
import { updateSettings } from "@/lib/localDb";
import { revokeOwnerSessions } from "@/lib/users/session";

// Reset dashboard password to default by clearing the stored hash.
// Local-only (enforced by dashboardGuard). Never returns the default literal.
export async function POST() {
  try {
    // Owner first, like PATCH /api/settings: a failure leaves both unchanged.
    await revokeOwnerSessions(null, { passwordHash: null });
    await updateSettings({ password: null });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
