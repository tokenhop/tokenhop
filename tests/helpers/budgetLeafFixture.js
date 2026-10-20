// Shared fixtures for gateway chat tests that run a budgeted/hashed-key leaf:
// DB seeding (workspace w1, user u1, hashed key1, openai connection), a chat()
// request helper and budget helpers. vi.mock calls stay in each test file
// (they are file-scoped); this module only holds plain fixtures.
import crypto from "node:crypto";
import { insertHashedApiKeySync } from "@/lib/db/repos/apiKeysRepo.js";
import { clearApiKeyPrincipalCache } from "@/lib/auth/apiKeyPrincipal.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { bumpBudgetsGeneration } from "@/lib/users/budgets.js";
import { handleChat } from "@/sse/handlers/chat.js";

export const NOW = "2026-10-04T00:00:00.000Z";
export const MASTER = crypto.randomBytes(32);
export const KID = masterKeyId(MASTER);
export const TOKEN = `th_${"B".repeat(32)}`;

export const ok = () => ({
  response: new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  ),
  url: "https://fake.local/v1/chat/completions",
  headers: {},
  transformedBody: null,
});

export const chat = (model = "openai/gpt-4o", { token = TOKEN, headers = {} } = {}) =>
  handleChat(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    }),
  );

export const hashedKeysDdl = `CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    userId TEXT REFERENCES users(id) ON DELETE CASCADE,
    createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
    keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
    machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
    revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
    expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`;

export function hashedKeyRow(patch = {}) {
  return {
    id: "key1",
    workspaceId: "w1",
    userId: "u1",
    createdByUserId: "u1",
    keyHash: hashApiKey(TOKEN, deriveApiKeyHashKey(MASTER)),
    hashKid: KID,
    prefix: "th_BBBB…BBBB",
    name: "k",
    machineId: null,
    legacy: 0,
    isActive: 1,
    revokedAt: null,
    allowedModels: [],
    allowedCombos: [],
    expiresAt: null,
    lastUsedAt: null,
    createdAt: NOW,
    ...patch,
  };
}

// Per-test reset of the DB to: requireApiKey settings, workspace w1, user u1
// (member), hashed key1 and one openai connection. Call from beforeEach.
export function seedLeafDb(db) {
  process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
  process.env.TOKENHOP_PEER_TOKEN = "peer";
  clearApiKeyPrincipalCache();
  // An old settings row survives tests (INSERT OR REPLACE merges nothing).
  db.exec("DELETE FROM settings");
  db.run("INSERT INTO settings(id,data) VALUES (1, ?)", [JSON.stringify({ requireApiKey: true })]);
  db.exec("DROP TABLE apiKeys");
  db.exec(hashedKeysDdl);
  db.exec(
    "DELETE FROM budgets; DELETE FROM memberships; DELETE FROM workspaces; DELETE FROM users; DELETE FROM providerConnections; DELETE FROM combos; DELETE FROM workspaceSettings; DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid','defaultWorkspaceId')",
  );
  db.run(
    "INSERT INTO users(id, instanceRole, status, createdAt, updatedAt) VALUES ('u1', 'user', 'active', ?, ?)",
    [NOW, NOW],
  );
  db.run(
    "INSERT INTO workspaces(id,name,kind,createdAt,updatedAt) VALUES ('w1', 'w1', 'shared', ?, ?)",
    [NOW, NOW],
  );
  db.run(
    "INSERT INTO memberships(workspaceId,userId,role,createdAt) VALUES ('w1', 'u1', 'member', ?)",
    [NOW],
  );
  db.run("INSERT INTO _meta(key,value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)", [
    KID,
  ]);
  insertHashedApiKeySync(db, hashedKeyRow());
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, workspaceId, createdByUserId)
     VALUES('conn-w1', 'openai', 'apikey', 'c', NULL, 1, 1, ?, ?, ?, 'w1', NULL)`,
    [JSON.stringify({ apiKey: "sk-w1" }), NOW, NOW],
  );
  bumpBudgetsGeneration(); // budgets table wiped above: drop cached rows/holds
}

let seq = 0;
export function addBudget(db, scopeType, scopeId, limits) {
  db.run(
    `INSERT INTO budgets(id, workspaceId, scopeType, scopeId, window, limitUsd, limitTokens, limitRequests, softLimitPct, resetAt, createdByUserId, createdAt)
     VALUES(?, ?, ?, ?, 'day', ?, NULL, ?, NULL, NULL, NULL, ?)`,
    [
      `bl${++seq}`,
      scopeType === "user" ? null : "w1",
      scopeType,
      scopeId,
      limits.usd ?? null,
      limits.requests ?? null,
      NOW,
    ],
  );
  bumpBudgetsGeneration();
}

// Single workspace budget (replaces any previous rows).
export function setBudget(db, limits) {
  db.run("DELETE FROM budgets");
  addBudget(db, "workspace", "w1", limits);
}
