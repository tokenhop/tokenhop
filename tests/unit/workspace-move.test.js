// YAN-701 workspace moves: route gates (404 off, 403 missing rights, 400 bad
// input), item conflicts (foreign ids, name clashes, key refs), warning +
// confirm flow (grants revoked, provider terms), credential re-sealing under
// the target DEK, atomic rollback, audit rows, hashed-key moves and the
// v1.0.0 Default-workspace adoption path. Pattern: scoped-combos.test.js on
// the two-user tenancy harness.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute, seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const FIXTURE = fs.readFileSync(path.join(__dirname, "../fixtures/db/v1.0.0.sql"), "utf-8");
const MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 11 + 5) % 256));
const NOW = "2026-10-09T00:00:00.000Z";

// Route handlers read cookies(); the harness cookie is mirrored into this jar.
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

async function load(state) {
  vi.resetModules();
  process.env[ENV] = state;
  process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
  db = await import("@/lib/db/index.js");
}

const adapter = () => import("@/lib/db/driver.js").then((m) => m.getAdapter());

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

const apiKeyConn = (name) => ({
  provider: "openai",
  authType: "apikey",
  name,
  apiKey: `sk-${name}`,
});

async function clean() {
  const a = await adapter();
  for (const sql of [
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
    a.run(sql);
  const { clearCredentialCache } = await import("@/lib/db/helpers/credentialStorage.js");
  clearCredentialCache(a);
}

async function establishEncryption(a, workspaces) {
  const { loadMasterKey, deriveApiKeyHashKey } = await import("@/lib/security/masterKey.js");
  const { encryptBytes, buildHashKeyWrapAad } = await import("@/lib/security/envelope.js");
  const { createMigrationContext, ensureWorkspaceDekSync, clearCredentialCache } = await import(
    "@/lib/db/helpers/credentialStorage.js"
  );
  const root = await loadMasterKey({ create: true });
  const set = (key, value) =>
    a.run(
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
  const mctx = createMigrationContext(a, root);
  for (const ws of workspaces) ensureWorkspaceDekSync(a, ws, mctx);
  clearCredentialCache(a);
}

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("workspace move: switch off", () => {
  it("answers 404", async () => {
    await load("off");
    const route = await import("@/app/api/workspaces/[id]/move/route.js");
    const res = await callRoute(route.POST, "/api/workspaces/w/move", {
      method: "POST",
      body: { targetWorkspaceId: "x", items: [{ type: "combo", id: "c" }] },
      params: { id: "w" },
    });
    expect(res.status).toBe(404);
    await clean();
  });
});

describe("workspace move: switch on", () => {
  beforeEach(async () => {
    await load("on");
    await clean();
    t = await seedTenancy();
    await db.updateSettings({ requireLogin: true });
  });

  it("rejects bad bodies, same-source-target and duplicate items", async () => {
    const { a, shared } = t;
    const bad = [
      { targetWorkspaceId: shared.id },
      { targetWorkspaceId: shared.id, items: [] },
      { targetWorkspaceId: shared.id, items: [{ type: "nope", id: "x" }] },
      { targetWorkspaceId: shared.id, items: [{ type: "combo", id: "x", extra: 1 }] },
      {
        targetWorkspaceId: shared.id,
        items: [
          { type: "combo", id: "x" },
          { type: "combo", id: "x" },
        ],
      },
      { targetWorkspaceId: a.personal, unknown: true, items: [{ type: "combo", id: "x" }] },
    ];
    for (const body of bad) {
      const res = await moveAs(a, a.personal, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const same = await moveAs(a, a.personal, {
      targetWorkspaceId: a.personal,
      items: [{ type: "combo", id: "x" }],
    });
    expect(same.status).toBe(400);
  });

  it("denies a member without manage rights in source or target", async () => {
    const { b, shared } = t;
    const theirs = await db.createConnection(b.ctx, b.personal, apiKeyConn("b-only"));
    // b is a plain member of shared: no manage rights in the source workspace.
    const fromShared = await moveAs(b, shared.id, {
      targetWorkspaceId: b.personal,
      items: [{ type: "connection", id: theirs.id }],
    });
    expect(fromShared.status).toBe(403);
    // b owns b.personal but only holds member rights in the shared target.
    const toShared = await moveAs(b, b.personal, {
      targetWorkspaceId: shared.id,
      items: [{ type: "connection", id: theirs.id }],
    });
    expect(toShared.status).toBe(403);
  });

  it("treats foreign-workspace ids as NOT_FOUND item conflicts, never as leaks", async () => {
    const { a, b, shared } = t;
    const foreign = await db.createConnection(b.ctx, b.personal, apiKeyConn("foreign"));
    const mine = await db.createConnection(a.ctx, shared.id, apiKeyConn("mine"));
    const preview = await moveAs(a, shared.id, {
      targetWorkspaceId: a.personal,
      preview: true,
      items: [
        { type: "connection", id: foreign.id },
        { type: "connection", id: mine.id },
      ],
    });
    expect(preview.status).toBe(200);
    const body = await preview.json();
    expect(body.conflicts).toEqual([
      { type: "connection", id: foreign.id, code: "NOT_FOUND", message: expect.any(String) },
    ]);
    expect(body.moved).toEqual([]);
    const commit = await moveAs(a, shared.id, {
      targetWorkspaceId: a.personal,
      items: [{ type: "connection", id: foreign.id }],
    });
    expect(commit.status).toBe(409);
    const c = await commit.json();
    expect(c.code).toBe("move_conflict");
    expect(c.conflicts[0].code).toBe("NOT_FOUND");
    const a2 = await adapter();
    expect(
      a2.get(`SELECT workspaceId FROM providerConnections WHERE id = ?`, [foreign.id]).workspaceId,
    ).toBe(b.personal);
    expect(
      a2.get(`SELECT workspaceId FROM providerConnections WHERE id = ?`, [mine.id]).workspaceId,
    ).toBe(shared.id);
  });

  it("moves nodes, combos and aliases with ids retained; one audit row per item; preview never mutates", async () => {
    const { a, shared } = t;
    const conn = await db.createConnection(a.ctx, shared.id, {
      ...apiKeyConn("nodeuser"),
      provider: "node-main",
    });
    const node = await db.createNode(a.ctx, shared.id, {
      id: "node-main",
      type: "openai-compatible",
      name: "N",
      prefix: "n9",
      baseUrl: "http://x",
    });
    const combo = await db.createCombo(a.ctx, shared.id, {
      name: "panel",
      models: ["node-main/m1"],
    });
    await db.setModelAlias(a.ctx, shared.id, "fav", "openai/gpt-4o");
    await db.updateWorkspaceComboStrategies(a.ctx, shared.id, (m) => ({
      ...m,
      [combo.id]: { fallbackStrategy: "round-robin" },
    }));
    const items = [
      { type: "connection", id: conn.id },
      { type: "node", id: node.id },
      { type: "combo", id: combo.id },
      { type: "alias", id: "fav" },
    ];
    const a2 = await adapter();
    const before = JSON.stringify(a2.all(`SELECT * FROM combos ORDER BY id`));
    const preview = await moveAs(a, shared.id, {
      targetWorkspaceId: a.personal,
      preview: true,
      items,
    });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ preview: true, conflicts: [], warnings: [] });
    expect(JSON.stringify(a2.all(`SELECT * FROM combos ORDER BY id`))).toBe(before);

    const res = await moveAs(a, shared.id, { targetWorkspaceId: a.personal, items });
    expect(res.status).toBe(200);
    const { moved, preview: isPreview } = await res.json();
    expect(isPreview).toBe(false);
    expect(moved).toEqual(items);
    expect(
      a2.get(`SELECT workspaceId FROM providerConnections WHERE id = ?`, [conn.id]).workspaceId,
    ).toBe(a.personal);
    expect(
      a2.get(`SELECT workspaceId FROM providerNodes WHERE id = ?`, [node.id]).workspaceId,
    ).toBe(a.personal);
    expect(a2.get(`SELECT workspaceId, name FROM combos WHERE id = ?`, [combo.id])).toEqual({
      workspaceId: a.personal,
      name: "panel",
    });
    expect(
      a2.get(`SELECT value FROM kv WHERE scope = 'modelAliases' AND key = ?`, [
        `ws:${a.personal}/fav`,
      ]).value,
    ).toBe('"openai/gpt-4o"');
    expect(
      a2.get(`SELECT value FROM kv WHERE scope = 'modelAliases' AND key = ?`, [
        `ws:${shared.id}/fav`,
      ]),
    ).toBeUndefined();
    const strategies = JSON.parse(
      a2.get(`SELECT data FROM workspaceSettings WHERE workspaceId = ?`, [a.personal]).data,
    ).comboStrategies;
    expect(strategies[combo.id]).toEqual({ fallbackStrategy: "round-robin" });
    const srcStrategies = JSON.parse(
      a2.get(`SELECT data FROM workspaceSettings WHERE workspaceId = ?`, [shared.id]).data,
    ).comboStrategies;
    expect(srcStrategies[combo.id]).toBeUndefined();

    const rows = a2.all(
      `SELECT * FROM auditEvents WHERE action = 'workspace.move' ORDER BY targetType`,
    );
    expect(rows).toHaveLength(items.length);
    for (const row of rows) {
      expect(row.workspaceId).toBe(shared.id);
      expect(row.actorUserId).toBe(a.user.id);
      expect(JSON.parse(row.before)).toEqual({ workspaceId: shared.id });
      expect(JSON.parse(row.after)).toEqual({ workspaceId: a.personal });
    }
    expect(new Set(rows.map((r) => r.targetId))).toEqual(
      new Set([conn.id, node.id, combo.id, "fav"]),
    );
  });

  it("rolls the entire move back on a name clash", async () => {
    const { a, shared } = t;
    const conn = await db.createConnection(a.ctx, shared.id, apiKeyConn("rollback"));
    const combo = await db.createCombo(a.ctx, shared.id, { name: "clash", models: [] });
    await db.createCombo(a.ctx, a.personal, { name: "clash", models: [] });
    const a2 = await adapter();
    const before = JSON.stringify(a2.all(`SELECT id, workspaceId FROM providerConnections`));
    const res = await moveAs(a, shared.id, {
      targetWorkspaceId: a.personal,
      items: [
        { type: "connection", id: conn.id },
        { type: "combo", id: combo.id },
      ],
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("move_conflict");
    expect(body.conflicts).toEqual([
      { type: "combo", id: combo.id, code: "NAME_TAKEN", message: expect.any(String) },
    ]);
    expect(JSON.stringify(a2.all(`SELECT id, workspaceId FROM providerConnections`))).toBe(before);
    expect(a2.get(`SELECT workspaceId FROM combos WHERE id = ?`, [combo.id]).workspaceId).toBe(
      shared.id,
    );
    expect(a2.get(`SELECT COUNT(*) AS n FROM auditEvents WHERE action = 'workspace.move'`).n).toBe(
      0,
    );
  });

  it("revokes grants only on confirm and keeps usage untouched", async () => {
    const { a, b, shared } = t;
    const conn = await db.createConnection(a.ctx, shared.id, apiKeyConn("granted"));
    const { createGrant } = await import("@/lib/db/repos/connectionGrantsRepo.js");
    const grant = await createGrant(a.ctx, { connectionId: conn.id, userId: b.user.id });
    const a2 = await adapter();
    a2.run(
      `INSERT INTO usageHistory(id, timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens)
       VALUES(1, ?, 'openai', 'gpt-4o', ?, NULL, '/v1/chat/completions', 0)`,
      [NOW, conn.id],
    );
    const preview = await moveAs(a, shared.id, {
      targetWorkspaceId: a.personal,
      preview: true,
      items: [{ type: "connection", id: conn.id }],
    });
    const pv = await preview.json();
    expect(pv.warnings).toEqual([
      {
        type: "connection",
        id: conn.id,
        code: "GRANTS_REVOKED",
        message: expect.any(String),
        details: { count: 1 },
      },
    ]);
    const unconfirmed = await moveAs(a, shared.id, {
      targetWorkspaceId: a.personal,
      items: [{ type: "connection", id: conn.id }],
    });
    expect(unconfirmed.status).toBe(409);
    expect((await unconfirmed.json()).code).toBe("confirm_required");
    expect(
      a2.get(`SELECT revokedAt FROM connectionGrants WHERE id = ?`, [grant.id]).revokedAt,
    ).toBeNull();
    expect(
      a2.get(`SELECT workspaceId FROM providerConnections WHERE id = ?`, [conn.id]).workspaceId,
    ).toBe(shared.id);

    const res = await moveAs(a, shared.id, {
      targetWorkspaceId: a.personal,
      confirm: true,
      items: [{ type: "connection", id: conn.id }],
    });
    expect(res.status).toBe(200);
    expect(
      a2.get(`SELECT revokedAt FROM connectionGrants WHERE id = ?`, [grant.id]).revokedAt,
    ).toBeTruthy();
    expect(
      a2.get(`SELECT workspaceId FROM providerConnections WHERE id = ?`, [conn.id]).workspaceId,
    ).toBe(a.personal);
    expect(
      a2.get(`SELECT COUNT(*) AS n FROM usageHistory WHERE connectionId = ?`, [conn.id]).n,
    ).toBe(1);
  });

  it("warns about personal connections entering a shared workspace (PROVIDER_TERMS)", async () => {
    const { a } = t;
    const conn = await db.createConnection(a.ctx, a.personal, {
      provider: "claude",
      authType: "oauth",
      email: "me@x.test",
      accessToken: "t0",
    });
    const preview = await moveAs(a, a.personal, {
      targetWorkspaceId: t.shared.id,
      preview: true,
      items: [{ type: "connection", id: conn.id }],
    });
    const pv = await preview.json();
    expect(pv.warnings).toHaveLength(1);
    expect(pv.warnings[0]).toMatchObject({
      type: "connection",
      id: conn.id,
      code: "PROVIDER_TERMS",
    });
    expect(pv.warnings[0].message).toContain("Anthropic");
    const unconfirmed = await moveAs(a, a.personal, {
      targetWorkspaceId: t.shared.id,
      items: [{ type: "connection", id: conn.id }],
    });
    expect(unconfirmed.status).toBe(409);
    const res = await moveAs(a, a.personal, {
      targetWorkspaceId: t.shared.id,
      confirm: true,
      items: [{ type: "connection", id: conn.id }],
    });
    expect(res.status).toBe(200);
    const a2 = await adapter();
    expect(
      a2.get(`SELECT workspaceId FROM providerConnections WHERE id = ?`, [conn.id]).workspaceId,
    ).toBe(t.shared.id);
  });

  it("conflicts: node in use, node prefix taken, key owner not a member, key combo refs", async () => {
    const { a, b, shared } = t;
    const node = await db.createNode(a.ctx, shared.id, {
      id: "node-busy",
      type: "openai-compatible",
      name: "N",
      prefix: "busy",
      baseUrl: "http://x",
    });
    await db.createConnection(a.ctx, shared.id, { ...apiKeyConn("busy"), provider: node.id });
    const nodeAlone = await db.createNode(a.ctx, shared.id, {
      id: "node-alone",
      type: "openai-compatible",
      name: "M",
      prefix: "alone",
      baseUrl: "http://x",
    });
    await db.createNode(a.ctx, a.personal, {
      id: "node-clash",
      type: "openai-compatible",
      name: "C",
      prefix: "alone",
      baseUrl: "http://x",
    });
    const res = await moveAs(a, shared.id, {
      targetWorkspaceId: a.personal,
      items: [
        { type: "node", id: node.id },
        { type: "node", id: nodeAlone.id },
      ],
    });
    expect(res.status).toBe(409);
    const { conflicts } = await res.json();
    expect(conflicts).toEqual(
      expect.arrayContaining([
        { type: "node", id: node.id, code: "NODE_IN_USE", message: expect.any(String) },
        { type: "node", id: nodeAlone.id, code: "NAME_TAKEN", message: expect.any(String) },
      ]),
    );
    expect(conflicts).toHaveLength(2);

    // Key-owner and key-combo conflicts need hashed storage.
    const a2 = await adapter();
    const { HASHED_API_KEYS_TABLE, buildCreateTableSql } = await import("@/lib/db/schema.js");
    const { masterKeyId } = await import("@/lib/security/masterKey.js");
    a2.exec(`DROP TABLE apiKeys`);
    a2.exec(buildCreateTableSql("apiKeys", HASHED_API_KEYS_TABLE));
    for (const idx of HASHED_API_KEYS_TABLE.indexes) a2.exec(idx);
    a2.run(
      `INSERT INTO _meta(key, value) VALUES('apiKeysHashedVersion','1'),('apiKeysHashKid',?)`,
      [masterKeyId(MASTER)],
    );
    const { createApiKey } = await import("@/lib/users/apiKeyManagement.js");
    const theirs = await createApiKey(b.ctx, shared.id, { type: "user", name: "b-key" });
    const combo = await db.createCombo(a.ctx, shared.id, { name: "kcombo", models: [] });
    const scoped = await createApiKey(a.ctx, shared.id, {
      type: "service",
      name: "ci",
      allowedCombos: [combo.id],
    });
    const res2 = await moveAs(a, shared.id, {
      targetWorkspaceId: a.personal,
      items: [
        { type: "apiKey", id: theirs.metadata.id },
        { type: "apiKey", id: scoped.metadata.id },
      ],
    });
    expect(res2.status).toBe(409);
    const { conflicts: c2 } = await res2.json();
    expect(c2).toEqual(
      expect.arrayContaining([
        {
          type: "apiKey",
          id: theirs.metadata.id,
          code: "KEY_OWNER_NOT_MEMBER",
          message: expect.any(String),
        },
        {
          type: "apiKey",
          id: scoped.metadata.id,
          code: "KEY_COMBO_REF",
          message: expect.any(String),
        },
      ]),
    );
    expect(c2).toHaveLength(2);
    // Restore the legacy shape + no markers for the rest of the file.
    a2.exec(`DROP TABLE apiKeys`);
    a2.exec(
      `CREATE TABLE apiKeys (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT, isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL)`,
    );
    a2.exec(`CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)`);
    a2.run(`DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')`);
  });

  it("warns when a combo references items that stay behind", async () => {
    const { a, shared } = t;
    const node = await db.createNode(a.ctx, shared.id, {
      id: "node-stays",
      type: "openai-compatible",
      name: "S",
      prefix: "stays",
      baseUrl: "http://x",
    });
    await db.setModelAlias(a.ctx, shared.id, "fav", "openai/gpt-4o");
    const combo = await db.createCombo(a.ctx, shared.id, {
      name: "refs",
      models: ["node-stays/m1", "fav"],
    });
    const preview = await moveAs(a, shared.id, {
      targetWorkspaceId: a.personal,
      preview: true,
      items: [{ type: "combo", id: combo.id }],
    });
    const pv = await preview.json();
    expect(pv.conflicts).toEqual([]);
    expect(pv.warnings).toEqual([
      {
        type: "combo",
        id: combo.id,
        code: "COMBO_REF_NOT_MOVING",
        message: expect.any(String),
        details: { count: 2 },
      },
    ]);
    const res = await moveAs(a, shared.id, {
      targetWorkspaceId: a.personal,
      confirm: true,
      items: [{ type: "combo", id: combo.id }],
    });
    expect(res.status).toBe(200);
    expect(node.id).toBe("node-stays");
  });
});

describe("workspace move: hashed API keys", () => {
  beforeEach(async () => {
    await load("on");
    await clean();
    t = await seedTenancy();
    await db.updateSettings({ requireLogin: true });
    const a = await adapter();
    const { HASHED_API_KEYS_TABLE, buildCreateTableSql } = await import("@/lib/db/schema.js");
    const { masterKeyId } = await import("@/lib/security/masterKey.js");
    a.exec(`DROP TABLE IF EXISTS apiKeys`);
    a.exec(buildCreateTableSql("apiKeys", HASHED_API_KEYS_TABLE));
    for (const idx of HASHED_API_KEYS_TABLE.indexes) a2exec(a, idx);
    a.run(`INSERT INTO _meta(key, value) VALUES('apiKeysHashedVersion','1'),('apiKeysHashKid',?)`, [
      masterKeyId(MASTER),
    ]);
    const { clearApiKeyPrincipalCache } = await import("@/lib/auth/apiKeyPrincipal.js");
    clearApiKeyPrincipalCache();
  });

  const a2exec = (a, sql) => a.exec(sql);

  it("a moved key keeps its hash and authenticates into the target workspace", async () => {
    const { a, shared } = t;
    const { createApiKey } = await import("@/lib/users/apiKeyManagement.js");
    const { key, metadata } = await createApiKey(a.ctx, shared.id, { type: "service", name: "CI" });
    const a2 = await adapter();
    const before = a2.get(`SELECT keyHash, hashKid FROM apiKeys WHERE id = ?`, [metadata.id]);
    const res = await moveAs(a, shared.id, {
      targetWorkspaceId: a.personal,
      items: [{ type: "apiKey", id: metadata.id }],
    });
    expect(res.status).toBe(200);
    const row = a2.get(`SELECT workspaceId, keyHash, hashKid, prefix FROM apiKeys WHERE id = ?`, [
      metadata.id,
    ]);
    expect(row.workspaceId).toBe(a.personal);
    expect(row.keyHash).toBe(before.keyHash);
    expect(row.hashKid).toBe(before.hashKid);
    const { resolveApiKey, clearApiKeyPrincipalCache } = await import(
      "@/lib/auth/apiKeyPrincipal.js"
    );
    clearApiKeyPrincipalCache();
    const principal = await resolveApiKey(key);
    expect(principal).toMatchObject({ apiKeyId: metadata.id, workspaceId: a.personal });
  });
});

describe("workspace move: encrypted credentials", () => {
  beforeEach(async () => {
    await load("on");
    await clean();
    t = await seedTenancy();
    await db.updateSettings({ requireLogin: true });
    const a = await adapter();
    await establishEncryption(a, [t.shared.id, t.a.personal, t.b.personal]);
  });

  it("re-seals credentials under the target DEK; the source DEK no longer opens them", async () => {
    const { a, shared } = t;
    const conn = await db.createConnection(a.ctx, shared.id, {
      ...apiKeyConn("sealed"),
      providerSpecificData: { clientSecret: "psd-secret" },
    });
    const node = await db.createNode(a.ctx, shared.id, {
      id: "node-sealed",
      type: "openai-compatible",
      name: "N",
      prefix: "seal",
      baseUrl: "http://x",
    });
    await db.updateNode(a.ctx, node.id, { apiKey: "node-secret" });
    const res = await moveAs(a, shared.id, {
      targetWorkspaceId: a.personal,
      items: [
        { type: "connection", id: conn.id },
        { type: "node", id: node.id },
      ],
    });
    expect(res.status).toBe(200);
    const a2 = await adapter();
    const { loadMasterKey } = await import("@/lib/security/masterKey.js");
    const { prepareCredentialContext, decodeCredentialRowSync } = await import(
      "@/lib/db/helpers/credentialStorage.js"
    );
    const root = await loadMasterKey({ create: true });
    const ctx = prepareCredentialContext(a2, root);
    const connRow = a2.get(`SELECT * FROM providerConnections WHERE id = ?`, [conn.id]);
    expect(connRow.workspaceId).toBe(a.personal);
    expect(JSON.stringify(connRow)).not.toContain("sk-sealed");
    const opened = decodeCredentialRowSync(a2, connRow, ctx, { table: "providerConnections" });
    expect(opened.apiKey).toBe("sk-sealed");
    expect(opened.providerSpecificData.clientSecret).toBe("psd-secret");
    const nodeRow = a2.get(`SELECT * FROM providerNodes WHERE id = ?`, [node.id]);
    expect(decodeCredentialRowSync(a2, nodeRow, ctx, { table: "providerNodes" }).apiKey).toBe(
      "node-secret",
    );
    // Forged coordinates (the old workspace) fail authentication.
    expect(() =>
      decodeCredentialRowSync(a2, connRow, ctx, {
        table: "providerConnections",
        workspaceId: shared.id,
      }),
    ).toThrow();
    const { clearCredentialCache } = await import("@/lib/db/helpers/credentialStorage.js");
    clearCredentialCache(a2, t.a.personal);
  });
});

describe("workspace move: v1.0.0 Default-workspace adoption", () => {
  it("adopts ownerless rows into Default (fixture), then a moved Default connection routes for the target", async () => {
    // Fixture half: the frozen v1.0.0 DB migrates and adopts its ownerless
    // connection into the Default workspace.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
      const { runVersionedMigrations } = await import("@/lib/db/migrate.js");
      const { adoptOwnerlessRowsUnscoped } = await import("@/lib/db/repos/ownership.js");
      const fx = await createSqlJsAdapter(
        path.join(process.env.TOKENHOP_TEST_ROOT, "v1-yan701.sqlite"),
      );
      fx.exec(FIXTURE);
      runVersionedMigrations(fx);
      fx.run(
        `INSERT INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES('dw','Default','shared',?,?)`,
        [NOW, NOW],
      );
      fx.run(`INSERT INTO _meta(key, value) VALUES('defaultWorkspaceId','dw')`);
      expect(fx.transaction(() => adoptOwnerlessRowsUnscoped(fx))).toBeGreaterThanOrEqual(1);
      expect(
        fx.get(`SELECT workspaceId FROM providerConnections WHERE id = 'pc1'`).workspaceId,
      ).toBe("dw");
      fx.close();
    } finally {
      log.mockRestore();
    }

    // Routing half: a Default (shared) connection moved into the owner's
    // personal workspace still resolves for gateway principals there.
    await load("on");
    await clean();
    t = await seedTenancy();
    await db.updateSettings({ requireLogin: true });
    const { a, shared } = t;
    const a2 = await adapter();
    a2.run(`INSERT INTO _meta(key, value) VALUES('defaultWorkspaceId', ?)`, [shared.id]);
    const legacy = await db.createProviderConnectionUnscoped(apiKeyConn("legacy-default"));
    expect(await db.adoptOwnerlessUnscoped()).toBe(1);
    expect(legacy.workspaceId).toBe(shared.id);
    const res = await moveAs(a, shared.id, {
      targetWorkspaceId: a.personal,
      items: [{ type: "connection", id: legacy.id }],
    });
    expect(res.status).toBe(200);
    const { getProviderCredentials } = await import("@/sse/services/auth.js");
    const picked = await getProviderCredentials("openai", null, null, {
      principal: Object.freeze({
        workspaceId: a.personal,
        userId: a.user.id,
        via: "apiKey",
        apiKeyId: "ak_t",
      }),
    });
    expect(picked).toMatchObject({ connectionId: legacy.id, apiKey: "sk-legacy-default" });
    await clean();
  });
});
