// Fold usageRollup rows onto rewritten dims (inside the caller's txn): owner
// adoption (YAN-370) rewrites workspace/user, a codex duplicate cleanup
// (YAN-1623) rewrites the connection. Rows that land on an existing key sum
// into it with the same merge as the live upsert in usageRollupRepo.js.
import { LATENCY_COLUMNS, LATENCY_MERGE_SQL } from "./usageLatencyRollup.js";
import { SAVINGS_COLUMNS, SAVINGS_MERGE_SQL } from "./usageSavingsRollup.js";

const DIMS = ["workspaceId", "userId", "apiKeyId", "provider", "model", "connectionId", "endpoint"];
const MEASURES = `requests, tokensIn, tokensOut, tokensCached, cost, ${LATENCY_COLUMNS.join(", ")}, ${SAVINGS_COLUMNS.join(", ")}, lastUsedAt`;

/**
 * INSERT…SELECT copying the rows matching `where` with some dims replaced by
 * SQL expressions. Bind order: the `dims` expressions' params in DIMS order,
 * then `where`'s. The caller deletes the source rows afterwards.
 * @param {string} where SQL predicate on the source rows
 * @param {Partial<Record<string, string>>} dims dim column → replacement SQL expression
 */
export function foldUsageRollupSql(where, dims) {
  return `INSERT INTO usageRollup (dateKey, ${DIMS.join(", ")}, ${MEASURES})
     SELECT dateKey, ${DIMS.map((d) => dims[d] ?? d).join(", ")}, ${MEASURES}
     FROM usageRollup WHERE ${where}
     ON CONFLICT (dateKey, ${DIMS.join(", ")}) DO UPDATE SET
       requests = requests + excluded.requests, tokensIn = tokensIn + excluded.tokensIn,
       tokensOut = tokensOut + excluded.tokensOut, tokensCached = tokensCached + excluded.tokensCached,
       cost = cost + excluded.cost, ${LATENCY_MERGE_SQL}, ${SAVINGS_MERGE_SQL},
       lastUsedAt = MAX(lastUsedAt, excluded.lastUsedAt)`;
}
