// YAN-2019: revoke a usage hub management key. Takes effect on the next hub
// request (lookups skip revoked rows; nothing is cached).
import { json } from "@/lib/users/userManagement.js";
import { audit } from "@/lib/users/audit.js";
import { revokeHubKeyUnscoped } from "@/lib/db/repos/hubKeysRepo.js";
import { hubKeyGate, resyncPoller } from "@/lib/hub/hubKeyRoutes.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function DELETE(request, { params }) {
  const g = await hubKeyGate(request);
  if (g.res) return g.res;
  try {
    const { id } = await params;
    const revoked = await revokeHubKeyUnscoped(id);
    if (!revoked) return json({ error: "Not found", code: "not_found" }, 404);
    await audit(
      { principal: g.principal, request },
      "hubKey.revoke",
      { type: "hubKey", id: revoked.id },
      { before: { id: revoked.id, name: revoked.name, keyPrefix: revoked.prefix } },
    );
    resyncPoller();
    return json({ revoked: true });
  } catch {
    return json({ error: "Internal error" }, 500);
  }
}
