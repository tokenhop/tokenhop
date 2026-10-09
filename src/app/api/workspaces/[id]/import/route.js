// YAN-375: per-workspace import of an encrypted snapshot. Same gate as export
// (switch on, session, workspace OWNER, own-password re-auth). The snapshot is
// passed to the core lane verbatim: ciphertext is never altered here.
import { NextResponse } from "next/server";
import { audit } from "@/lib/users/audit.js";
import {
  WORKSPACE_IMPORT_MAX_BODY,
  importWorkspaceSnapshot,
  isPassphraseFail,
  passphraseImportLock,
  recordPassphraseFail,
  transferFailure,
  workspaceTransferPrelude,
} from "@/lib/users/databaseTransfer.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request, route) {
  const pre = await workspaceTransferPrelude(request, route, {
    allowed: ["password", "passphrase", "data"],
    maxBody: WORKSPACE_IMPORT_MAX_BODY,
    requireData: true,
    action: "workspace.import",
  });
  if (pre.res) return pre.res;
  const { principal, workspaceId, body } = pre;
  const locked = passphraseImportLock(request);
  if (locked) return locked;
  try {
    await importWorkspaceSnapshot(principal, workspaceId, body.data, {
      passphrase: body.passphrase,
    });
    await audit({ principal, request, workspaceId }, "workspace.import", {
      type: "workspace",
      id: workspaceId,
    });
    return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    await audit(
      { principal, request, workspaceId },
      "workspace.import",
      { type: "workspace", id: workspaceId },
      { result: "failure", after: { reason: err?.code } },
    );
    if (isPassphraseFail(err)) recordPassphraseFail(request);
    return transferFailure(err);
  }
}
