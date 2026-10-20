import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { getAdapter } from "@/lib/db/driver.js";
import { readApiKeyStorageState } from "@/lib/db/apiKeyState.js";
import { getEligibleApiKeySync } from "@/lib/db/repos/apiKeysRepo.js";
import { authorizeGatewayTarget } from "@/lib/auth/gatewayAuth.js";

// Live key eligibility + model scope, read straight from storage on every call
// (the principal snapshot is frozen at auth time; revocation is never memoized:
// the keyHash read and the ELIGIBLE join below run each time). Null for keyless
// principals (cli/local/mitm) and legacy null principals. A key principal on
// non-hashed or unreadable storage fails closed (403): the storage-state guard
// runs BEFORE any keyHash query (it is a write-invalidated marker read, not a
// revocation cache), and any read error lands in the catch, never a 500.
export async function revokedKeyTarget(principal, modelId) {
  if (!principal?.apiKeyId) return null;
  const deny = () => errorResponse(HTTP_STATUS.FORBIDDEN, "Forbidden");
  try {
    const db = await getAdapter();
    if (readApiKeyStorageState(db).storage !== "hashed") return deny();
    const hash = db.get("SELECT keyHash FROM apiKeys WHERE id = ?", [principal.apiKeyId])?.keyHash;
    const live = hash ? getEligibleApiKeySync(db, principal.apiKeyId, { keyHash: hash }) : null;
    if (!live) return deny();
    return authorizeGatewayTarget(
      {
        workspaceId: live.workspaceId,
        scopes: { allowedModels: live.allowedModels ?? [], allowedCombos: [] },
      },
      { modelId },
    );
  } catch {
    return deny();
  }
}
