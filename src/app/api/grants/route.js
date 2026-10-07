// YAN-369: the grantee's incoming grants — active grants whose grantee is any
// workspace the caller belongs to or the caller's own user id. Hidden (404)
// while the multi-user switch is off; browser session only (self.session, the
// least-privileged existing capability: any authenticated user may see what
// was shared with them). The response is a fixed metadata field list
// (grantId, provider, connection name, allowedModels) — never credential
// data, tokens, email or owner identity; the gateway reader joins the raw
// connection row but only these fields cross this boundary.
import { json } from "@/lib/users/userManagement.js";
import { requireMultiUser } from "@/lib/users/featureSwitch.js";
import { getPrincipal } from "@/lib/users/session.js";
import { isCrossSite } from "@/lib/auth/sameOrigin.js";
import { getAdapter } from "@/lib/db/driver.js";
import { listActiveGrantsForPrincipal } from "@/lib/db/repos/connectionGrantsRepo.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function toIncoming(g) {
  return {
    grantId: g.grantId,
    provider: g.connection.provider,
    name: g.connection.name,
    allowedModels: g.allowedModels,
  };
}

export async function GET(request) {
  const hidden = await requireMultiUser();
  if (hidden) return hidden;
  if (isCrossSite(request)) return json({ error: "Forbidden", code: "forbidden_origin" }, 403);
  try {
    const principal = await getPrincipal();
    if (principal?.via !== "session") return json({ error: "Unauthorized" }, 401);
    const db = await getAdapter();
    const rows = [
      // Membership-derived workspace grants, then user-targeted grants.
      ...principal.workspaceIds.flatMap((workspaceId) =>
        listActiveGrantsForPrincipal(db, { workspaceId }),
      ),
      ...listActiveGrantsForPrincipal(db, { userId: principal.userId }),
    ];
    return json({ grants: rows.map(toIncoming) });
  } catch {
    return json({ error: "Internal error" }, 500);
  }
}
