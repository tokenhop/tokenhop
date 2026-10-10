// YAN-701 backend hardening: move-only target DEK provisioning (keyless
// workspaces), typed crypto error responses, custom-model combo refs and
// key-scoped budgets that follow their API key. Companion to
// workspace-move.test.js (same harness pattern).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute, seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 13 + 7) % 256));
const NOW = "2026-10-09T00:00:00.000Z";

const jar = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n) => {
      const m = jar.cookie.match(new RegExp(`(?:^|; )${n}=([^;]*)`));
      return m ? { name: n, value: m[1] } : undefined;
    },
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(jar.cookie ? { cookie: jar.cookie } : {}),
}));

let db;
let t;
let a2;

async function load() {
  vi.resetModules();
  process.env[ENV] = "on";
  process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
  db = await import("@/lib/db/index.js");
  a2 = await (await import("@/lib/db/driver.js")).getAdapter();
}

async function moveAs(seeded, sourceId, body) {
  const route = await import("@/app/api/workspaces/[id]/move/route.js");
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  const token = await createDashboardAuthToken({
    sub: seeded.user.id,
    sv: seeded.user.sessionVersion,
    wid: seeded.ctx.activeWorkspaceId,
  });
  jar.cookie = `auth_token=${token}`;
  try {
    return await callRoute(route.POST, `/api/workspaces/${sourceId}/move`, {
      as: seeded,
      method: "POST",
      body,
      params: { id: sourceId },
    });
  } finally {
    jar.cookie = "";
  }
}

const conn = (name, extra = {}) => ({
  provider: "openai",
  authType: "apikey",
  name,
  apiKey: `sk-${name}`,
  ...extra,
});

async function clean() {
  for (const sql of [
    `DELETE FROM budgets`,
    `DELETE FROM usageHistory`,
    `DELETE FROM connectionGrants`,
    `DELETE FROM providerConnections`,
    `DELETE FROM providerNodes`,
    `DELETE FROM combos`,
    `DELETE FROM kv WHERE scope IN ('modelAliases','customModels','disabledModels')`,
    `DELETE FROM workspaceSettings`,
    `DELETE FROM auditEvents`,
    `DELETE FROM workspaceKeys`,
    `DELETE FROM _meta WHERE key IN ('credentialsEncryptedVersion','credentialsKekKid','apiKeyHashKeyWrapped','apiKeysHashedVersion','apiKeysHashKid')`,
  ])
    a2.run(sql);
  const { clearCredentialCache } = await import("@/lib/db/helpers/credentialStorage.js");
  clearCredentialCache(a2);
}

// Encryption marker + DEKs ONLY for the listed workspaces (others stay keyless).
async function establishEncryption(workspaces) {
  const { loadMasterKey, deriveApiKeyHashKey } = await import("@/lib/security/masterKey.js");
  const { encryptBytes, buildHashKeyWrapAad } = await import("@/lib/security/envelope.js");
  const { createMigrationContext, ensureWorkspaceDekSync, clearCredentialCache } = await import(
    "@/lib/db/helpers/credentialStorage.js"
  );
  const root = await loadMasterKey({ create: true });
  const set = (key, value) =>
    a2.run(
      `INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  set("credentialsEncryptedVersion", "1");
  set("credentialsKekKid", root.kid);
  set(
    "apiKeyHashKeyWrapped",
    JSON.stringify(
      encryptBytes(
        root.key,
        root.kid,
        deriveApiKeyHashKey(root.key),
        buildHashKeyWrapAad(workspaces[0], "0123456789abcdef"),
      ),
    ),
  );
  const mctx = createMigrationContext(a2, root);
  for (const ws of workspaces) ensureWorkspaceDekSync(a2, ws, mctx);
  clearCredentialCache(a2);
  return root;
}

async function useHashedKeys() {
  const { HASHED_API_KEYS_TABLE, buildCreateTableSql } = await import("@/lib/db/schema.js");
  const { masterKeyId } = await import("@/lib/security/masterKey.js");
  a2.exec(`DROP TABLE IF EXISTS apiKeys`);
  a2.exec(buildCreateTableSql("apiKeys", HASHED_API_KEYS_TABLE));
  for (const idx of HASHED_API_KEYS_TABLE.indexes) a2.exec(idx);
  a2.run(`INSERT INTO _meta(key, value) VALUES('apiKeysHashedVersion','1'),('apiKeysHashKid',?)`, [
    masterKeyId(MASTER),
  ]);
}

async function restoreLegacyKeys() {
  a2.exec(`DROP TABLE IF EXISTS apiKeys`);
  a2.exec(
    `CREATE TABLE apiKeys (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT, isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL)`,
  );
  a2.exec(`CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)`);
  a2.run(`DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')`);
}

const dekRow = (ws) =>
  a2.get(`SELECT workspaceId, kid, wrappedDek FROM workspaceKeys WHERE workspaceId = ?`, [ws]);
const keyCount = () => a2.get(`SELECT COUNT(*) AS n FROM workspaceKeys`).n;

async function decodeRow(table, id, workspaceId) {
  const { loadMasterKey } = await import("@/lib/security/masterKey.js");
  const { prepareCredentialContext, decodeCredentialRowSync } = await import(
    "@/lib/db/helpers/credentialStorage.js"
  );
  const ctx = prepareCredentialContext(a2, await loadMasterKey({ create: true }));
  const row = a2.get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  return decodeCredentialRowSync(a2, row, ctx, { table, workspaceId });
}

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("move-only target DEK provisioning", () => {
  beforeEach(async () => {
    await load();
    await clean();
    t = await seedTenancy();
    await db.updateSettings({ requireLogin: true });
    await establishEncryption([t.shared.id]); // a.personal stays keyless
  });

  it("provisions a fresh target DEK for connections and nodes; envelopes are raw; source coordinates fail", async () => {
    const { a, shared } = t;
    expect(dekRow(a.personal)).toBeUndefined();
    const c = await db.createConnection(
      a.ctx,
      shared.id,
      conn("kl", { providerSpecificData: { clientSecret: "psd-kl" } }),
    );
    const node = await db.createNode(a.ctx, shared.id, {
      id: "node-kl",
      type: "openai-compatible",
      name: "N",
      prefix: "kl",
      baseUrl: "http://x",
    });
    await db.updateNode(a.ctx, node.id, { apiKey: "node-kl-secret" });
    const res = await moveAs(a, shared.id, {
      targetWorkspaceId: a.personal,
      items: [
        { type: "connection", id: c.id },
        { type: "node", id: node.id },
      ],
    });
    expect(res.status).toBe(200);
    const target = dekRow(a.personal);
    expect(target).toBeTruthy();
    // Fresh key, never the source's.
    expect(target.kid).not.toBe(dekRow(shared.id).kid);
    expect(target.wrappedDek).not.toBe(dekRow(shared.id).wrappedDek);

    const raw = a2.get(`SELECT data FROM providerConnections WHERE id = ?`, [c.id]).data;
    expect(JSON.parse(raw).apiKey).toMatchObject({ v: 1, kid: expect.stringMatching(/^dk_/) });
    expect(raw).not.toContain("sk-kl");
    expect(raw).not.toContain("psd-kl");
    expect(a2.get(`SELECT data FROM providerNodes WHERE id = ?`, [node.id]).data).not.toContain(
      "node-kl-secret",
    );

    const opened = await decodeRow("providerConnections", c.id, a.personal);
    expect(opened.apiKey).toBe("sk-kl");
    expect(opened.providerSpecificData.clientSecret).toBe("psd-kl");
    expect((await decodeRow("providerNodes", node.id, a.personal)).apiKey).toBe("node-kl-secret");
    // Source coordinates (old AAD + source DEK) no longer authenticate the rows.
    await expect(decodeRow("providerConnections", c.id, shared.id)).rejects.toMatchObject({
      code: "DECRYPT_FAILED",
    });
    await expect(decodeRow("providerNodes", node.id, shared.id)).rejects.toMatchObject({
      code: "DECRYPT_FAILED",
    });
  });

  it("a second move reuses the provisioned DEK untouched", async () => {
    const { a, shared } = t;
    const c1 = await db.createConnection(a.ctx, shared.id, conn("one"));
    const c2 = await db.createConnection(a.ctx, shared.id, conn("two"));
    const body = (id) => ({ targetWorkspaceId: a.personal, items: [{ type: "connection", id }] });
    expect((await moveAs(a, shared.id, body(c1.id))).status).toBe(200);
    const first = dekRow(a.personal);
    expect((await moveAs(a, shared.id, body(c2.id))).status).toBe(200);
    expect(dekRow(a.personal)).toEqual(first);
    expect((await decodeRow("providerConnections", c2.id, a.personal)).apiKey).toBe("sk-two");
  });

  it("a late failure rolls back the DEK, the partial move and the audit rows; runtime stays fail-closed", async () => {
    const { a, shared } = t;
    const good = await db.createConnection(a.ctx, shared.id, conn("good"));
    // A plaintext secret inside an encrypted instance is rejected at decode time.
    a2.run(
      `INSERT INTO providerConnections(id, provider, authType, name, priority, isActive, data, createdAt, updatedAt, workspaceId)
       VALUES('bad-plain', 'openai', 'apikey', 'bad', 9, 1, '{"apiKey":"plain-leak"}', ?, ?, ?)`,
      [NOW, NOW, shared.id],
    );
    const res = await moveAs(a, shared.id, {
      targetWorkspaceId: a.personal,
      items: [
        { type: "connection", id: good.id },
        { type: "connection", id: "bad-plain" },
      ],
    });
    // Typed, fixed response: no internal message, no secret.
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({
      error: "Stored credential could not be re-sealed",
      code: "plaintext_rejected",
    });
    expect(JSON.stringify(body)).not.toContain("plain-leak");

    expect(dekRow(a.personal)).toBeUndefined();
    expect(
      a2.get(`SELECT workspaceId FROM providerConnections WHERE id = ?`, [good.id]).workspaceId,
    ).toBe(shared.id);
    expect(a2.get(`SELECT COUNT(*) AS n FROM auditEvents WHERE action = 'workspace.move'`).n).toBe(
      0,
    );
    expect((await decodeRow("providerConnections", good.id, shared.id)).apiKey).toBe("sk-good");

    // No cached DEK can resurrect the rolled-back key: runtime ensure stays closed.
    const { loadMasterKey } = await import("@/lib/security/masterKey.js");
    const { prepareCredentialContext, ensureWorkspaceDekSync } = await import(
      "@/lib/db/helpers/credentialStorage.js"
    );
    const rt = prepareCredentialContext(a2, await loadMasterKey({ create: true }));
    expect(() => ensureWorkspaceDekSync(a2, a.personal, rt)).toThrow(
      expect.objectContaining({ code: "KEY_MISSING" }),
    );
    // Regular runtime writes into a keyless workspace remain fail-closed.
    await expect(db.createConnection(a.ctx, a.personal, conn("nokey"))).rejects.toMatchObject({
      code: "KEY_MISSING",
    });
    expect(dekRow(a.personal)).toBeUndefined();
  });

  it("preview, conflicts, missing confirmation and non-credential moves never provision", async () => {
    const { a, b, shared } = t;
    const c = await db.createConnection(a.ctx, shared.id, conn("np"));
    const body = (items, extra = {}) => ({ targetWorkspaceId: a.personal, items, ...extra });
    const item = [{ type: "connection", id: c.id }];

    expect((await moveAs(a, shared.id, body(item, { preview: true }))).status).toBe(200);
    expect(keyCount()).toBe(1);

    // Conflict: a foreign id (source-needing secrets do decode against the
    // keyless SOURCE here, so the foreign row carries a plaintext-covered leaf).
    const foreignRow = await db.createConnection(b.ctx, t.shared.id, conn("foreign-shell"));
    a2.run(`UPDATE providerConnections SET workspaceId = ? WHERE id = ?`, [
      b.personal,
      foreignRow.id,
    ]);
    const foreign = { id: foreignRow.id };
    const conflict = await moveAs(
      a,
      shared.id,
      body([
        { type: "connection", id: c.id },
        { type: "connection", id: foreign.id },
      ]),
    );
    expect(conflict.status).toBe(409);
    expect(keyCount()).toBe(1);

    // Unconfirmed warning (active grant).
    const { createGrant } = await import("@/lib/db/repos/connectionGrantsRepo.js");
    await createGrant(a.ctx, { connectionId: c.id, userId: b.user.id });
    const unconfirmed = await moveAs(a, shared.id, body(item));
    expect(unconfirmed.status).toBe(409);
    expect((await unconfirmed.json()).code).toBe("confirm_required");
    expect(keyCount()).toBe(1);

    // Non-credential items.
    const combo = await db.createCombo(a.ctx, shared.id, { name: "plain", models: [] });
    await db.setModelAlias(a.ctx, shared.id, "al", "openai/gpt-4o");
    const ok = await moveAs(
      a,
      shared.id,
      body([
        { type: "combo", id: combo.id },
        { type: "alias", id: "al" },
      ]),
    );
    expect(ok.status).toBe(200);
    expect(keyCount()).toBe(1);
    expect(dekRow(a.personal)).toBeUndefined();
  });

  it("the provisioner rejects forged contexts, marker mismatch and unknown workspaces", async () => {
    const { a } = t;
    const { loadMasterKey } = await import("@/lib/security/masterKey.js");
    const cs = await import("@/lib/db/helpers/credentialStorage.js");
    const root = await loadMasterKey({ create: true });
    const real = cs.prepareCredentialContext(a2, root);

    // A copy / hand-built object is not a genuine runtime context.
    expect(() => cs.provisionMoveTargetDekSync(a2, a.personal, { ...real })).toThrow(
      expect.objectContaining({ code: "KEY_MISSING" }),
    );
    expect(() =>
      cs.provisionMoveTargetDekSync(a2, a.personal, {
        encrypted: true,
        kek: root.key,
        kekKid: root.kid,
        state: real.state,
        allowCreate: true,
      }),
    ).toThrow(expect.objectContaining({ code: "KEY_MISSING" }));
    // The trusted migration context is not a runtime context either.
    expect(() =>
      cs.provisionMoveTargetDekSync(a2, a.personal, cs.createMigrationContext(a2, root)),
    ).toThrow(expect.objectContaining({ code: "KEY_MISSING" }));
    // A rootless / legacy context cannot provision.
    expect(() =>
      cs.provisionMoveTargetDekSync(a2, a.personal, cs.prepareCredentialContext(a2, null)),
    ).toThrow(expect.objectContaining({ code: "KEY_MISSING" }));
    expect(dekRow(a.personal)).toBeUndefined();

    // Unknown workspace.
    expect(() => cs.provisionMoveTargetDekSync(a2, "no-such-workspace", real)).toThrow(
      expect.objectContaining({ code: "KEY_MISSING" }),
    );
    expect(dekRow("no-such-workspace")).toBeUndefined();

    // Marker mismatch (state changed after the context was prepared).
    a2.run(`UPDATE _meta SET value = 'ffffffffffffffff' WHERE key = 'credentialsKekKid'`);
    try {
      expect(() => cs.provisionMoveTargetDekSync(a2, a.personal, real)).toThrow(
        expect.objectContaining({ code: "KEY_MISMATCH" }),
      );
    } finally {
      a2.run(`UPDATE _meta SET value = ? WHERE key = 'credentialsKekKid'`, [root.kid]);
    }
    expect(dekRow(a.personal)).toBeUndefined();

    // Happy path: genuine context, then idempotent reuse.
    const first = cs.provisionMoveTargetDekSync(a2, a.personal, real);
    const row = dekRow(a.personal);
    expect(first.kid).toBe(row.kid);
    expect(cs.provisionMoveTargetDekSync(a2, a.personal, real).kid).toBe(row.kid);
    expect(dekRow(a.personal)).toEqual(row);
  });
});

describe("crypto failures on the route", () => {
  beforeEach(async () => {
    await load();
    await clean();
    t = await seedTenancy();
    await db.updateSettings({ requireLogin: true });
  });

  it("maps key failures to fixed typed 503 codes without internal text", async () => {
    const { a, shared } = t;
    const c = await db.createConnection(a.ctx, shared.id, conn("mapped"));
    await establishEncryption([shared.id, a.personal]);
    // Marker flips to a different kid after the master key resolves → live mismatch.
    a2.run(`UPDATE _meta SET value = 'ffffffffffffffff' WHERE key = 'credentialsKekKid'`);
    const res = await moveAs(a, shared.id, {
      targetWorkspaceId: a.personal,
      items: [{ type: "connection", id: c.id }],
    });
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body).toEqual({
      error: "The credential root key is unavailable",
      code: "key_missing",
    });
    expect(Object.keys(body).sort()).toEqual(["code", "error"]);
    expect(JSON.stringify(body)).not.toMatch(/credential-storage|ffffffffffffffff|sk-mapped/);
  });
});

describe("combo refs to custom models", () => {
  beforeEach(async () => {
    await load();
    await clean();
    t = await seedTenancy();
    await db.updateSettings({ requireLogin: true });
  });

  async function preview(items, combo) {
    const res = await moveAs(t.a, t.shared.id, {
      targetWorkspaceId: t.a.personal,
      preview: true,
      items: items ?? [{ type: "combo", id: combo.id }],
    });
    return res.json();
  }

  it("warns when a referenced custom model stays behind and the target lacks it", async () => {
    const { a, shared } = t;
    await db.addCustomModel(a.ctx, shared.id, {
      providerAlias: "openai",
      id: "my-model",
      type: "llm",
    });
    const combo = await db.createCombo(a.ctx, shared.id, {
      name: "cm",
      models: ["openai/my-model"],
    });
    const out = await preview(null, combo);
    expect(out.conflicts).toEqual([]);
    expect(out.warnings).toEqual([
      {
        type: "combo",
        id: combo.id,
        code: "COMBO_REF_NOT_MOVING",
        message: expect.any(String),
        details: { count: 1 },
      },
    ]);
  });

  it("stays quiet when the custom model moves too, exists in the target, or never existed", async () => {
    const { a, shared } = t;
    await db.addCustomModel(a.ctx, shared.id, {
      providerAlias: "openai",
      id: "my-model",
      type: "llm",
    });
    const combo = await db.createCombo(a.ctx, shared.id, {
      name: "cm2",
      models: ["openai/my-model", "openai/never-defined"],
    });
    // Moving together.
    expect(
      (
        await preview([
          { type: "combo", id: combo.id },
          { type: "customModel", id: "openai|my-model|llm" },
        ])
      ).warnings,
    ).toEqual([]);
    // Already resolvable in the target (any type suffix).
    await db.addCustomModel(a.ctx, a.personal, {
      providerAlias: "openai",
      id: "my-model",
      type: "embedding",
    });
    expect((await preview(null, combo)).warnings).toEqual([]);
  });
});

describe("key-scoped budgets follow their API key", () => {
  beforeEach(async () => {
    await load();
    await clean();
    t = await seedTenancy();
    await db.updateSettings({ requireLogin: true });
    await useHashedKeys();
  });

  afterAll(async () => {
    if (a2) {
      await restoreLegacyKeys();
      a2.run(`DELETE FROM budgets`);
    }
  });

  function keyBudget(keyId, workspaceId, limits) {
    const id = `kb-${keyId}-${limits.window ?? "total"}`;
    a2.run(
      `INSERT INTO budgets(id, workspaceId, scopeType, scopeId, window, limitUsd, limitTokens, limitRequests, softLimitPct, resetAt, createdByUserId, createdAt)
       VALUES(?, ?, 'key', ?, ?, NULL, NULL, ?, NULL, NULL, NULL, ?)`,
      [id, workspaceId, keyId, limits.window ?? "total", limits.requests ?? null, NOW],
    );
    return id;
  }

  it("moves the budget row (same id, caps and window), keeps spend, and enforces in the target", async () => {
    const { a, shared } = t;
    const { createApiKey } = await import("@/lib/users/apiKeyManagement.js");
    const { metadata } = await createApiKey(a.ctx, shared.id, { type: "service", name: "metered" });
    const budgetId = keyBudget(metadata.id, shared.id, { requests: 1 });
    // One settled success already counts against the cap of 1.
    a2.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, workspaceId, userId, apiKeyId)
       VALUES(?, 'openai', 'gpt-x', NULL, NULL, '/v1/chat/completions', 10, 5, 1, 'success', ?, NULL, ?)`,
      [NOW, shared.id, metadata.id],
    );
    const before = a2.get(`SELECT * FROM budgets WHERE id = ?`, [budgetId]);
    const usageBefore = a2.all(`SELECT * FROM usageHistory ORDER BY id`);

    const res = await moveAs(a, shared.id, {
      targetWorkspaceId: a.personal,
      items: [{ type: "apiKey", id: metadata.id }],
    });
    expect(res.status).toBe(200);

    const after = a2.get(`SELECT * FROM budgets WHERE id = ?`, [budgetId]);
    expect(after).toEqual({ ...before, workspaceId: a.personal });
    // Ledger untouched.
    expect(a2.all(`SELECT * FROM usageHistory ORDER BY id`)).toEqual(usageBefore);

    // Managed from the target, no longer from the source.
    const { listBudgets, updateBudget } = await import("@/lib/db/repos/budgetsRepo.js");
    expect((await listBudgets(a.ctx, { workspaceId: a.personal })).map((x) => x.id)).toEqual([
      budgetId,
    ]);
    expect(await listBudgets(a.ctx, { workspaceId: shared.id })).toEqual([]);
    await expect(
      updateBudget(a.ctx, { workspaceId: shared.id, budgetId }, { limitRequests: 1 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      updateBudget(a.ctx, { workspaceId: a.personal, budgetId }, { limitRequests: 1 }),
    ).resolves.toMatchObject({ id: budgetId, workspaceId: a.personal });

    // Gateway: the carried-over spend (1 of 1) still blocks, in the target workspace.
    const guard = await import("@/sse/services/budgetGuard.js");
    const principal = Object.freeze({
      via: "apiKey",
      workspaceId: a.personal,
      userId: null,
      apiKeyId: metadata.id,
    });
    const blocked = await guard.budgeted(
      principal,
      { provider: "openai", model: "gpt-x", nonToken: true },
      async () => new Response("ok"),
    );
    expect(blocked?.status).toBe(429);
    expect((await blocked.json()).error).toMatchObject({ code: "budget_exceeded", level: "key" });
  });

  it("refuses a move whose key budget exceeds the target workspace ceiling", async () => {
    const { a, shared } = t;
    const { createApiKey } = await import("@/lib/users/apiKeyManagement.js");
    const { metadata } = await createApiKey(a.ctx, shared.id, { type: "service", name: "wide" });
    const budgetId = keyBudget(metadata.id, shared.id, { requests: 50 });
    a2.run(
      `INSERT INTO budgets(id, workspaceId, scopeType, scopeId, window, limitUsd, limitTokens, limitRequests, softLimitPct, resetAt, createdByUserId, createdAt)
       VALUES('ceiling', ?, 'workspace', ?, 'total', NULL, NULL, 10, NULL, NULL, NULL, ?)`,
      [a.personal, a.personal, NOW],
    );
    const res = await moveAs(a, shared.id, {
      targetWorkspaceId: a.personal,
      items: [{ type: "apiKey", id: metadata.id }],
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.conflicts).toEqual([
      {
        type: "apiKey",
        id: metadata.id,
        code: "KEY_BUDGET_EXCEEDS_TARGET",
        message: expect.any(String),
      },
    ]);
    expect(a2.get(`SELECT workspaceId FROM budgets WHERE id = ?`, [budgetId]).workspaceId).toBe(
      shared.id,
    );
    expect(a2.get(`SELECT workspaceId FROM apiKeys WHERE id = ?`, [metadata.id]).workspaceId).toBe(
      shared.id,
    );
  });
});
