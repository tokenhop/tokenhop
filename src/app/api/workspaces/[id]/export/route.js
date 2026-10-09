// YAN-375: encrypted per-workspace export. Hidden (404) while the switch is
// off. Browser session only; the acting user must be an ACTIVE member with the
// workspace OWNER role (not manager) and re-prove their own password. The URL
// id is authoritative; nothing role/actor-shaped is read from the body.
import { NextResponse } from "next/server";
import { audit } from "@/lib/users/audit.js";
import {
  WORKSPACE_EXPORT_MAX_BODY,
  exportWorkspaceSnapshot,
  transferFailure,
  workspaceFilename,
  workspaceTransferPrelude,
} from "@/lib/users/databaseTransfer.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request, route) {
  const pre = await workspaceTransferPrelude(request, route, {
    allowed: ["password", "passphrase"],
    maxBody: WORKSPACE_EXPORT_MAX_BODY,
    action: "workspace.export",
  });
  if (pre.res) return pre.res;
  const { principal, workspaceId, body } = pre;
  try {
    const payload = await exportWorkspaceSnapshot(principal, workspaceId, {
      passphrase: body.passphrase,
    });
    await audit({ principal, request, workspaceId }, "workspace.export", {
      type: "workspace",
      id: workspaceId,
    });
    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${workspaceFilename(workspaceId)}"`,
      },
    });
  } catch (err) {
    await audit(
      { principal, request, workspaceId },
      "workspace.export",
      { type: "workspace", id: workspaceId },
      { result: "failure", after: { reason: err?.code } },
    );
    return transferFailure(err);
  }
}
