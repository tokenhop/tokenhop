// YAN-364: workspace-scoped combos, aliases, kv adoption and migration 009.
// Critical only: per-space isolation, IDOR negatives (repo + route), strategy
// namespaces, kv edge keys, the v1.0.0 migration fixture.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute, denied, seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const FIXTURE = fs.readFileSync(path.join(__dirname, "../fixtures/db/v1.0.0.sql"), "utf-8");

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
  db = await import("@/lib/db/index.js");
}

// Call a route handler as a seeded user (session cookie on request + jar).
async function as(seeded, handler, url, opts = {}) {
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  const token = await createDashboardAuthToken({
    sub: seeded.user.id,
    sv: seeded.user.sessionVersion,
    wid: seeded.ctx.activeWorkspaceId,
  });
  jar.cookie = `auth_token=${token}`;
  try {
    return await callRoute(handler, url, { as: seeded, ...opts });
  } finally {
    jar.cookie = "";
  }
}

const adapter = () => import("@/lib/db/driver.js").then((m) => m.getAdapter());

// Point defaultWorkspaceId at the shared workspace (adoption target).
async function setDefaultWorkspace(id) {
  const a = await adapter();
  a.run(
    `INSERT INTO _meta(key, value) VALUES('defaultWorkspaceId', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [id],
  );
}

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("migration 009 workspace-scoped combos", () => {
  it("keeps v1.0.0 rows, enforces UNIQUE(workspaceId,name) + legacy NULL-name uniqueness, reruns as a no-op", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
      const { runVersionedMigrations } = await import("@/lib/db/migrate.js");
      const m009 = (await import("@/lib/db/migrations/009-workspace-scoped-combos.js")).default;
      const fx = await createSqlJsAdapter(
        path.join(process.env.TOKENHOP_TEST_ROOT, "v1-yan364.sqlite"),
      );
      fx.exec(FIXTURE);
      runVersionedMigrations(fx);

      // Rows survive the rebuild.
      expect(fx.get(`SELECT COUNT(*) AS n FROM combos`).n).toBe(2);
      expect(fx.get(`SELECT name FROM combos WHERE id = 'c1'`).name).toBe("fast");

      // Idempotency guard: a second up() is a no-op.
      m009.up(fx);
      expect(fx.get(`SELECT COUNT(*) AS n FROM combos`).n).toBe(2);

      fx.run(`INSERT INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES
        ('wa', 'A', 'shared', '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z'),
        ('wb', 'B', 'shared', '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z')`);

      // Same name in two workspaces coexists…
      fx.run(`INSERT INTO combos(id, name, kind, models, createdAt, updatedAt, workspaceId) VALUES
        ('x1', 'panel', NULL, '[]', '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z', 'wa'),
        ('x2', 'panel', NULL, '[]', '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z', 'wb')`);
      // …same workspace rejects a duplicate.
      expect(() =>
        fx.run(`INSERT INTO combos(id, name, kind, models, createdAt, updatedAt, workspaceId) VALUES
          ('x3', 'panel', NULL, '[]', '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z', 'wa')`),
      ).toThrow();
      // Legacy rows (workspaceId NULL) stay globally name-unique at DB level.
      expect(() =>
        fx.run(`INSERT INTO combos(id, name, kind, models, createdAt, updatedAt, workspaceId) VALUES
          ('x4', 'fast', NULL, '[]', '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z', NULL)`),
      ).toThrow();

      // sqlite_master carries the per-workspace UNIQUE and the partial index.
      const combosSql = fx.get(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'combos'`,
      ).sql;
      expect(combosSql).toContain("UNIQUE (workspaceId, name)");
      const legacySql = fx.get(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_combo_name_legacy'`,
      ).sql;
      expect(legacySql).toContain("WHERE workspaceId IS NULL");
      fx.close();
    } finally {
      log.mockRestore();
    }
  });
});

describe("switch on: combos and aliases are per-workspace", () => {
  beforeEach(async () => {
    await load("on");
    const a = await adapter();
    a.run(`DELETE FROM combos`);
    a.run(`DELETE FROM workspaceSettings`);
    a.run(`DELETE FROM kv WHERE scope IN ('modelAliases', 'customModels', 'disabledModels')`);
    t = await seedTenancy();
  });

  it("same combo name in two workspaces coexists; a duplicate inside one workspace is rejected", async () => {
    const { a, b } = t;
    const mine = await db.createCombo(a.ctx, a.personal, {
      name: "panel",
      models: ["openai/gpt-4o"],
    });
    const theirs = await db.createCombo(b.ctx, b.personal, {
      name: "panel",
      models: ["anthropic/claude-3"],
    });
    expect(mine.workspaceId).toBe(a.personal);
    expect(theirs.workspaceId).toBe(b.personal);
    await expect(
      db.createCombo(a.ctx, a.personal, { name: "panel", models: [] }),
    ).rejects.toThrow();
  });

  it("B cannot list, get, update or delete A's combos or aliases (repo + routes)", async () => {
    const { a, b } = t;
    const combo = await db.createCombo(a.ctx, a.personal, {
      name: "mine",
      models: ["openai/gpt-4o"],
    });
    await db.setModelAlias(a.ctx, a.personal, "quick", "openai/gpt-4o");

    // Repo negatives: foreign id reads as NOT_FOUND, lists hide A's rows.
    expect(await denied(db.getCombo(b.ctx, combo.id))).toBe(true);
    expect(await denied(db.updateCombo(b.ctx, combo.id, { name: "x" }))).toBe(true);
    expect(await denied(db.deleteCombo(b.ctx, combo.id))).toBe(true);
    expect((await db.listCombos(b.ctx, b.personal)).map((c) => c.id)).not.toContain(combo.id);
    expect(await denied(db.getModelAliases(b.ctx, a.personal))).toBe(true);

    // Route negatives.
    const combosRoute = await import("@/app/api/combos/route.js");
    const comboRoute = await import("@/app/api/combos/[id]/route.js");
    const aliasRoute = await import("@/app/api/models/alias/route.js");
    const bList = await (await as(b, combosRoute.GET, "/api/combos")).json();
    expect((bList.combos || []).map((c) => c.id)).not.toContain(combo.id);
    expect(
      (
        await as(b, comboRoute.GET, `/api/combos/${combo.id}`, {
          params: { id: combo.id },
        })
      ).status,
    ).toBe(404);
    expect(await (await as(b, aliasRoute.GET, "/api/models/alias")).json()).toEqual({
      aliases: {},
    });
  });

  // Heavy route: pulls the probe chain (chat.js + executors). ~2-3s alone;
  // under the full suite's forks contention it can exceed the 5s default.
  // Explicit timeout keeps it deterministic without weakening any assertion.
  it("B gets a 404 on A's combo test and headroom routes", async () => {
    const { a, b } = t;
    const combo = await db.createCombo(a.ctx, a.personal, {
      name: "probe",
      models: ["openai/gpt-4o"],
    });
    const testRoute = await import("@/app/api/combos/[id]/test/route.js");
    const headroomRoute = await import("@/app/api/combos/[id]/headroom/route.js");
    // Positive control: the owner reaches its own combo, so B's 404 is isolation.
    expect(
      (
        await as(a, headroomRoute.GET, `/api/combos/${combo.id}/headroom`, {
          params: { id: combo.id },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await as(b, testRoute.POST, `/api/combos/${combo.id}/test`, {
          params: { id: combo.id },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await as(b, headroomRoute.GET, `/api/combos/${combo.id}/headroom`, {
          params: { id: combo.id },
        })
      ).status,
    ).toBe(404);
  }, 30_000);

  it("B with no override never inherits the blob's name-keyed strategy; B's own id entry wins", async () => {
    const { a, b } = t;
    await db.createCombo(a.ctx, a.personal, { name: "panel", models: [] });
    const panelB = await db.createCombo(b.ctx, b.personal, { name: "panel", models: [] });
    // Instance blob holds Default's/A's strategy, name-keyed (pre-adoption shape).
    await db.updateSettings({
      comboStrategies: { panel: { fallbackStrategy: "fusion", judgeModel: "x/y" } },
    });
    const { comboStrategyFor } = await import("@/lib/comboKeys.js");

    const effB = await db.getEffectivePreferences({
      workspaceId: b.personal,
      userId: b.user.id,
    });
    expect(effB.comboStrategies).toEqual({});
    expect(comboStrategyFor(effB, { workspaceId: b.personal }, panelB).strategy).toBe("fallback");

    // B's own id-keyed entry is honored; the name entry stays invisible.
    await db.updateWorkspaceComboStrategies(b.ctx, b.personal, (s) => ({
      ...s,
      [panelB.id]: { fallbackStrategy: "round-robin" },
    }));
    const effB2 = await db.getEffectivePreferences({
      workspaceId: b.personal,
      userId: b.user.id,
    });
    expect(effB2.comboStrategies).toEqual({ [panelB.id]: { fallbackStrategy: "round-robin" } });
    expect(comboStrategyFor(effB2, { workspaceId: b.personal }, panelB).strategy).toBe(
      "round-robin",
    );
  });
});

describe("kv adoption (bootstrap)", () => {
  beforeEach(async () => {
    await load("on");
    const a = await adapter();
    a.run(`DELETE FROM combos`);
    a.run(`DELETE FROM workspaceSettings`);
    a.run(`DELETE FROM kv WHERE scope IN ('modelAliases', 'customModels', 'disabledModels')`);
    t = await seedTenancy();
    await setDefaultWorkspace(t.shared.id);
  });

  it("a bare key colliding with a prefixed key loses: the prefixed value wins", async () => {
    const a = await adapter();
    a.run(
      `INSERT INTO kv(scope, key, value) VALUES('modelAliases', 'ws:shared-ws/gpt', '"openai/adopted"')`.replace(
        "shared-ws",
        t.shared.id,
      ),
    );
    a.run(`INSERT INTO kv(scope, key, value) VALUES('modelAliases', 'gpt', '"openai/bare"')`);
    // INSERT OR IGNORE: no new rows on a collision (0 changes), but the bare
    // loser row is deleted below (asserted separately).
    expect(await db.adoptOwnerlessUnscoped()).toBe(0);
    expect(await db.getModelAliases(t.a.ctx, t.shared.id)).toEqual({ gpt: "openai/adopted" });
    // The bare loser is gone; no second bare row lingers.
    expect(
      a.get(`SELECT 1 AS x FROM kv WHERE scope = 'modelAliases' AND key = 'gpt'`),
    ).toBeUndefined();
  });

  it("legacy ws:foo (no slash) is bare data and adopts to ws:<default>/ws:foo", async () => {
    const a = await adapter();
    a.run(`INSERT INTO kv(scope, key, value) VALUES('modelAliases', 'ws:foo', '"openai/noslash"')`);
    expect(await db.adoptOwnerlessUnscoped()).toBeGreaterThan(0);
    const row = a.get(
      `SELECT value FROM kv WHERE scope = 'modelAliases' AND key = 'ws:${t.shared.id}/ws:foo'`,
    );
    expect(JSON.parse(row.value)).toBe("openai/noslash");
  });

  it("keys containing % or _ stay isolated between workspaces", async () => {
    const { a, b } = t;
    await db.setModelAlias(a.ctx, a.personal, "a_b", "openai/under-a");
    await db.setModelAlias(a.ctx, a.personal, "a%b", "openai/pct-a");
    await db.setModelAlias(b.ctx, b.personal, "aXB", "openai/under-b"); // would match a_b under LIKE _
    await db.setModelAlias(b.ctx, b.personal, "a*b", "openai/star-b"); // would match a%b under LIKE %
    expect(await db.getModelAliases(a.ctx, a.personal)).toEqual({
      a_b: "openai/under-a",
      "a%b": "openai/pct-a",
    });
    expect(await db.getModelAliases(b.ctx, b.personal)).toEqual({
      aXB: "openai/under-b",
      "a*b": "openai/star-b",
    });
  });

  it("single-user legacy reads still see the aliases after bootstrap (default-prefixed, stripped bare)", async () => {
    await db.setModelAliasUnscoped("quick", "openai/gpt-4o");
    await db.setModelAliasUnscoped("deep_seek", "anthropic/claude-3");
    expect(await db.getModelAliasesUnscoped()).toEqual({
      quick: "openai/gpt-4o",
      deep_seek: "anthropic/claude-3",
    });
    // Switch off: same reader, same bare shape.
    await load("off");
    const off = await import("@/lib/db/index.js");
    expect(await off.getModelAliasesUnscoped()).toEqual({
      quick: "openai/gpt-4o",
      deep_seek: "anthropic/claude-3",
    });
  });
  it("ws: keys stay valid on the legacy unscoped path (no repo 400) and land in Default", async () => {
    await db.setModelAliasUnscoped("ws:foo", "openai/legacy");
    expect(await db.getModelAliasesUnscoped()).toMatchObject({ "ws:foo": "openai/legacy" });
    await db.disableModelsUnscoped("ws:foo", ["m1"]);
    expect(await db.getDisabledByProviderUnscoped("ws:foo")).toEqual(["m1"]);
  });
});

describe("hashed-path config import (applyGatewayKeySnapshot)", () => {
  // YAN-364 decision 13: a v2 snapshot's combos (exported with no workspaceId)
  // must land in the Default workspace on apply — no NULL-workspaceId combos
  // on a hashed (multi-user) instance.
  it("adopts imported combos into Default in-transaction", async () => {
    await load("on");
    const off = await import("@/lib/db/index.js");
    const { masterKeyId } = await import("@/lib/security/masterKey.js");
    const MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));
    const KID = masterKeyId(MASTER);
    const NOWX = "2026-10-05T00:00:00.000Z";
    const a = await adapter();
    a.exec("DROP TABLE IF EXISTS apiKeys");
    a.exec(`CREATE TABLE apiKeys (
      id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      userId TEXT REFERENCES users(id) ON DELETE CASCADE,
      createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
      keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
      machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
      revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
      expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
    a.exec(
      `DELETE FROM memberships; DELETE FROM identities; DELETE FROM workspaces; DELETE FROM users;
       DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid','defaultWorkspaceId');
       DELETE FROM combos; DELETE FROM providerConnections; DELETE FROM providerNodes`,
    );
    a.run(
      `INSERT INTO users(id, email, username, displayName, instanceRole, status, passwordHash, sessionVersion, createdAt, updatedAt, lastLoginAt)
       VALUES('snap-owner', 'snap-owner@x.test', 'snap-owner', 'snap-owner', 'owner', 'active', 'hashedsecret', 1, ?, ?, NULL)`,
      [NOWX, NOWX],
    );
    a.run(
      `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES('snap-ws', 'Default', 'shared', 'snap-owner', ?, ?)`,
      [NOWX, NOWX],
    );
    a.run(
      `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES('snap-ws', 'snap-owner', 'owner', 'manual', ?)`,
      [NOWX],
    );
    a.run(
      `INSERT INTO _meta(key, value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?), ('defaultWorkspaceId','snap-ws')`,
      [KID],
    );
    // Legacy combos in the live DB, exported without workspaceId (snapshot shape).
    a.run(
      `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES
        ('snap-c1', 'fast', NULL, '[]', ?, ?),
        ('snap-c2', 'smart', NULL, '[]', ?, ?)`,
      [NOWX, NOWX, NOWX, NOWX],
    );

    const snapshot = await off.exportDb();
    expect(snapshot.apiKeyStorage?.storage).toBe("hashed");
    expect(snapshot.combos.map((c) => c.id).sort()).toEqual(["snap-c1", "snap-c2"]);

    a.run(`DELETE FROM combos`);
    await off.importDb(structuredClone(snapshot), { masterKey: MASTER });

    const rows = a.all(`SELECT id, workspaceId FROM combos ORDER BY id`);
    expect(rows).toEqual([
      { id: "snap-c1", workspaceId: "snap-ws" },
      { id: "snap-c2", workspaceId: "snap-ws" },
    ]);
    expect(a.get(`SELECT 1 AS x FROM combos WHERE workspaceId IS NULL`)).toBeUndefined();
  });
});

describe("portable config + unscoped rename/delete never cross workspaces", () => {
  const NOW0 = "2026-10-05T00:00:00Z";
  const UUID_SHAPED_NAME = "11111111-2222-4333-8444-555555555555";

  async function seedThree() {
    const a = await adapter();
    a.run(`DELETE FROM combos`);
    a.run(`DELETE FROM workspaceSettings`);
    await setDefaultWorkspace(t.shared.id);
    // Workspaces row first: combos reference it.
    a.run(
      `INSERT INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES('f-ws', 'F', 'shared', ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [NOW0, NOW0],
    );
    // models differ per row: the portable doc strips ids, so the member list
    // is what identifies which workspace's combo a doc entry came from.
    const ins = (id, name, ws, models = "[]") =>
      a.run(
        `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt, workspaceId) VALUES(?, ?, NULL, ?, ?, ?, ?)`,
        [id, name, models, NOW0, NOW0, ws],
      );
    ins("d-panel", "panel", t.shared.id, '["default/model"]'); // Default
    ins("f-panel", "panel", "f-ws", '["foreign/model"]'); // foreign, same name
    ins("orphan", "orphan", null); // pre-bootstrap ownerless
  }

  const setStrategies = async (ws, comboStrategies) => {
    const a = await adapter();
    a.run(
      `INSERT INTO workspaceSettings(workspaceId, data, updatedAt) VALUES(?, ?, ?)
       ON CONFLICT(workspaceId) DO UPDATE SET data = excluded.data`,
      [ws, JSON.stringify({ comboStrategies }), NOW0],
    );
  };
  const strategiesOf = async (ws) => {
    const a = await adapter();
    return JSON.parse(
      a.get(`SELECT data FROM workspaceSettings WHERE workspaceId = ?`, [ws])?.data ?? "{}",
    ).comboStrategies;
  };

  beforeEach(async () => {
    await load("on");
    const a = await adapter();
    a.run(`DELETE FROM memberships`);
    t = await seedTenancy();
    seedThree();
  });

  it("exportConfig/getConfigState carry Default + ownerless only; foreign same-name excluded, dup names collapse", async () => {
    const { exportConfig, getConfigState } = await import("@/lib/db/configExport.js");
    for (const doc of [await exportConfig(), await getConfigState()]) {
      const panels = doc.combos.filter((c) => c.name === "panel");
      expect(panels).toHaveLength(1);
      expect(panels[0].models).toEqual(["default/model"]);
      expect(JSON.stringify(doc.combos)).not.toContain("foreign/model");
      expect(doc.combos.map((c) => c.name)).toContain("orphan");
    }
    // A stale ownerless duplicate that sorts BEFORE the Default row (older
    // createdAt, lower sortOrder) must still lose: Default wins regardless of
    // order. The raw ORDER BY puts it first, which is what proves preference.
    const a = await adapter();
    a.run(
      `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt, sortOrder) VALUES('orphan-panel', 'panel', NULL, '["stale/model"]', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z', -5)`,
    );
    const firstRaw = a.get(
      `SELECT id FROM combos WHERE name = 'panel' AND (workspaceId IS NULL OR workspaceId = ?) ORDER BY sortOrder IS NULL, sortOrder ASC, createdAt ASC, id ASC`,
      [t.shared.id],
    );
    expect(firstRaw.id).toBe("orphan-panel");
    for (const doc of [await exportConfig(), await getConfigState()]) {
      const dup = doc.combos.filter((c) => c.name === "panel");
      expect(dup).toHaveLength(1);
      expect(dup[0].models).toEqual(["default/model"]);
    }
  });

  it("updateComboUnscoped rename moves the blob entry only; workspace id-keyed rows stay untouched", async () => {
    await setStrategies(t.shared.id, { "d-panel": { fallbackStrategy: "fusion" } });
    await setStrategies("f-ws", { "f-panel": { fallbackStrategy: "round-robin" } });
    const a = await adapter();
    a.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [JSON.stringify({ comboStrategies: { panel: { fallbackStrategy: "weighted" } } })],
    );

    await db.updateComboUnscoped("d-panel", { name: "panel-renamed" });

    // Own workspace row keeps its id key (renames are strategy-preserving);
    // the foreign row is untouched.
    expect(await strategiesOf(t.shared.id)).toEqual({
      "d-panel": { fallbackStrategy: "fusion" },
    });
    expect(await strategiesOf("f-ws")).toEqual({
      "f-panel": { fallbackStrategy: "round-robin" },
    });
    // Blob (name-keyed) migrated.
    const blob = JSON.parse(a.get(`SELECT data FROM settings WHERE id = 1`).data);
    expect(blob.comboStrategies).toEqual({
      "panel-renamed": { fallbackStrategy: "weighted" },
    });
  });

  it("a UUID-shaped blob key renames like any name; workspace id entries stay untouched", async () => {
    // Blobs are name-keyed: a UUID-looking strategy key is a legal combo name
    // and must migrate on rename. Workspace rows key ids-only and are never
    // rewritten by the cascade — even when the names look identical.
    await setStrategies(t.shared.id, {
      [UUID_SHAPED_NAME]: { fallbackStrategy: "fusion" },
    });
    await setStrategies("f-ws", { [UUID_SHAPED_NAME]: { fallbackStrategy: "weighted" } });
    const a = await adapter();
    a.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [JSON.stringify({ comboStrategies: { [UUID_SHAPED_NAME]: { fallbackStrategy: "fusion" } } })],
    );
    a.run(
      `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt, workspaceId) VALUES('combo-x', ?, NULL, '[]', ?, ?, ?)`,
      [UUID_SHAPED_NAME, NOW0, NOW0, t.shared.id],
    );

    // Renaming X renames the blob's UUID-looking entry (legal name key);
    // id-keyed workspace rows are never touched by the cascade.
    await db.updateComboUnscoped("combo-x", { name: "renamed-away" });
    const blob = JSON.parse(a.get(`SELECT data FROM settings WHERE id = 1`).data);
    expect(blob.comboStrategies).toEqual({
      "renamed-away": { fallbackStrategy: "fusion" },
    });
    expect(await strategiesOf(t.shared.id)).toEqual({
      [UUID_SHAPED_NAME]: { fallbackStrategy: "fusion" },
    });

    // Deleting X drops its own id entry and nothing else.
    await db.updateWorkspaceComboStrategies(t.a.ctx, t.shared.id, (m) => ({
      ...m,
      "combo-x": { fallbackStrategy: "weighted" },
    }));
    await db.deleteComboUnscoped("combo-x");
    expect(await strategiesOf(t.shared.id)).toEqual({
      [UUID_SHAPED_NAME]: { fallbackStrategy: "fusion" },
    });
    expect(await strategiesOf("f-ws")).toEqual({
      [UUID_SHAPED_NAME]: { fallbackStrategy: "weighted" },
    });
  });
});

describe("applyConfig stamps imported combos into Default", () => {
  it("a new imported combo lands in Default (visible to export), a foreign same-name combo is never matched", async () => {
    await load("on");
    t = await seedTenancy();
    const a = await adapter();
    a.run(`DELETE FROM combos`);
    await setDefaultWorkspace(t.shared.id);
    const NOWX = "2026-10-05T00:00:00Z";
    a.run(
      `INSERT INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES('f-ws2', 'F2', 'shared', ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [NOWX, NOWX],
    );
    a.run(
      `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt, workspaceId) VALUES('fx', 'shared-name', NULL, '["foreign/m"]', ?, ?, 'f-ws2')`,
      [NOWX, NOWX],
    );
    const { applyConfig, exportConfig } = await import("@/lib/db/configExport.js");
    await applyConfig({
      settings: {},
      combos: [
        { name: "shared-name", kind: null, models: ["imported/m"] },
        { name: "brand-new", kind: null, models: ["imported/n"] },
      ],
      pricingOverrides: {},
    });
    // Foreign row untouched; imports became Default rows (not ownerless).
    expect(JSON.parse(a.get(`SELECT models FROM combos WHERE id = 'fx'`).models)).toEqual([
      "foreign/m",
    ]);
    const imported = a.all(`SELECT name, workspaceId FROM combos WHERE id <> 'fx' ORDER BY name`);
    expect(imported).toEqual([
      { name: "brand-new", workspaceId: t.shared.id },
      { name: "shared-name", workspaceId: t.shared.id },
    ]);
    const names = (await exportConfig()).combos.map((c) => c.name).sort();
    expect(names).toEqual(["brand-new", "shared-name"]);
  });
});

describe("switch off: legacy name-keyed strategy unchanged", () => {
  it("a principal-shaped ctx still gets the blob's name-keyed strategy", async () => {
    await load("off");
    const off = await import("@/lib/db/index.js");
    await off.updateSettings({
      comboStrategies: { panel: { fallbackStrategy: "fusion", judgeModel: "j/m" } },
    });
    const { comboStrategyFor } = await import("@/lib/comboKeys.js");
    const eff = await off.getEffectivePreferences({
      workspaceId: "any-ws",
      userId: "any-user",
    });
    expect(eff.comboStrategies).toEqual({
      panel: { fallbackStrategy: "fusion", judgeModel: "j/m" },
    });
    const resolved = comboStrategyFor(
      eff,
      { workspaceId: "any-ws" },
      {
        id: "cX",
        name: "panel",
      },
    );
    expect(resolved.strategy).toBe("fusion");
    expect(resolved.judgeModel).toBe("j/m");
  });
});
