import { NextResponse } from "next/server";
import { requireMultiUser } from "@/lib/users/featureSwitch.js";
import { authorize, getPrincipal } from "@/lib/users/session";
import { listSharedWorkspacesWithMemberCountsUnscoped } from "@/lib/db/repos/workspacesRepo.js";

const NO_STORE = { "Cache-Control": "no-store" };
const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export async function GET() {
  try {
    const hidden = await requireMultiUser();
    if (hidden) return hidden;
    const principal = await getPrincipal();
    if (principal?.via !== "session") return json({ error: "Unauthorized" }, 401);
    const denied = await authorize("instance.users.manage");
    if (denied) return denied;

    return json({ workspaces: await listSharedWorkspacesWithMemberCountsUnscoped() });
  } catch {
    return json({ error: "Internal error" }, 500);
  }
}
