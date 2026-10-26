import { getAdapter } from "../driver.js";
import { localDateKey, readApiKeyActivity } from "./usageRollupRepo.js";

/**
 * Per-client-API-key usage from usageRollup, keyed by key id (YAN-1242: rows
 * hold `apiKeyId`, never a raw key). `ctx` is the usage scope (null: all).
 * - lastUsed: most recent timestamp the key made a request (null when never used)
 * - today: requests today (local midnight)
 */
export async function getApiKeyUsage(ctx) {
  const db = await getAdapter();
  return readApiKeyActivity(ctx, db, localDateKey());
}
