import { v4 as uuidv4 } from "uuid";
import { decodeJwtPayload } from "open-sse/utils/jwt.js";
import { hasCoveredSecret, provisionConnectionCreateDekSync } from "./credentialStorage.js";
import {
  codexAccountIdOf,
  isDeadCodexRow,
  matchesConnectionIdentity,
  matchesFlaggedReplacement,
} from "./connectionIdentity.js";
import { absorbCodexDuplicatesInTx } from "./codexDuplicateMerge.js";
import { TABLE, connToRow, reorderInTx, rowToConn, upsert } from "./connectionRows.js";
import {
  applyPsdDelta,
  clearReauthOnCredentialReplace,
  deriveConnectionName,
  mergeReloginProviderData,
  resetHealthStateOnActivation,
} from "./connectionPatch.js";

// In-transaction connection writes: every function here must run INSIDE the
// caller's db.transaction (the repo facades own the transaction boundaries).
const OPTIONAL_FIELDS = [
  "displayName",
  "email",
  "globalPriority",
  "defaultModel",
  "accessToken",
  "refreshToken",
  "expiresAt",
  "tokenType",
  "scope",
  "projectId",
  "apiKey",
  "testStatus",
  "lastTested",
  "lastError",
  "lastErrorAt",
  "rateLimitedUntil",
  "expiresIn",
  "errorCode",
  "consecutiveUseCount",
  "idToken",
  "lastRefreshAt",
];

// YAN-1055: provision a fresh DEK for a genuinely keyless workspace right
// before sealing a secret-bearing connection inside createInTx (never on
// updateConnection or other runtime writes).
function provisionForCreateIfNeeded(db, target, workspaceId, ctx) {
  if (ctx.encrypted && workspaceId && hasCoveredSecret(connToRow(target).data, TABLE)) {
    provisionConnectionCreateDekSync(db, workspaceId, ctx);
  }
}

// Dedup and priority partition by workspace: the same account in two
// workspaces is two rows, never a merge (YAN-361).
// `removed` (optional) collects the flagged duplicates a codex merge deleted
// (YAN-1623), so the scoped caller can audit them after the transaction.
export function createInTx(
  db,
  data,
  { rejectDuplicateName = false } = {},
  owner = {},
  ctx,
  removed,
) {
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const workspaceId = owner.workspaceId ?? null;
  // Dedup sees decrypted identity metadata (email, username, account ids).
  const all = db
    .all(`SELECT * FROM providerConnections WHERE provider = ? AND workspaceId IS ?`, [
      data.provider,
      workspaceId,
    ])
    .map((row) => rowToConn(db, row, ctx));

  // Identity rules live in matchesConnectionIdentity (shared with the move planner).
  // access_token: never dedup — user manages duplicates manually. YAN-1287: a
  // flagged (dead) codex row is also replaceable by a fresh grant of the same
  // account, so a reconnect/re-import leaves no stale flagged row behind.
  // YAN-1623: installs hit by the pre-YAN-1287 bug can hold several such rows
  // (or one beside the live row); the merge below keeps one and removes the
  // other flagged matches, so the reconnect leaves exactly one row.
  // F2: the flagged fallback never crosses creators — B's import of the same
  // account must not rewrite or remove A's row (same guard shape as workspace scoping).
  const sameCreator = (c) =>
    !owner.createdByUserId || !c.createdByUserId || c.createdByUserId === owner.createdByUserId;
  const incomingAccountId = data.provider === "codex" ? codexAccountIdOf(data) : null;
  const replaceable = (c) =>
    sameCreator(c) &&
    matchesFlaggedReplacement(c, data, nowMs) &&
    // Never replace a row proven to belong to another ChatGPT account.
    (!incomingAccountId || !codexAccountIdOf(c) || codexAccountIdOf(c) === incomingAccountId);
  // Prefer the flagged row proven to be the incoming account, then the newest.
  const pickReplaceable = () => {
    const rank = (c) => (incomingAccountId && codexAccountIdOf(c) === incomingAccountId ? 1 : 0);
    const updated = (c) => new Date(c.updatedAt ?? 0).getTime() || 0;
    return all.filter(replaceable).sort((a, b) => rank(b) - rank(a) || updated(b) - updated(a))[0];
  };
  // Codex: prefer a live identity match over a dead one; the dead same-account
  // row then becomes a loser and is absorbed below.
  const identityMatches = all.filter((c) => matchesConnectionIdentity(c, data));
  const identityMatch =
    data.provider === "codex"
      ? (identityMatches.find((c) => !isDeadCodexRow(c, nowMs)) ?? identityMatches[0])
      : identityMatches[0];
  const existing = identityMatch ?? (data.provider === "codex" ? pickReplaceable() : undefined);
  if (existing && rejectDuplicateName && data.authType === "apikey") {
    const err = new Error(`A connection named "${data.name}" already exists for this provider`);
    err.code = "DUPLICATE_CONNECTION_NAME";
    throw err;
  }

  if (existing) {
    const viaFlaggedFallback = !matchesConnectionIdentity(existing, data);
    const normalized = clearReauthOnCredentialReplace(
      existing,
      resetHealthStateOnActivation(existing, data),
    );
    const merged = { ...existing, ...normalized, updatedAt: now };
    if (viaFlaggedFallback) {
      // A reconnect/re-import shouldn't rename the row.
      if (existing.name && !data.name) merged.name = existing.name;
      // A replaced access_token must not keep the old row's expiry. Reads the
      // JWT exp via the dependency-free jwt helper (tokenLifetime would pull
      // the provider registry into this repo's cold-start path).
      if (data.authType === "access_token" && data.expiresAt === undefined) {
        const exp = Number(decodeJwtPayload(data.accessToken)?.exp);
        merged.expiresAt =
          Number.isFinite(exp) && exp > 0 ? new Date(exp * 1000).toISOString() : null;
        merged.tokenExpiresAt = null;
      }
    }
    if (data.authType === "oauth") {
      const providerSpecificData = mergeReloginProviderData(
        existing.providerSpecificData,
        data.providerSpecificData,
        data.provider,
      );
      if (providerSpecificData) merged.providerSpecificData = providerSpecificData;
    } else {
      applyPsdDelta(merged, existing, normalized);
    }
    provisionForCreateIfNeeded(db, merged, workspaceId, ctx);
    upsert(db, merged, ctx);
    if (
      data.provider === "codex" &&
      absorbCodexDuplicatesInTx(db, { all, data, existing, nowMs, sameCreator, removed })
    ) {
      reorderInTx(db, data.provider, workspaceId);
    }
    return merged;
  }

  let connectionName = data.name || null;
  if (!connectionName && (data.authType === "oauth" || data.authType === "access_token")) {
    const fallback =
      data.email ||
      (data.authType === "access_token" && data.provider === "codex"
        ? "ChatGPT Access token"
        : `Account ${all.length + 1}`);
    connectionName = deriveConnectionName(data, fallback);
  }
  let connectionPriority = data.priority;
  if (!connectionPriority) {
    connectionPriority = all.reduce((m, c) => Math.max(m, c.priority || 0), 0) + 1;
  }

  const conn = {
    id: uuidv4(),
    provider: data.provider,
    authType: data.authType || "oauth",
    name: connectionName,
    priority: connectionPriority,
    isActive: data.isActive !== undefined ? data.isActive : true,
    createdAt: now,
    updatedAt: now,
    // Owner fields only once set: switch-off responses keep today's shape.
    ...(workspaceId ? { workspaceId } : {}),
    ...(owner.createdByUserId ? { createdByUserId: owner.createdByUserId } : {}),
  };
  for (const f of OPTIONAL_FIELDS) {
    if (data[f] !== undefined && data[f] !== null) conn[f] = data[f];
  }
  if (data.providerSpecificData && Object.keys(data.providerSpecificData).length > 0) {
    conn.providerSpecificData = data.providerSpecificData;
  }
  if (data.email !== undefined) conn.email = data.email;

  provisionForCreateIfNeeded(db, conn, workspaceId, ctx);
  upsert(db, conn, ctx);
  reorderInTx(db, data.provider, workspaceId);
  return conn;
}

// Ownership is immutable here: moves between workspaces are YAN-701. The
// current row is decrypted inside the transaction, the plaintext patch merged
// on top (workspaceId always the stored SQL value), then re-encrypted.
export function updateInTx(db, row, data, ctx) {
  if (!row) return null;
  const existing = rowToConn(db, row, ctx);
  const { workspaceId: _ws, createdByUserId: _by, ...patch } = data || {};
  const normalized = clearReauthOnCredentialReplace(
    existing,
    resetHealthStateOnActivation(existing, patch),
  );
  const merged = { ...existing, ...normalized, updatedAt: new Date().toISOString() };
  applyPsdDelta(merged, existing, normalized);
  upsert(db, merged, ctx);
  if (patch.priority !== undefined) reorderInTx(db, existing.provider, row.workspaceId);
  return merged;
}

export function deleteInTx(db, row) {
  if (!row) return false;
  db.run(`DELETE FROM providerConnections WHERE id = ?`, [row.id]);
  reorderInTx(db, row.provider, row.workspaceId);
  return true;
}
