// YAN-1912: key picker options for switch-off key budgets. The off-mode budget
// admin (owner/admin session, or login-off local access, see budgetsRepo
// offAccess) may already budget any key of the budget workspace, so listing
// those keys' ids and names grants nothing new. `/api/keys` keeps its own,
// narrower authority (session or CLI only). Projection is id + name + prefix;
// raw keys, hashes and key ids of other workspaces never leave.
import { getAdapter } from "../driver.js";
import { readApiKeyStorageState } from "../apiKeyState.js";
import { TenancyError } from "@/lib/users/errors.js";
import { isMultiUserEnabledSync } from "@/lib/users/featureSwitch.js";
import { assertBudgetActor, budgetWorkspaceAccess } from "./budgetsRepo.js";

/**
 * Keys a switch-off key budget can target: the budget workspace's live
 * (unrevoked) hashed keys, or every legacy key on a pristine install (legacy
 * keys are global and budgeted on `apiKeys.id`). Off mode only.
 * @returns {Promise<Array<{ id: string, name: string|null, prefix: string|null }>>}
 */
export async function listBudgetKeyOptions(ctx, { workspaceId } = {}) {
  if (ctx?.budgetMode !== "off") throw new TenancyError("FORBIDDEN", "Switch-off only");
  await assertBudgetActor(ctx);
  const db = await getAdapter();
  return db.transaction(() => {
    if (isMultiUserEnabledSync(db)) throw new TenancyError("FORBIDDEN", "Switch is on");
    const access = budgetWorkspaceAccess(db, ctx, { workspaceId }, { list: true });
    if (readApiKeyStorageState(db).storage !== "hashed")
      return db.all("SELECT id, name, NULL AS prefix FROM apiKeys ORDER BY createdAt ASC, id ASC");
    if (!access.workspaceId) return [];
    return db.all(
      `SELECT id, name, prefix FROM apiKeys WHERE workspaceId = ? AND revokedAt IS NULL
      ORDER BY createdAt ASC, id ASC`,
      [access.workspaceId],
    );
  });
}
