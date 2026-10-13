import { NextResponse } from "next/server";
import { requireMultiUser } from "@/lib/users/featureSwitch.js";
import { authorize, getPrincipal } from "@/lib/users/session";
import { listUsersPageUnscoped } from "@/lib/db/repos/usersRepo.js";

const NO_STORE = { "Cache-Control": "no-store" };
const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export async function GET(request) {
  try {
    const hidden = await requireMultiUser();
    if (hidden) return hidden;
    const principal = await getPrincipal();
    // YAN-377: the owner CLI principal is admitted (owner proof via loopback token).
    if (
      principal?.via !== "session" &&
      !(principal?.via === "cli" && principal.instanceRole === "owner")
    )
      return json({ error: "Unauthorized" }, 401);
    const denied = await authorize("instance.users.manage");
    if (denied) return denied;

    const { searchParams } = new URL(request.url);
    return json(
      await listUsersPageUnscoped({
        page: searchParams.get("page"),
        pageSize: searchParams.get("pageSize"),
        search: searchParams.get("search"),
        role: searchParams.get("role"),
        status: searchParams.get("status"),
      }),
    );
  } catch (err) {
    if (err?.code === "INVALID") {
      return json({ error: "Invalid request", code: "invalid_request" }, 400);
    }
    return json({ error: "Internal error" }, 500);
  }
}
