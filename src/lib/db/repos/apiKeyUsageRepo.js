import { getAdapter } from "../driver.js";

/**
 * Per-client-API-key usage from the usageHistory table.
 * Two maps, keyed by raw api key value:
 * - lastUsed: most recent timestamp the key made a request (null when never used)
 * - today: requests today (local midnight)
 */
export async function getApiKeyUsage() {
  const db = await getAdapter();
  const lastUsedRows = db.all(
    `SELECT apiKey, MAX(timestamp) AS lastUsed FROM usageHistory WHERE apiKey IS NOT NULL AND apiKey != '' GROUP BY apiKey`,
  );
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const todayRows = db.all(
    `SELECT apiKey, COUNT(*) AS n FROM usageHistory WHERE apiKey IS NOT NULL AND apiKey != '' AND timestamp >= ? GROUP BY apiKey`,
    [startOfDay.toISOString()],
  );
  return {
    lastUsed: Object.fromEntries(lastUsedRows.map((r) => [r.apiKey, r.lastUsed])),
    today: Object.fromEntries(todayRows.map((r) => [r.apiKey, r.n])),
  };
}
