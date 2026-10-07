// YAN-369: revoke a connection grant. DELETE only; hidden (404) while the
// multi-user switch is off. Full browser session only. The connection URL id
// is authoritative: the grant must belong to it. connectionGrantsRepo
// re-checks live manager authority in its transaction (foreign or unmanaged
// grants read as not found) and writes the connectionGrant.revoke audit row —
// none here. No grant cache: revocation is effective on the next gateway
// request. The response is grant metadata only.
import { json } from "@/lib/users/userManagement.js";
import { requireMultiUser } from "@/lib/users/featureSwitch.js";
import { getPrincipal } from "@/lib/users/session.js";
import { isCrossSite } from "@/lib/auth/sameOrigin.js";
import { getGrantById, revokeGrant } from "@/lib/db/repos/connectionGrantsRepo.js";
import { TenancyError } from "@/lib/users/errors.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const ERRORS = {
  NOT_FOUND: [404, "Grant not found"],
  FORBIDDEN: [403, "Forbidden"],
  INVALID: [400, "Invalid request"],
};

function fail(err) {
  const hit = ERRORS[err?.code];
  if (hit) return json({ error: hit[1], code: err.code.toLowerCase() }, hit[0]);
  return json({ error: "Internal error" }, 500);
}

export async function DELETE(request, { params }) {
  const hidden = await requireMultiUser();
  if (hidden) return hidden;
  if (isCrossSite(request)) return json({ error: "Forbidden", code: "forbidden_origin" }, 403);
  try {
    const principal = await getPrincipal();
    if (principal?.via !== "session") return json({ error: "Unauthorized" }, 401);
    const { id, grantId } = await params;
    const existing = await getGrantById(principal, grantId);
    if (!existing || existing.connectionId !== id) throw new TenancyError("NOT_FOUND");
    return json({ grant: await revokeGrant(principal, grantId) });
  } catch (err) {
    return fail(err);
  }
}
