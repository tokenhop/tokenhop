// YAN-378 shared DB-backed two-workspace fixture for gateway isolation tests.
// Two workspaces (wA, wB) each with a hashed key; wB also owns one anthropic
// connection; wA seeds a connection, node, combo, alias, custom and disabled
// models that only wA's key may resolve. Per-file seam mocks (executor, fetch,
// logger, usage-log writes) stay in the test files: vi.mock is file-scoped.
import crypto from "node:crypto";
import { getAdapter } from "@/lib/db/driver.js";
import { insertHashedApiKeySync } from "@/lib/db/repos/apiKeysRepo.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { clearApiKeyPrincipalCache } from "@/lib/auth/apiKeyPrincipal.js";
import { membershipScopeId, bumpBudgetsGeneration } from "@/lib/users/budgets.js";
import { initGatewayVideoJobsSync } from "@/lib/db/repos/gatewayVideoJobsRepo.js";

export const NOW = "2026-10-04T00:00:00.000Z";
export const ENV_MU = "TOKENHOP_MULTI_USER";

const MASTER = crypto.randomBytes(32);
const KID = masterKeyId(MASTER);
const digest = (raw) => hashApiKey(raw, deriveApiKeyHashKey(MASTER));

export const TOKEN_A = `th_${"A".repeat(32)}`;
export const TOKEN_B = `th_${"B".repeat(32)}`;

// Clock-relative past instant (never a fixed date that could become "future").
export const past = () => new Date(Date.now() - 1000).toISOString();

export const req = (url, key = TOKEN_B) =>
  new Request(url, { headers: { authorization: `Bearer ${key}` } });

export const post = (url, body, key = TOKEN_B) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "", ...body }),
  });

export const okUpstream = () => ({
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

/** Undo the env the test file's hoisted block changed at import time. */
export function restoreEnv(savedEnv) {
  for (const key of [ENV_MU, "TOKENHOP_MASTER_KEY"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

/**
 * Secret sentinel scan for observed response payloads: no wA/wB credential
 * material or node URL may ever appear in a gateway response body. Plain
 * function — no prototype/global patching.
 */
export function assertNoSecrets(value, extra = []) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const markers = ["sk-conn-a", "sk-conn-a-node", "sk-conn-b", "w1-node.test", ...extra];
  const hit = markers.find((marker) => text.includes(marker));
  if (hit) throw new Error(`response leaked secret marker: ${hit}`);
}

/** Scan cloned JSON/text responses without consuming the caller's body. */
export async function observeResponse(response) {
  assertNoSecrets(await response.clone().text(), [TOKEN_A, TOKEN_B]);
  return response;
}

function hashedKeyRow(id, workspaceId, token, patch = {}) {
  return {
    id,
    workspaceId,
    userId: `u${workspaceId.slice(1)}`,
    createdByUserId: `u${workspaceId.slice(1)}`,
    keyHash: digest(token),
    hashKid: KID,
    prefix: `th_${token.slice(3, 7)}…${token.slice(-4)}`,
    name: `${id} key`,
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

/** Wipe and seed the file-isolated DB; returns the world handle. */
export async function seedGatewayWorld() {
  process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
  clearApiKeyPrincipalCache();
  const db = await getAdapter();
  db.run("INSERT OR REPLACE INTO settings(id,data) VALUES (1, ?)", [
    JSON.stringify({ requireApiKey: true }),
  ]);
  initGatewayVideoJobsSync(db);
  db.run("DELETE FROM gatewayVideoJobs");
  db.exec("DROP TABLE IF EXISTS apiKeys");
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    userId TEXT REFERENCES users(id) ON DELETE CASCADE,
    createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
    keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
    machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
    revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
    expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
  db.exec(
    "DELETE FROM memberships; DELETE FROM workspaces; DELETE FROM users; DELETE FROM providerConnections; DELETE FROM providerNodes; DELETE FROM combos; DELETE FROM connectionGrants; DELETE FROM budgets; DELETE FROM usageHistory; DELETE FROM workspaceSettings; DELETE FROM kv WHERE scope IN ('modelAliases','customModels','disabledModels'); DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid','defaultWorkspaceId')",
  );
  bumpBudgetsGeneration();
  for (const [user, ws] of [
    ["uA", "wA"],
    ["uB", "wB"],
  ]) {
    db.run(
      "INSERT INTO users(id, instanceRole, status, createdAt, updatedAt) VALUES (?, 'user', 'active', ?, ?)",
      [user, NOW, NOW],
    );
    db.run(
      "INSERT INTO workspaces(id,name,kind,createdAt,updatedAt) VALUES (?, ?, 'shared', ?, ?)",
      [ws, ws, NOW, NOW],
    );
    db.run(
      "INSERT INTO memberships(workspaceId,userId,role,createdAt) VALUES (?, ?, 'member', ?)",
      [ws, user, NOW],
    );
  }
  db.run("INSERT INTO _meta(key,value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)", [
    KID,
  ]);
  insertHashedApiKeySync(db, hashedKeyRow("keyA", "wA", TOKEN_A));
  insertHashedApiKeySync(db, hashedKeyRow("keyB", "wB", TOKEN_B));
  const world = {
    db,
    wA: "wA",
    wB: "wB",
    membershipScopeId: membershipScopeId("wB", "uB"),
    /** Insert a hashed gateway key for wB with explicit scope pins; returns its token. */
    insertKey(id, patch = {}) {
      const token = `th_${id
        .replace(/[^a-zA-Z0-9]/g, "k")
        .padEnd(32, "K")
        .slice(0, 32)}`;
      insertHashedApiKeySync(db, hashedKeyRow(id, "wB", token, patch));
      return token;
    },
    conn(id, provider, workspaceId, patch = {}) {
      db.run(
        `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, workspaceId, createdByUserId)
         VALUES(?, ?, 'apikey', ?, NULL, ?, 1, ?, ?, ?, ?, NULL)`,
        [
          id,
          provider,
          id,
          patch.priority ?? 1,
          JSON.stringify({ apiKey: `sk-${id}`, ...(patch.data || {}) }),
          NOW,
          NOW,
          workspaceId,
        ],
      );
    },
    kv(scope, key, value) {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
         ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [scope, key, JSON.stringify(value)],
      );
    },
    grant(id, connectionId, workspaceId, patch = {}) {
      db.run(
        `INSERT INTO connectionGrants(id, connectionId, workspaceId, userId, allowedModels, rpm, tpm, tosAcknowledgedAt, createdAt, revokedAt)
         VALUES(?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, NULL)`,
        [
          id,
          connectionId,
          workspaceId,
          patch.allowedModels ? JSON.stringify(patch.allowedModels) : null,
          Date.now(),
        ],
      );
    },
    budget(scopeType, scopeId, { workspaceId, limitRequests = 0 } = {}) {
      db.run(
        `INSERT INTO budgets(id, workspaceId, scopeType, scopeId, window, limitUsd, limitTokens, limitRequests, softLimitPct, resetAt, createdByUserId, createdAt)
         VALUES(?, ?, ?, ?, 'day', NULL, NULL, ?, NULL, NULL, NULL, ?)`,
        [
          `bud-${scopeType}-${scopeId}`,
          scopeType === "user" ? null : workspaceId,
          scopeType,
          scopeId,
          limitRequests,
          NOW,
        ],
      );
      bumpBudgetsGeneration();
    },
  };
  // wB's own connection: wB legitimately serves anthropic only.
  world.conn("conn-b", "anthropic", "wB");
  // wA's tenant data; only wA's key may resolve any of it.
  world.conn("conn-a", "openai", "wA");
  world.conn("conn-a-node", "openai-compatible-a-node", "wA", {
    data: { baseUrl: "https://w1-node.test/v1", providerSpecificData: { prefix: "nodew1" } },
  });
  db.run(
    `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt, workspaceId)
     VALUES('combo-a', 'combo-w1', NULL, ?, ?, ?, 'wA')`,
    [JSON.stringify(["openai/gpt-4o"]), NOW, NOW],
  );
  world.kv("modelAliases", "ws:wA/alias-w1", "openai/gpt-4o");
  world.kv("customModels", "ws:wA/custom-a", { id: "custom-w1-model", providerAlias: "openai" });
  world.kv("disabledModels", "ws:wA/openai", ["gpt-4o-mini"]);
  return world;
}
