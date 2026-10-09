// Section metadata (column sets) + pure row validators for the YAN-375
// complete-table snapshot sections. Split from instanceSnapshotTables.js;
// see that file for the contract. No driver/barrel imports.

export function fail(code, message) {
  const error = new Error(message);
  error.name = "TransferError";
  error.code = code;
  throw error;
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function reqStr(row, field, table) {
  if (typeof row[field] !== "string" || !row[field]) {
    fail("TRANSFER_STATE_INVALID", `${table} entry misses ${field}`);
  }
  return row[field];
}

function optStr(row, field, table) {
  const value = row[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    fail("TRANSFER_STATE_INVALID", `${table} ${field} must be a string or null`);
  }
  return value;
}

function optRef(value, refSet, field, table, code) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !refSet.has(value)) {
    fail(code, `${table} ${field} references an unknown row`);
  }
  return value;
}

function optInt(row, field, table) {
  const value = row[field];
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value)) {
    fail("TRANSFER_STATE_INVALID", `${table} ${field} must be an integer or null`);
  }
  return value;
}

function optNum(row, field, table) {
  const value = row[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("TRANSFER_STATE_INVALID", `${table} ${field} must be a finite number or null`);
  }
  return value;
}

const BUDGET_SCOPE_TYPES = new Set(["key", "user", "membership", "workspace", "grant"]);
const BUDGET_WINDOWS = new Set(["day", "week", "month", "total"]);
const INVITATION_ROLES = new Set(["manager", "member", "viewer"]);

// Insert order (parents first, FK-safe under immediate constraint checking);
// delete order is the exact reverse.
export const SECTIONS = [
  {
    name: "workspaceSettings",
    columns: ["workspaceId", "data", "updatedAt"],
    validate(row, refs, seen) {
      const id = reqStr(row, "workspaceId", "workspaceSettings");
      optRef(id, refs.workspaces, "workspaceId", "workspaceSettings", "TRANSFER_REF_INVALID");
      if (typeof row.data !== "string") {
        fail("TRANSFER_STATE_INVALID", "workspaceSettings data must be a string");
      }
      optStr(row, "updatedAt", "workspaceSettings");
      if (seen.has(id)) fail("TRANSFER_STATE_INVALID", "duplicate workspaceSettings row");
      seen.add(id);
    },
  },
  {
    name: "userPreferences",
    columns: ["userId", "data", "updatedAt"],
    validate(row, refs, seen) {
      const id = reqStr(row, "userId", "userPreferences");
      optRef(id, refs.users, "userId", "userPreferences", "TRANSFER_REF_INVALID");
      if (typeof row.data !== "string") {
        fail("TRANSFER_STATE_INVALID", "userPreferences data must be a string");
      }
      optStr(row, "updatedAt", "userPreferences");
      if (seen.has(id)) fail("TRANSFER_STATE_INVALID", "duplicate userPreferences row");
      seen.add(id);
    },
  },
  {
    name: "budgets",
    columns: [
      "id",
      "workspaceId",
      "scopeType",
      "scopeId",
      "window",
      "limitUsd",
      "limitTokens",
      "limitRequests",
      "softLimitPct",
      "resetAt",
      "createdByUserId",
      "createdAt",
    ],
    validate(row, refs, seen) {
      const id = reqStr(row, "id", "budgets");
      const workspaceId = optRef(
        row.workspaceId,
        refs.workspaces,
        "workspaceId",
        "budgets",
        "TRANSFER_REF_INVALID",
      );
      if (!BUDGET_SCOPE_TYPES.has(row.scopeType)) {
        fail("TRANSFER_STATE_INVALID", "budgets entry has an invalid scopeType");
      }
      if (!BUDGET_WINDOWS.has(row.window)) {
        fail("TRANSFER_STATE_INVALID", "budgets entry has an invalid window");
      }
      reqStr(row, "scopeId", "budgets");
      reqStr(row, "createdAt", "budgets");
      optStr(row, "resetAt", "budgets");
      optRef(row.createdByUserId, refs.users, "createdByUserId", "budgets", "TRANSFER_REF_INVALID");
      const usd = optNum(row, "limitUsd", "budgets");
      if (usd !== null && usd < 0) {
        fail("TRANSFER_STATE_INVALID", "budgets limitUsd must be >= 0");
      }
      const tokens = optInt(row, "limitTokens", "budgets");
      const requests = optInt(row, "limitRequests", "budgets");
      if (tokens !== null && tokens < 0) {
        fail("TRANSFER_STATE_INVALID", "budgets limitTokens must be >= 0");
      }
      if (requests !== null && requests < 0) {
        fail("TRANSFER_STATE_INVALID", "budgets limitRequests must be >= 0");
      }
      if (usd === null && tokens === null && requests === null) {
        fail("TRANSFER_STATE_INVALID", "budgets entry needs at least one limit");
      }
      const soft = optInt(row, "softLimitPct", "budgets");
      if (soft !== null && (soft < 1 || soft > 100)) {
        fail("TRANSFER_STATE_INVALID", "budgets softLimitPct must be between 1 and 100");
      }
      if ((row.scopeType === "user") !== (workspaceId === null)) {
        fail("TRANSFER_STATE_INVALID", "user budgets must have no workspace; others must");
      }
      if (seen.has(id)) fail("TRANSFER_STATE_INVALID", "duplicate budgets row");
      seen.add(id);
    },
  },
  {
    name: "connectionGrants",
    columns: [
      "id",
      "connectionId",
      "workspaceId",
      "userId",
      "allowedModels",
      "rpm",
      "tpm",
      "budgetId",
      "createdByUserId",
      "tosAcknowledgedAt",
      "createdAt",
      "revokedAt",
    ],
    validate(row, refs, seen) {
      const id = reqStr(row, "id", "connectionGrants");
      const connectionId = reqStr(row, "connectionId", "connectionGrants");
      if (!refs.connectionsById.has(connectionId)) {
        fail("TRANSFER_REF_INVALID", "connectionGrants connectionId references an unknown row");
      }
      const workspaceId = optRef(
        row.workspaceId,
        refs.workspaces,
        "workspaceId",
        "connectionGrants",
        "TRANSFER_REF_INVALID",
      );
      const userId = optRef(
        row.userId,
        refs.users,
        "userId",
        "connectionGrants",
        "TRANSFER_REF_INVALID",
      );
      if ((workspaceId === null) === (userId === null)) {
        fail("TRANSFER_STATE_INVALID", "connectionGrants needs exactly one grantee of ws/user");
      }
      optStr(row, "allowedModels", "connectionGrants");
      optInt(row, "rpm", "connectionGrants");
      optInt(row, "tpm", "connectionGrants");
      optStr(row, "budgetId", "connectionGrants");
      optRef(
        row.createdByUserId,
        refs.users,
        "createdByUserId",
        "connectionGrants",
        "TRANSFER_REF_INVALID",
      );
      optInt(row, "tosAcknowledgedAt", "connectionGrants");
      optInt(row, "revokedAt", "connectionGrants");
      if (optInt(row, "createdAt", "connectionGrants") === null) {
        fail("TRANSFER_STATE_INVALID", "connectionGrants createdAt must be an integer");
      }
      if (seen.has(id)) fail("TRANSFER_STATE_INVALID", "duplicate connectionGrants row");
      seen.add(id);
    },
  },
  {
    name: "invitations",
    columns: [
      "id",
      "workspaceId",
      "role",
      "email",
      "tokenHash",
      "createdByUserId",
      "createdAt",
      "expiresAt",
      "consumedAt",
      "consumedByUserId",
      "revokedAt",
    ],
    validate(row, refs, seen) {
      const id = reqStr(row, "id", "invitations");
      optRef(
        reqStr(row, "workspaceId", "invitations"),
        refs.workspaces,
        "workspaceId",
        "invitations",
        "TRANSFER_REF_INVALID",
      );
      if (!INVITATION_ROLES.has(row.role)) {
        fail("TRANSFER_STATE_INVALID", "invitations entry has an invalid role");
      }
      const tokenHash = reqStr(row, "tokenHash", "invitations");
      reqStr(row, "createdAt", "invitations");
      reqStr(row, "expiresAt", "invitations");
      optStr(row, "email", "invitations");
      optStr(row, "consumedAt", "invitations");
      optStr(row, "revokedAt", "invitations");
      optRef(
        row.createdByUserId,
        refs.users,
        "createdByUserId",
        "invitations",
        "TRANSFER_REF_INVALID",
      );
      optRef(
        row.consumedByUserId,
        refs.users,
        "consumedByUserId",
        "invitations",
        "TRANSFER_REF_INVALID",
      );
      if (seen.has(tokenHash)) {
        fail("TRANSFER_STATE_INVALID", "duplicate invitations tokenHash in snapshot");
      }
      seen.add(tokenHash);
      if (seen.has(`id|${id}`)) fail("TRANSFER_STATE_INVALID", "duplicate invitations row");
      seen.add(`id|${id}`);
    },
  },
  {
    name: "auditEvents",
    columns: [
      "id",
      "ts",
      "actorUserId",
      "actorApiKeyId",
      "via",
      "ip",
      "workspaceId",
      "action",
      "targetType",
      "targetId",
      "before",
      "after",
      "result",
    ],
    validate(row, _refs, seen) {
      const id = reqStr(row, "id", "auditEvents");
      reqStr(row, "ts", "auditEvents");
      reqStr(row, "action", "auditEvents");
      for (const field of [
        "actorUserId",
        "actorApiKeyId",
        "via",
        "ip",
        "workspaceId",
        "targetType",
        "targetId",
        "before",
        "after",
        "result",
      ]) {
        optStr(row, field, "auditEvents");
      }
      if (seen.has(id)) fail("TRANSFER_STATE_INVALID", "duplicate auditEvents row");
      seen.add(id);
    },
  },
  {
    name: "usageHistory",
    columns: [
      "id",
      "timestamp",
      "provider",
      "model",
      "connectionId",
      "apiKey",
      "endpoint",
      "promptTokens",
      "completionTokens",
      "cost",
      "status",
      "tokens",
      "meta",
      "workspaceId",
      "userId",
      "apiKeyId",
      "grantId",
    ],
    validate(row, refs, seen) {
      const id = row.id;
      if (!Number.isInteger(id)) {
        fail("TRANSFER_STATE_INVALID", "usageHistory id must be an integer");
      }
      reqStr(row, "timestamp", "usageHistory");
      for (const field of [
        "provider",
        "model",
        "connectionId",
        "endpoint",
        "status",
        "tokens",
        "meta",
      ]) {
        optStr(row, field, "usageHistory");
      }
      // The historical raw slot was nulled by migration 014; a non-null value
      // would leak a plaintext gateway key into the snapshot.
      if (row.apiKey !== undefined && row.apiKey !== null) {
        fail("TRANSFER_RAW_LEAK", "usageHistory row carries a raw apiKey value; values withheld");
      }
      optNum(row, "cost", "usageHistory");
      optInt(row, "promptTokens", "usageHistory");
      optInt(row, "completionTokens", "usageHistory");
      optRef(
        row.workspaceId,
        refs.workspaces,
        "workspaceId",
        "usageHistory",
        "TRANSFER_REF_INVALID",
      );
      optRef(row.userId, refs.users, "userId", "usageHistory", "TRANSFER_REF_INVALID");
      optStr(row, "apiKeyId", "usageHistory");
      optStr(row, "grantId", "usageHistory");
      if (seen.has(id)) fail("TRANSFER_STATE_INVALID", "duplicate usageHistory row");
      seen.add(id);
    },
  },
  {
    name: "requestDetails",
    columns: [
      "id",
      "timestamp",
      "provider",
      "model",
      "connectionId",
      "status",
      "data",
      "workspaceId",
      "userId",
      "apiKeyId",
      "grantId",
    ],
    validate(row, refs, seen) {
      const id = reqStr(row, "id", "requestDetails");
      reqStr(row, "timestamp", "requestDetails");
      if (typeof row.data !== "string") {
        fail("TRANSFER_STATE_INVALID", "requestDetails data must be a string");
      }
      for (const field of ["provider", "model", "connectionId", "status", "apiKeyId", "grantId"]) {
        optStr(row, field, "requestDetails");
      }
      optRef(
        row.workspaceId,
        refs.workspaces,
        "workspaceId",
        "requestDetails",
        "TRANSFER_REF_INVALID",
      );
      optRef(row.userId, refs.users, "userId", "requestDetails", "TRANSFER_REF_INVALID");
      if (seen.has(id)) fail("TRANSFER_STATE_INVALID", "duplicate requestDetails row");
      seen.add(id);
    },
  },
  {
    name: "usageRollup",
    columns: [
      "dateKey",
      "workspaceId",
      "userId",
      "apiKeyId",
      "provider",
      "model",
      "connectionId",
      "endpoint",
      "requests",
      "tokensIn",
      "tokensOut",
      "tokensCached",
      "cost",
    ],
    validate(row, _refs, seen) {
      const dims = [];
      for (const field of [
        "dateKey",
        "workspaceId",
        "userId",
        "apiKeyId",
        "provider",
        "model",
        "connectionId",
        "endpoint",
      ]) {
        // Empty dimensions are valid schema defaults (unknown attribution).
        const value =
          field === "dateKey"
            ? reqStr(row, field, "usageRollup")
            : optStr(row, field, "usageRollup");
        if (value === null) fail("TRANSFER_STATE_INVALID", `usageRollup ${field} must be a string`);
        dims.push(value);
      }
      for (const field of ["requests", "tokensIn", "tokensOut", "tokensCached"]) {
        if (!Number.isInteger(row[field])) {
          fail("TRANSFER_STATE_INVALID", `usageRollup ${field} must be an integer`);
        }
      }
      const cost = optNum(row, "cost", "usageRollup");
      if (cost === null) {
        fail("TRANSFER_STATE_INVALID", "usageRollup cost must be a number");
      }
      const key = JSON.stringify(dims);
      if (seen.has(key)) fail("TRANSFER_STATE_INVALID", "duplicate usageRollup row");
      seen.add(key);
    },
  },
];
