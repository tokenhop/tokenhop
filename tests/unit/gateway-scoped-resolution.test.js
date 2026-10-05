// YAN-364: gateway name resolution is per-workspace, never cross-workspace.
// Same combo name + different aliases in two workspaces resolve independently;
// a scoped miss falls through to built-ins, never to the other workspace.
// Runs under BOTH switch states (CI matrix): resolution here is principal-
// driven, not switch-driven — the switch-off legs additionally pin the legacy
// global readers to today's behaviour.
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import { insertHashedApiKeySync } from "@/lib/db/repos/apiKeysRepo.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { getModelInfo, getComboModels } from "@/sse/services/model.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const NOW = "2026-10-05T00:00:00.000Z";
const MASTER = crypto.randomBytes(32);
const KID = masterKeyId(MASTER);
const RAW = `th_${"W".repeat(32)}`;
const digest = (raw) => hashApiKey(raw, deriveApiKeyHashKey(MASTER));

// Gateway-only principal (apiKeyPrincipal shape): frozen, workspace-scoped.
function principalOf(workspaceId) {
  return Object.freeze({
    workspaceId,
    userId: null,
    apiKeyId: `key-${workspaceId}`,
    scopes: Object.freeze({ allowedModels: Object.freeze([]), allowedCombos: Object.freeze([]) }),
    via: "apiKey",
  });
}

let db;

function seedWorkspacesAndCombos() {
  db.run("DELETE FROM combos");
  db.run("DELETE FROM workspaces");
  db.run("DELETE FROM kv WHERE scope IN ('modelAliases','customModels','disabledModels')");
  db.run("DELETE FROM _meta WHERE key = 'defaultWorkspaceId'");
  db.run(
    `INSERT INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES
      ('gwA', 'A', 'shared', ?, ?), ('gwB', 'B', 'shared', ?, ?)`,
    [NOW, NOW, NOW, NOW],
  );
  // Same combo name in both workspaces; different members.
  db.run(
    `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt, workspaceId) VALUES
      ('caX', 'panel', NULL, ?, ?, ?, 'gwA'),
      ('cbX', 'panel', NULL, ?, ?, ?, 'gwB')`,
    [JSON.stringify(["openai/gpt-4o"]), NOW, NOW, JSON.stringify(["anthropic/claude-3"]), NOW, NOW],
  );
}

// Two workspaces, one alias name each, different targets (prefix-isolated).
function seedAliases() {
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES
      ('modelAliases', 'ws:gwA/fast', '"openai/gpt-4o"'),
      ('modelAliases', 'ws:gwB/fast', '"anthropic/claude-3"')`,
  );
}

beforeEach(async () => {
  process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
  vi.resetModules();
  db = await getAdapter();
});

afterEach(() => {
  delete process.env.TOKENHOP_MASTER_KEY;
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("per-workspace resolution", () => {
  beforeEach(seedWorkspacesAndCombos);

  it("the same combo name expands to each workspace's own member list", async () => {
    const a = await getComboModels("panel", { principal: principalOf("gwA") });
    const b = await getComboModels("panel", { principal: principalOf("gwB") });
    expect(a).toEqual(["openai/gpt-4o"]);
    expect(b).toEqual(["anthropic/claude-3"]);
  });

  it("the same alias name resolves per workspace; a scoped miss falls to built-ins", async () => {
    seedAliases();
    expect(await getModelInfo("fast", { principal: principalOf("gwA") })).toEqual({
      provider: "openai",
      model: "gpt-4o",
    });
    expect(await getModelInfo("fast", { principal: principalOf("gwB") })).toEqual({
      provider: "anthropic",
      model: "claude-3",
    });
    // Unknown alias in B never leaks A's map: built-in inference only.
    const miss = await getModelInfo("totally-unknown-alias-x", {
      principal: principalOf("gwB"),
    });
    expect(miss).toMatchObject({ model: "totally-unknown-alias-x" });
    expect(miss.provider).not.toBe("anthropic");
    // A combo name still signals the combo path (provider null).
    expect(await getModelInfo("panel", { principal: principalOf("gwB") })).toEqual({
      provider: null,
      model: "panel",
    });
  });

  it("/v1/models lists the caller's workspace combos only; legacy keeps the global catalog", async () => {
    const a = (await buildModelsList(["llm"], { principal: principalOf("gwA") })).map((m) => m.id);
    const b = (await buildModelsList(["llm"], { principal: principalOf("gwB") })).map((m) => m.id);
    expect(a.filter((i) => i === "panel")).toHaveLength(1);
    expect(b.filter((i) => i === "panel")).toHaveLength(1);
    const legacy = (await buildModelsList(["llm"])).map((m) => m.id);
    expect(legacy).toContain("panel");
  });

  it("switch off: legacy global readers stay byte-identical", async () => {
    process.env[ENV] = "off";
    vi.resetModules();
    const { getModelAliasesUnscoped, getComboByNameUnscoped, getCombosUnscoped } = await import(
      "@/lib/db/index.js"
    );
    const combo = await getComboByNameUnscoped("panel");
    expect(combo).toBeTruthy();
    expect((await getCombosUnscoped()).filter((c) => c.name === "panel")).toHaveLength(2);
    expect(await getModelAliasesUnscoped()).toEqual({});
  });
});

describe("hashed gateway key resolves to its workspace", () => {
  beforeEach(() => {
    seedWorkspacesAndCombos();
    db.run("DELETE FROM users");
    db.exec("DROP TABLE IF EXISTS apiKeys");
    db.exec(`CREATE TABLE apiKeys (
      id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      userId TEXT REFERENCES users(id) ON DELETE CASCADE,
      createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
      keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
      machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
      revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
      expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
    db.run("DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')");
    db.run(
      `INSERT INTO users(id, instanceRole, status, createdAt, updatedAt)
       VALUES ('gu1', 'user', 'active', ?, ?)`,
      [NOW, NOW],
    );
    db.run(
      "INSERT INTO _meta(key,value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)",
      [KID],
    );
    insertHashedApiKeySync(db, {
      id: "key-gwA",
      workspaceId: "gwA",
      userId: null,
      createdByUserId: null,
      keyHash: digest(RAW),
      hashKid: KID,
      prefix: "th_WWWW…WWWW",
      name: "Routing key gwA",
      machineId: null,
      legacy: 0,
      isActive: 1,
      revokedAt: null,
      allowedModels: [],
      allowedCombos: [],
      expiresAt: null,
      lastUsedAt: null,
      createdAt: NOW,
    });
  });

  it("a valid bearer resolves into its own workspace and expands its own combo", async () => {
    const { resolveApiKey } = await import("@/lib/auth/apiKeyPrincipal.js");
    const p = await resolveApiKey(RAW);
    expect(p.workspaceId).toBe("gwA");
    expect(await getComboModels("panel", { principal: p })).toEqual(["openai/gpt-4o"]);
  });
});
