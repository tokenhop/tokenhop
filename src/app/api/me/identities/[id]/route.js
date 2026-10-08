// YAN-371: DELETE /api/me/identities/:id — unlink one of the caller's SSO
// identities. The last usable sign-in method can't be removed (409). Success
// bumps sessionVersion (other sessions end) and re-mints this browser's
// cookie with its original expiry (ADR-0004). Switch off: 404.
import { cookies } from "next/headers";
import { requireMultiUser } from "@/lib/users/featureSwitch.js";
import { getPrincipal, remintClaims } from "@/lib/users/session.js";
import { getDashboardAuthSession, setDashboardAuthCookie } from "@/lib/auth/dashboardSession.js";
import { isCrossSite } from "@/lib/auth/sameOrigin.js";
import { bumpSessionVersion, unlinkSsoIdentityGuarded } from "@/lib/db/index.js";
import { audit } from "@/lib/users/audit.js";
import { json, usableMethods } from "../usable.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const ERRORS = {
  NOT_FOUND: [404, { error: "Identity not found" }],
  INVALID: [400, { error: "The password sign-in can't be unlinked", code: "password_identity" }],
  LAST_METHOD: [409, { error: "This is your last way to sign in", code: "last_login_method" }],
};

export async function DELETE(request, { params }) {
  try {
    const hidden = await requireMultiUser();
    if (hidden) return hidden;
    if (isCrossSite(request)) return json({ error: "Forbidden", code: "forbidden_origin" }, 403);
    const principal = await getPrincipal();
    if (principal?.via !== "session") return json({ error: "Unauthorized" }, 401);

    const cookieStore = await cookies();
    const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);
    if (typeof session?.sub !== "string" || session.sub !== principal.userId) {
      return json({ error: "Unauthorized" }, 401);
    }

    const { id } = await params;
    try {
      await unlinkSsoIdentityGuarded(principal, id, await usableMethods(principal.userId));
    } catch (err) {
      const mapped = ERRORS[err?.code];
      if (mapped) return json(mapped[1], mapped[0]);
      throw err;
    }

    await bumpSessionVersion(principal.userId);
    const claims = await remintClaims(session, session.wid);
    if (claims?.sub) {
      await setDashboardAuthCookie(cookieStore, request, claims, { exp: session.exp });
    }
    await audit({ principal, request }, "identity.unlink", { type: "identity", id });
    return json({ success: true });
  } catch (error) {
    return json({ error: error.message }, 500);
  }
}
