// Shared fixtures for the YAN-1013 independent-oracle snapshot tests
// (snapshot-golden-order, snapshot-stage-sqljs). Nothing here imports the new
// snapshot writer/stager: table names and column order are hardcoded literals,
// and the typeof/quote dump reads the live schema, so the expectations do not
// come from the code under test.
import { Readable } from "node:stream";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { apiKeyPrefix } from "@/shared/utils/apiKey.js";

export const NOW = "2026-10-09T00:00:00.000Z";
export const MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));
export const KID = masterKeyId(MASTER);
export const WS = "ws-default";
export const WS2 = "ws-other";
const RAW_KEY = "th_ORACLEGATEWAYTOKENxxxxxxxxxxxxxxxx";

/** The 11 complete-table sections, parents first (FK-safe insert order). */
export const SECTION_TABLES = [
  "workspaceSettings",
  "userPreferences",
  "budgets",
  "connectionGrants",
  "invitations",
  "auditEvents",
  "usageHistory",
  "requestDetails",
  "usageRollup",
  "usageComboRollup",
  "usageBudgetCarry",
];

export function clearSections(db) {
  for (const table of [
    "usageBudgetCarry",
    "usageComboRollup",
    "usageRollup",
    "requestDetails",
    "usageHistory",
    "auditEvents",
    "invitations",
    "budgets",
    "connectionGrants",
    "userPreferences",
    "workspaceSettings",
  ]) {
    db.run(`DELETE FROM ${table}`);
  }
}

function rebuildApiKeysHashed(db) {
  db.exec("DROP TABLE IF EXISTS apiKeys");
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    userId TEXT REFERENCES users(id) ON DELETE CASCADE,
    createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
    keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
    machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
    revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
    expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
}

/**
 * A plain-hashed (format v2) identity graph with empty sections: users
 * owner/member1, workspaces WS/WS2, connection conn-1, gateway key hk-1.
 */
export function seedHashedGraph(db) {
  db.exec("DROP TABLE IF EXISTS gatewayVideoJobs");
  db.exec(`DELETE FROM workspaceKeys; DELETE FROM _meta WHERE key IN
    ('credentialsEncryptedVersion','credentialsKekKid','apiKeyHashKeyWrapped','credentialsCleanupPending','credentialsPendingRotation')`);
  clearSections(db);
  db.exec("DELETE FROM providerNodes; DELETE FROM providerConnections; DELETE FROM combos");
  rebuildApiKeysHashed(db);
  db.exec(
    `DELETE FROM memberships; DELETE FROM identities; DELETE FROM workspaces; DELETE FROM users;
     DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid','defaultWorkspaceId')`,
  );
  for (const id of ["owner", "member1"]) {
    db.run(
      `INSERT INTO users(id, email, username, displayName, instanceRole, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt, lastLoginAt)
       VALUES(?, ?, ?, ?, ?, 'active', ?, 0, 1, ?, ?, NULL)`,
      [id, `${id}@x.test`, id, id, id === "owner" ? "owner" : "user", "hashedsecret", NOW, NOW],
    );
  }
  for (const id of [WS, WS2]) {
    db.run(
      `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES(?, ?, 'shared', 'owner', ?, ?)`,
      [id, id, NOW, NOW],
    );
    db.run(
      `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?, 'owner', 'owner', 'manual', ?)`,
      [id, NOW],
    );
  }
  db.run(
    `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?, 'member1', 'member', 'manual', ?)`,
    [WS, NOW],
  );
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, workspaceId, createdByUserId)
     VALUES('conn-1', 'openai', 'api_key', 'Main', NULL, 1, 1, ?, ?, ?, ?, 'owner')`,
    [JSON.stringify({ accessToken: "sk-upstream-cred" }), NOW, NOW, WS],
  );
  db.run(
    `INSERT INTO apiKeys(id, workspaceId, userId, createdByUserId, keyHash, hashKid, prefix, name, machineId, legacy, isActive, allowedModels, createdAt)
     VALUES('hk-1', ?, 'member1', 'owner', ?, ?, ?, 'Runner', NULL, 0, 1, ?, ?)`,
    [
      WS,
      hashApiKey(RAW_KEY, deriveApiKeyHashKey(MASTER)),
      KID,
      apiKeyPrefix(RAW_KEY),
      JSON.stringify(["gpt-4o"]),
      NOW,
    ],
  );
  db.run(
    `INSERT INTO _meta(key, value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?), ('defaultWorkspaceId',?)`,
    [KID, WS],
  );
}

const HIST_OK = "[0,1,1,0,0,0,0,0,0,0,0,0]";
const HIST_ZERO = "[0,0,0,0,0,0,0,0,0,0,0,0]";
const UNICODE_JSON = '{"名前":"値","emoji":"🙂","q":"it\'s \\"x\\" \\\\ \\n","é":"e\\u0301"}';

/**
 * Snapshot rows for all 11 sections with the awkward values a bind path can get
 * wrong: integer-valued REALs (5.0), fractions (0.1), 2^53-1, empty strings,
 * NULLs, numeric-looking TEXT ("007", "1e3", "5.0", "0x10"), unicode, quotes,
 * and keys deliberately ABSENT (NULL / schema default at insert). Every row is
 * valid for the section validators and the live FK/CHECK constraints.
 */
export function trickySections() {
  const BIG = 9007199254740991;
  return {
    workspaceSettings: [
      { workspaceId: WS, data: UNICODE_JSON, updatedAt: "" },
      { workspaceId: WS2, data: "" }, // updatedAt absent -> NULL
    ],
    userPreferences: [
      { userId: "owner", data: "{}", updatedAt: null },
      { userId: "member1", data: "日本語🙂", updatedAt: "007" },
    ],
    budgets: [
      {
        id: "b-real-5",
        workspaceId: WS,
        scopeType: "workspace",
        scopeId: WS,
        window: "day",
        limitUsd: 5.0,
        limitTokens: null,
        limitRequests: null,
        softLimitPct: null,
        resetAt: "",
        createdByUserId: "owner",
        createdAt: NOW,
      },
      {
        id: "b-real-0.1",
        workspaceId: WS,
        scopeType: "key",
        scopeId: "hk-1",
        window: "week",
        limitUsd: 0.1,
        limitTokens: BIG,
        limitRequests: 0,
        softLimitPct: 100,
        resetAt: "2026-01-01T00:00:00.000Z",
        createdByUserId: null,
        createdAt: "1e3",
      },
      {
        id: "b-user",
        workspaceId: null,
        scopeType: "user",
        scopeId: "owner",
        window: "total",
        limitTokens: 1,
        softLimitPct: 1,
        createdAt: "5.0",
      },
      {
        id: "b-frac",
        workspaceId: WS,
        scopeType: "membership",
        scopeId: `${WS}:member1`,
        window: "month",
        limitUsd: 123456789.12345679,
        createdAt: NOW,
      },
    ],
    connectionGrants: [
      {
        id: "g-ws",
        connectionId: "conn-1",
        workspaceId: WS2,
        userId: null,
        allowedModels: "",
        rpm: 60,
        tpm: BIG,
        budgetId: "",
        createdByUserId: "owner",
        tosAcknowledgedAt: null,
        createdAt: 1791504000000,
        revokedAt: null,
      },
      {
        id: "g-user",
        connectionId: "conn-1",
        userId: "member1", // workspaceId absent -> NULL
        allowedModels: '["gpt-4o","日本語"]',
        rpm: 0,
        createdAt: 0,
        tosAcknowledgedAt: 1791504000001,
        revokedAt: 1791504000002,
      },
    ],
    invitations: [
      {
        id: "inv-1",
        workspaceId: WS,
        role: "member",
        email: "",
        tokenHash: "0".repeat(64),
        createdByUserId: "owner",
        createdAt: NOW,
        expiresAt: NOW,
        consumedAt: null,
        consumedByUserId: null,
        revokedAt: "",
      },
      {
        id: "inv-2",
        workspaceId: WS2,
        role: "viewer",
        email: "用户@例え.テスト🙂",
        tokenHash: "1".repeat(64),
        createdAt: "007",
        expiresAt: "5.0",
      },
      {
        id: "inv-3",
        workspaceId: WS,
        role: "manager",
        tokenHash: "2".repeat(64),
        createdByUserId: null,
        createdAt: NOW,
        expiresAt: NOW,
        consumedAt: NOW,
        consumedByUserId: "member1",
      },
    ],
    auditEvents: [
      {
        id: "a1",
        ts: NOW,
        actorUserId: "owner",
        actorApiKeyId: null,
        via: "",
        ip: "::1",
        workspaceId: WS,
        action: "x.poke",
        targetType: "t",
        targetId: "0x10",
        before: "",
        after: UNICODE_JSON,
        result: "ok",
      },
      { id: "a2", ts: "1e3", action: "é" },
    ],
    usageHistory: [
      {
        id: 1,
        timestamp: NOW,
        provider: "openai",
        model: "gpt-4o",
        connectionId: "conn-1",
        apiKey: null,
        endpoint: "/v1/chat",
        promptTokens: BIG,
        completionTokens: 0,
        cost: 5.0,
        status: "",
        tokens: UNICODE_JSON,
        meta: "{}",
        workspaceId: WS,
        userId: "owner",
        apiKeyId: "hk-1",
        grantId: "g-user",
      },
      { id: 2, timestamp: "x", cost: 0.1, promptTokens: -5 },
      { id: 3, timestamp: NOW, cost: 424242.5, promptTokens: 0, completionTokens: -BIG },
      { id: 4, timestamp: NOW, cost: Number.MAX_VALUE, promptTokens: BIG, status: "1e3" },
      { id: 9007199254740000, timestamp: NOW, cost: 123.456, completionTokens: 7, status: "007" },
    ],
    requestDetails: [
      {
        id: "rd-1",
        timestamp: NOW,
        provider: "openai",
        model: "gpt-4o",
        connectionId: "conn-1",
        status: "",
        data: '{"日本":"🙂","n":5.0,"big":9007199254740993}',
        workspaceId: WS,
        userId: "owner",
        apiKeyId: "hk-1",
        grantId: "g-user",
      },
      { id: "rd-2", timestamp: "007", data: "" },
    ],
    usageRollup: [
      {
        dateKey: "2026-10-09",
        workspaceId: WS,
        userId: "owner",
        apiKeyId: "hk-1",
        provider: "openai",
        model: "gpt-4o",
        connectionId: "conn-1",
        endpoint: "/v1/chat",
        requests: BIG,
        tokensIn: 10,
        tokensOut: 20,
        tokensCached: 0,
        cost: 0.1,
        latencySumMs: 12.5,
        latencyCount: 2,
        emptyCount: 1,
        latencyRequests: 3,
        latencyHistogram: HIST_OK,
        savingsSavedEst: 120.5,
        savingsBeforeEst: -7.25,
        savingsRequests: 2,
        rtkSavedEst: 100.5,
        rtkBeforeEst: 150,
        rtkRequests: 2,
        lastUsedAt: NOW,
      },
      // All five latency columns ABSENT: the insert must apply schema defaults.
      {
        dateKey: "2026-10-10",
        workspaceId: "",
        userId: "",
        apiKeyId: "",
        provider: "",
        model: "",
        connectionId: "",
        endpoint: "",
        requests: 0,
        tokensIn: 0,
        tokensOut: 0,
        tokensCached: 0,
        cost: 5.0,
      },
      // Only latencySumMs present (integer-valued REAL).
      {
        dateKey: "2026-10-11",
        workspaceId: "",
        userId: "",
        apiKeyId: "k",
        provider: "",
        model: "",
        connectionId: "",
        endpoint: "",
        requests: 1,
        tokensIn: 1,
        tokensOut: 1,
        tokensCached: 1,
        cost: 1e-7,
        latencySumMs: 7.0,
      },
      {
        dateKey: "2026-10-12",
        workspaceId: "",
        userId: "",
        apiKeyId: "k",
        provider: "",
        model: "",
        connectionId: "",
        endpoint: "",
        requests: 5,
        tokensIn: 0,
        tokensOut: 0,
        tokensCached: 0,
        cost: 0,
        latencyCount: 0,
        emptyCount: 5,
        latencyRequests: 5,
        latencyHistogram: HIST_ZERO,
      },
    ],
    // YAN-1226: every column is required by the validator (no absent keys).
    usageComboRollup: [
      {
        dateKey: "2026-10-09",
        workspaceId: WS,
        userId: "owner",
        apiKeyId: "hk-1",
        comboName: "combo '🙂' \"quoted\"",
        requests: 4,
      },
      {
        dateKey: "2026-10-10",
        workspaceId: "",
        userId: "",
        apiKeyId: "local-no-key",
        comboName: "x".repeat(128),
        requests: 1,
      },
    ],
    // YAN-424: every column is required by the validator (no absent keys).
    usageBudgetCarry: [
      {
        day: "2026-10-09",
        workspaceId: WS,
        userId: "owner",
        apiKeyId: "hk-1",
        grantId: "g-user",
        usd: 5.0,
        tokens: BIG,
        requests: 0,
        notionalUsd: 0.1,
      },
      {
        day: "2026-10-10",
        workspaceId: "",
        userId: "",
        apiKeyId: "密钥🙂'q",
        grantId: "",
        usd: 0,
        tokens: 7,
        requests: 3,
        notionalUsd: 123456789.12345679,
      },
    ],
  };
}

/**
 * Exact stored-value dump of the 11 section tables: for every live column the
 * SQLite storage class and `quote()` text, in rowid order. `typeof/quote`
 * distinguishes 5 from 5.0 and '5' from 5, which JS equality cannot.
 */
export function dumpSections(db) {
  const out = {};
  for (const table of SECTION_TABLES) {
    const cols = db.all(`PRAGMA table_info(${table})`).map((r) => r.name);
    const select = cols.map((c, i) => `typeof("${c}") AS t${i}, quote("${c}") AS q${i}`).join(", ");
    out[table] = db
      .all(`SELECT ${select} FROM ${table} ORDER BY rowid`)
      .map((row) => Object.fromEntries(cols.map((c, i) => [c, `${row[`t${i}`]}:${row[`q${i}`]}`])));
  }
  return out;
}

/** Whole-instance state used to prove "unchanged" after a rejected import. */
export function stateDump(db) {
  const others = [
    "users",
    "identities",
    "workspaces",
    "memberships",
    "providerConnections",
    "providerNodes",
    "apiKeys",
    "combos",
    "kv",
  ].map((t) => [t, db.all(`SELECT * FROM ${t} ORDER BY rowid`)]);
  return JSON.stringify({
    sections: dumpSections(db),
    others,
    meta: db.all("SELECT * FROM _meta ORDER BY key"),
  });
}

/** Insert section rows through the ORIGINAL pre-YAN-1013 bind path (the oracle). */
export function insertViaOracle(db, insertInstanceTableSections, sections) {
  db.transaction(() => insertInstanceTableSections(db, structuredClone(sections)));
}

/** A request-body-like async iterable of `chunk`-sized Buffers of the compact JSON. */
export function bodyOf(doc, chunk = 4096) {
  const bytes = Buffer.from(JSON.stringify(doc), "utf8");
  const parts = [];
  for (let i = 0; i < bytes.length; i += chunk) parts.push(bytes.subarray(i, i + chunk));
  return Readable.from(parts);
}
