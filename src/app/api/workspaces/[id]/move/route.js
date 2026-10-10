// YAN-701: move items (connections, nodes, combos, aliases, custom/disabled
// models, API keys) from this workspace to another one the actor manages.
// Browser session only (no admin bypass): the core re-reads live authority for
// every item type in BOTH workspaces inside the move transaction. Hidden (404)
// while the multi-user switch is off. Fixed error codes only — repo internals
// and secrets never reach the response.
import {
  json,
  PayloadTooLarge,
  readJsonBody,
  requireManagedSession,
} from "@/lib/users/userManagement.js";
import { moveWorkspaceItems, planWorkspaceMove } from "@/lib/users/workspaceMove.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MAX_BODY = 64 * 1024;
const CAPABILITY = "workspace.connections.manage";
const KEYS = ["targetWorkspaceId", "items", "preview", "confirm"];

function fail(err) {
  if (err instanceof PayloadTooLarge) {
    return json({ error: err.message, code: err.code }, err.status);
  }
  if (err?.code === "MOVE_CONFLICT") {
    return json(
      { error: "Move has conflicts", code: "move_conflict", conflicts: err.conflicts },
      409,
    );
  }
  if (err?.code === "CONFIRM_REQUIRED") {
    return json(
      { error: "Move needs confirmation", code: "confirm_required", warnings: err.warnings },
      409,
    );
  }
  const ERRORS = {
    INVALID: [400, "Invalid request"],
    NOT_FOUND: [404, "Workspace not found"],
    FORBIDDEN: [403, "Forbidden"],
    // Credential-key failures: typed, no internal detail (rotate routes precedent).
    KEY_MISSING: [503, "The credential root key is unavailable", "key_missing"],
    KEY_MISMATCH: [503, "The credential root key does not match this instance", "key_mismatch"],
    // loadMasterKey: invalid/foreign root; marker unreadable (rotate-route precedent).
    MASTER_KEY_INVALID: [503, "The credential root key is unavailable", "key_missing"],
    CREDENTIAL_STATE_INVALID: [503, "Credential encryption state is unavailable", "state_invalid"],
    CREDENTIAL_MAINTENANCE_POISONED: [409, "Credential maintenance is locked", "locked"],
    // Stored-row integrity failures (tampered or wrong coordinates): not retryable.
    PLAINTEXT_REJECTED: [409, "Stored credential could not be re-sealed", "plaintext_rejected"],
    DECRYPT_FAILED: [409, "Stored credential could not be decrypted", "decrypt_failed"],
  };
  const hit = ERRORS[err?.code];
  if (hit) return json({ error: hit[1], code: hit[2] ?? err.code.toLowerCase() }, hit[0]);
  return json({ error: "Internal error" }, 500);
}

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const { res, principal } = await requireManagedSession(request, {
      capability: CAPABILITY,
      workspaceId: id,
      body: true,
    });
    if (res) return res;
    const body = await readJsonBody(request, { max: MAX_BODY });
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((k) => !KEYS.includes(k)) ||
      (body.preview !== undefined && typeof body.preview !== "boolean") ||
      (body.confirm !== undefined && typeof body.confirm !== "boolean")
    ) {
      return fail({ code: "INVALID" });
    }
    // Item/id shape, size and duplicate checks live in the core validator.
    const input = {
      sourceWorkspaceId: id,
      targetWorkspaceId: body.targetWorkspaceId,
      items: body.items,
    };
    const out =
      body.preview === true
        ? await planWorkspaceMove(principal, input)
        : await moveWorkspaceItems(principal, { ...input, confirm: body.confirm === true });
    return json(out);
  } catch (err) {
    return fail(err);
  }
}
