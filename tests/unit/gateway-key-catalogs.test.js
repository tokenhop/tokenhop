// YAN-363 gateway key catalogs: /v1/models, /v1/models/{id} and /v1beta/models
// under hashed principals. Real two-workspace fixture; only external fetch is
// stubbed, so every catalog row comes from the real repos + static registry.
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchCalls } = vi.hoisted(() => ({ fetchCalls: { urls: [] } }));

vi.stubGlobal(
  "fetch",
  vi.fn(async (url) => {
    fetchCalls.urls.push(String(url));
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }),
);

import { getAdapter } from "@/lib/db/driver.js";
import { insertHashedApiKeySync } from "@/lib/db/repos/apiKeysRepo.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { clearApiKeyPrincipalCache } from "@/lib/auth/apiKeyPrincipal.js";
import { GET as listModels } from "@/app/api/v1/models/route.js";
import { GET as lookupModel } from "@/app/api/v1/models/[...model]/route.js";
import { GET as geminiList } from "@/app/api/v1beta/models/route.js";
import { GET as modelInfo } from "@/app/api/v1/models/info/route.js";

const NOW = "2026-10-04T00:00:00.000Z";
const MASTER = crypto.randomBytes(32);
const KID = masterKeyId(MASTER);
const TOKEN = `th_${"R".repeat(32)}`;
const digest = (raw) => hashApiKey(raw, deriveApiKeyHashKey(MASTER));

const req = (key = TOKEN, url = "http://localhost/v1/models") =>
  new Request(url, { headers: key ? { authorization: `Bearer ${key}` } : {} });

const params = (model) => ({ params: Promise.resolve({ model }) });

let db;

function hashedKeyRow(patch = {}) {
  return {
    id: "key1",
    workspaceId: "w1",
    userId: "u1",
    createdByUserId: "u1",
    keyHash: digest(TOKEN),
    hashKid: KID,
    prefix: "th_RRRR…RRRR",
    name: "Catalog key",
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

function insertConnection(id, provider, workspaceId, patch = {}) {
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, workspaceId, createdByUserId)
     VALUES(?, ?, 'apikey', ?, NULL, ?, 1, ?, ?, ?, ?, NULL)`,
    [
      id,
      provider,
      id,
      patch.priority ?? 1,
      JSON.stringify(patch.data || {}),
      NOW,
      NOW,
      workspaceId,
    ],
  );
}

function insertCombo(id, name, models, kind = null) {
  // YAN-364: a principal reads only combos stamped to its workspace.
  db.run(
    `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt, workspaceId) VALUES(?, ?, ?, ?, ?, ?, 'w1')`,
    [id, name, kind, JSON.stringify(models), NOW, NOW],
  );
}

beforeEach(async () => {
  process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
  fetchCalls.urls.length = 0;
  clearApiKeyPrincipalCache();
  db = await getAdapter();
  db.run("INSERT OR REPLACE INTO settings(id,data) VALUES (1, ?)", [
    JSON.stringify({ requireApiKey: true }),
  ]);
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
    "DELETE FROM memberships; DELETE FROM workspaces; DELETE FROM users; DELETE FROM providerConnections; DELETE FROM combos; DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid','defaultWorkspaceId')",
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
});

afterEach(() => {
  delete process.env.TOKENHOP_MASTER_KEY;
});

describe("hashed principal catalog scoping", () => {
  it("own connection lists its models; the foreign workspace connection is never fetched", async () => {
    insertHashedApiKeySync(db, hashedKeyRow());
    insertConnection("conn-w1", "openai", "w1");
    insertConnection("conn-w2", "openai-compatible-foreign", "w2", {
      data: {
        apiKey: "sk-foreign",
        baseUrl: "https://foreign-workspace.test/v1",
        providerSpecificData: { prefix: "t2" },
      },
    });
    const res = await listModels(req());
    expect(res.status).toBe(200);
    const ids = (await res.json()).data.map((m) => m.id);
    expect(ids).toContain("openai/gpt-4o");
    expect(ids.some((id) => id.startsWith("t2/"))).toBe(false);
    expect(ids.every((id) => !id.includes("foreign"))).toBe(true);
    expect(fetchCalls.urls.every((url) => !url.includes("foreign-workspace.test"))).toBe(true);
  });

  it("restricted key sees exactly its canonical allowedModels and allowedCombos", async () => {
    insertHashedApiKeySync(
      db,
      hashedKeyRow({ allowedModels: ["openai/gpt-4o"], allowedCombos: ["combo-yes"] }),
    );
    insertConnection("conn-w1", "openai", "w1");
    insertConnection("conn-w2", "anthropic", "w2");
    insertCombo("combo-yes", "yes-combo", ["openai/gpt-4o"]);
    insertCombo("combo-no", "no-combo", ["openai/gpt-4o-mini"]);

    const list = await listModels(req());
    expect(list.status).toBe(200);
    const ids = (await list.json()).data.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(["openai/gpt-4o", "yes-combo"]));
    expect(ids).not.toContain("openai/gpt-4o-mini");
    expect(ids).not.toContain("no-combo");
    expect(ids.every((id) => !id.startsWith("anthropic/"))).toBe(true);

    // Detail route: allowed resolves, restricted is a plain 404 (no scope leak).
    const detail = await lookupModel(
      req(TOKEN, "http://localhost/v1/models/openai/gpt-4o"),
      params(["openai", "gpt-4o"]),
    );
    expect(detail.status).toBe(200);
    const hidden = await lookupModel(
      req(TOKEN, "http://localhost/v1/models/openai/gpt-4o-mini"),
      params(["openai", "gpt-4o-mini"]),
    );
    expect(hidden.status).toBe(404);

    // Gemini list surfaces the same scoped catalog.
    const gemini = await geminiList(req(TOKEN, "http://localhost/v1beta/models"));
    expect(gemini.status).toBe(200);
    const names = (await gemini.json()).models.map((m) => m.name);
    expect(names).toContain("models/openai/gpt-4o");
    expect(names).toContain("models/yes-combo");
    expect(names).not.toContain("models/openai/gpt-4o-mini");
    expect(names).not.toContain("models/no-combo");
  });

  it("bad bearer rejects 401 even when requireApiKey is false (no keyless fallback)", async () => {
    db.run("UPDATE settings SET data = json_set(data, '$.requireApiKey', false) WHERE id = 1");
    const list = await listModels(req(`th_${"X".repeat(32)}`));
    expect(list.status).toBe(401);
    const detail = await lookupModel(req(`th_${"X".repeat(32)}`), params(["openai", "gpt-4o"]));
    expect(detail.status).toBe(401);
    const gemini = await geminiList(req(`th_${"X".repeat(32)}`));
    expect(gemini.status).toBe(401);
  });
});

describe("auth failure containment", () => {
  it("resolver error never degrades to scoped-detail lookup or the unscoped global catalog", async () => {
    // A scoped hashed key exists, but corrupt the durable marker so
    // resolveGatewayAuth throws (API_KEY_STATE_INVALID): the catch-all must
    // fail closed with 503 on both the list and the detail path, and never
    // list foreign-workspace models.
    insertHashedApiKeySync(
      db,
      hashedKeyRow({ allowedModels: ["openai/gpt-4o"], allowedCombos: [] }),
    );
    insertConnection("conn-w1", "openai", "w1");
    insertConnection("conn-w2", "anthropic", "w2");
    db.run("UPDATE _meta SET value = 'corrupt' WHERE key = 'apiKeysHashedVersion'");

    // Kind list: 503, no rows.
    const kindList = await lookupModel(
      req(TOKEN, "http://localhost/v1/models/tts"),
      params(["tts"]),
    );
    expect(kindList.status).toBe(503);
    const kindBody = await kindList.json();
    expect(kindBody.data ?? kindBody.models ?? []).toEqual([]);

    // Scoped detail path: fails closed, never the allowed model row.
    const detail = await lookupModel(
      req(TOKEN, "http://localhost/v1/models/openai/gpt-4o"),
      params(["openai", "gpt-4o"]),
    );
    expect(detail.status).toBe(503);

    // models/info detail: same single-resolution containment.
    const info = await modelInfo(req(TOKEN, "http://localhost/v1/models/info?id=openai%2Fgpt-4o"));
    expect(info.status).toBe(503);
    expect(fetchCalls.urls).toEqual([]);
  });
});

describe("models/info malformed id", () => {
  it("id without a slash is 400 invalid_request_error, not a 404 probe", async () => {
    insertHashedApiKeySync(db, hashedKeyRow());
    const res = await modelInfo(req(TOKEN, "http://localhost/v1/models/info?id=gpt-4o"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("well-formed unknown id stays 404", async () => {
    insertHashedApiKeySync(db, hashedKeyRow());
    const res = await modelInfo(req(TOKEN, "http://localhost/v1/models/info?id=openai/nope"));
    expect(res.status).toBe(404);
  });
});

describe("legacy parity", () => {
  it("legacy storage keeps the global static catalog path (no principal filtering)", async () => {
    db.run("DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')");
    db.exec("DROP TABLE apiKeys");
    db.exec(`CREATE TABLE apiKeys (
      id TEXT PRIMARY KEY, key TEXT UNIQUE, name TEXT, machineId TEXT,
      isActive INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL)`);
    db.run("UPDATE settings SET data = json_set(data, '$.requireApiKey', false) WHERE id = 1");
    insertConnection("conn-openai", "openai", "w1");
    insertConnection("conn-claude", "anthropic", "w2");
    insertCombo("combo-any", "any-combo", ["openai/gpt-4o"]);

    const res = await listModels(new Request("http://localhost/v1/models"));
    expect(res.status).toBe(200);
    const ids = (await res.json()).data.map((m) => m.id);
    // No principal: every workspace's connections and all combos list as before.
    expect(ids).toContain("openai/gpt-4o");
    expect(ids.some((id) => id.startsWith("anthropic/"))).toBe(true);
    expect(ids).toContain("any-combo");
  });
});
