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
    if (principal?.via !== "session") return json({ error: "Unauthorized" }, 401);
    const denied = await authorize("instance.users.manage");
    if (denied) return denied;

    const { searchParams } = new URL(request.url);
    return json(
      await listUsersPageUnscoped({
        page: searchParams.get("page"),
        pageSize: searchParams.get("pageSize"),
      }),
    );
  } catch {
    return json({ error: "Internal error" }, 500);
  }
}
