import { getAdapter } from "../driver.js";
import { scopeSql, whereAll } from "./usageRollupRepo.js";

/**
 * Per-client-API-key usage from usageHistory, keyed by key id (YAN-370: rows
 * hold `apiKeyId`, never a raw key). `ctx` is the usage scope (null: all).
 * - lastUsed: most recent timestamp the key made a request (null when never used)
 * - today: requests today (local midnight)
 */
export async function getApiKeyUsage(ctx) {
  const db = await getAdapter();
  const scope = scopeSql(ctx);
  const keyed = "apiKeyId IS NOT NULL AND apiKeyId != 'local-no-key'";
  const lastUsedRows = db.all(
    `SELECT apiKeyId, MAX(timestamp) AS lastUsed FROM usageHistory ${whereAll(scope.sql, keyed)} GROUP BY apiKeyId`,
    scope.params,
  );
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const todayRows = db.all(
    `SELECT apiKeyId, COUNT(*) AS n FROM usageHistory ${whereAll(scope.sql, keyed, "timestamp >= ?")} GROUP BY apiKeyId`,
    [...scope.params, startOfDay.toISOString()],
  );
  return {
    lastUsed: Object.fromEntries(lastUsedRows.map((r) => [r.apiKeyId, r.lastUsed])),
    today: Object.fromEntries(todayRows.map((r) => [r.apiKeyId, r.n])),
  };
}
