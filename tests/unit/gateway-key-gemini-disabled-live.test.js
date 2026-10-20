// Gemini native forward: the disabled-model check is a kill switch. It reads
// LIVE (a model disabled while a budget hold was reserved is refused on the
// budgeted re-entry), and a credential/key-state error fails CLOSED (503, no
// upstream call). Same hashed-key harness as gateway-key-gemini.test.js.
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Budgets are enforced only in multi-user mode; pin it like budget-leaf-single-resolution.
const { hooks } = vi.hoisted(() => {
  process.env.TOKENHOP_MULTI_USER = "on";
  return { hooks: { pricing: null, disabled: null } };
});

vi.mock("@/sse/handlers/chat.js", () => ({ handleChat: vi.fn() }));
vi.mock("@/lib/db/repos/pricingRepo.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getPricingForModel: async (...a) => {
      if (hooks.pricing) await hooks.pricing();
      return actual.getPricingForModel(...a);
    },
  };
});
vi.mock("@/lib/auth/gatewayResources.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getGatewayDisabled: (...a) => {
      if (hooks.disabled) hooks.disabled();
      return actual.getGatewayDisabled(...a);
    },
  };
});

import { getAdapter } from "@/lib/db/driver.js";
import { insertHashedApiKeySync } from "@/lib/db/repos/apiKeysRepo.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { clearApiKeyPrincipalCache } from "@/lib/auth/apiKeyPrincipal.js";
import { bumpBudgetsGeneration } from "@/lib/users/budgets.js";

const { POST } = await import("../../src/app/api/v1beta/models/[...path]/route.js");

const MASTER = crypto.randomBytes(32);
const KID = masterKeyId(MASTER);
const digest = (raw) => hashApiKey(raw, deriveApiKeyHashKey(MASTER));
const TTS_MODEL = "gemini-2.5-flash-preview-tts";
const audioBody = () => ({
  contents: [{ parts: [{ text: "Speak naturally: hello" }] }],
  generationConfig: { responseModalities: ["AUDIO"] },
});
const post = (modelPath, body) =>
  new Request(`http://localhost/v1beta/models/${modelPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
const paramsFor = (modelPath) => ({ params: Promise.resolve({ path: [modelPath] }) });
const call = () =>
  POST(
    post(`${TTS_MODEL}:generateContent`, audioBody()),
    paramsFor(`${TTS_MODEL}:generateContent`),
  );

let db;
let realFetch;

const NOW = "2026-10-04T00:00:00.000Z";
const TOKEN = `th_${"H".repeat(32)}`;

function hashedKeyRow(patch = {}) {
  return {
    id: "key1",
    workspaceId: "w1",
    userId: "u1",
    createdByUserId: "u1",
    keyHash: digest(TOKEN),
    hashKid: KID,
    prefix: "th_HHHH…HHHH",
    name: "Gemini key",
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

function insertConnection(id, provider, workspaceId) {
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, workspaceId, createdByUserId)
     VALUES(?, ?, 'apikey', ?, NULL, 1, 1, ?, ?, ?, ?, NULL)`,
    [id, provider, id, JSON.stringify({ apiKey: `sk-${id}` }), NOW, NOW, workspaceId],
  );
}

function resetHashedSchema() {
  db.exec("DROP TABLE apiKeys");
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    userId TEXT REFERENCES users(id) ON DELETE CASCADE,
    createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
    keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
    machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
    revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
    expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
  db.exec(
    "DELETE FROM memberships; DELETE FROM workspaces; DELETE FROM users; DELETE FROM providerConnections; DELETE FROM providerNodes; DELETE FROM combos; DELETE FROM kv WHERE scope = 'disabledModels'; DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid','defaultWorkspaceId')",
  );
  db.run(
    "INSERT INTO users(id, instanceRole, status, createdAt, updatedAt) VALUES ('u1', 'user', 'active', ?, ?)",
    [NOW, NOW],
  );
  for (const id of ["w1", "w2"]) {
    db.run(
      "INSERT INTO workspaces(id,name,kind,createdAt,updatedAt) VALUES (?, ?, 'shared', ?, ?)",
      [id, id, NOW, NOW],
    );
    db.run(
      "INSERT INTO memberships(workspaceId,userId,role,createdAt) VALUES (?, 'u1', 'member', ?)",
      [id, NOW],
    );
  }
  db.run("INSERT INTO _meta(key,value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)", [
    KID,
  ]);
}

beforeEach(async () => {
  process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
  process.env.TOKENHOP_PEER_TOKEN = "peer";
  clearApiKeyPrincipalCache();
  db = await getAdapter();
  db.run("INSERT OR REPLACE INTO settings(id,data) VALUES (1, ?)", [
    JSON.stringify({ requireApiKey: true }),
  ]);
  resetHashedSchema();
  vi.clearAllMocks();
  hooks.pricing = null;
  hooks.disabled = null;
  db.run("DELETE FROM budgets");
  bumpBudgetsGeneration();
  realFetch = global.fetch;
  global.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
});

afterEach(() => {
  global.fetch = realFetch;
  delete process.env.TOKENHOP_MASTER_KEY;
  delete process.env.TOKENHOP_PEER_TOKEN;
});

const disableFor = (ids) =>
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES ('disabledModels', 'ws:w1/gemini', ?)
     ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify(ids)],
  );

function workspaceBudget() {
  db.run(
    `INSERT INTO budgets(id, workspaceId, scopeType, scopeId, window, limitUsd, limitTokens, limitRequests, softLimitPct, resetAt, createdByUserId, createdAt)
     VALUES('gb1', 'w1', 'workspace', 'w1', 'day', NULL, NULL, 1000, NULL, NULL, NULL, ?)`,
    [NOW],
  );
  bumpBudgetsGeneration();
}

describe("gemini native disabled check is live", () => {
  it("budgeted re-entry refuses a model disabled while the hold was reserved", async () => {
    insertHashedApiKeySync(db, hashedKeyRow());
    insertConnection("conn-w1", "gemini", "w1");
    workspaceBudget();
    // First pass sees the model enabled; the flip lands during the hold (pricing).
    hooks.pricing = () => disableFor([TTS_MODEL]);
    const res = await call();
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toContain("Model disabled");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("without budgets a second request sees a disable made after the first", async () => {
    insertHashedApiKeySync(db, hashedKeyRow());
    insertConnection("conn-w1", "gemini", "w1");
    expect((await call()).status).toBe(200);
    disableFor([TTS_MODEL]);
    const res = await call();
    expect(res.status).toBe(404);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("gemini native fails closed on a credential-state error", () => {
  for (const code of [
    "KEY_MISMATCH",
    "CREDENTIAL_STATE_INVALID",
    "CREDENTIAL_MAINTENANCE_POISONED",
    "API_KEY_STATE_INVALID",
  ]) {
    it(`${code}: 503 and no upstream call`, async () => {
      insertHashedApiKeySync(db, hashedKeyRow());
      insertConnection("conn-w1", "gemini", "w1");
      hooks.disabled = () => {
        throw Object.assign(new Error(code), { code });
      };
      const res = await call();
      expect(res.status).toBe(503);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  }

  it("a plain DB error stays fail-open (existing behavior)", async () => {
    insertHashedApiKeySync(db, hashedKeyRow());
    insertConnection("conn-w1", "gemini", "w1");
    hooks.disabled = () => {
      throw new Error("db down");
    };
    expect((await call()).status).toBe(200);
  });
});
