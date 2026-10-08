// YAN-371: GET /api/me/identities — the caller's linked sign-in identities.
// Never returns the IdP subject or the user id. Switch off: 404. Browser session only.
import { requireMultiUser } from "@/lib/users/featureSwitch.js";
import { getPrincipal } from "@/lib/users/session.js";
import { listIdentities } from "@/lib/db/index.js";
import { json, usableMethods } from "./usable.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const hidden = await requireMultiUser();
    if (hidden) return hidden;
    const principal = await getPrincipal();
    if (principal?.via !== "session") return json({ error: "Unauthorized" }, 401);

    const rows = await listIdentities(principal);
    const usable = await usableMethods(principal.userId);
    const usableSso = rows.filter((r) => usable.sso.has(r.provider));
    const identities = rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      issuer: r.issuer,
      emailAtLink: r.emailAtLink,
      createdAt: r.createdAt,
      lastLoginAt: r.lastLoginAt,
      // Unlinkable: an SSO row, and some other usable method would remain.
      unlinkable:
        r.provider !== "password" &&
        (usable.password || usableSso.some((other) => other.id !== r.id)),
    }));
    return json({ identities });
  } catch (error) {
    return json({ error: error.message }, 500);
  }
}
