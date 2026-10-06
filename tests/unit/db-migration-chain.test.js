// Verify schema migration chain runs correctly across versions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LEGACY } from "@/shared/brand";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

function resetAdapter() {
  if (!tempDir) return;
  const adapters = globalThis[Symbol.for(`tokenhop.dbAdapters.${process.pid}`)];
  const dataFile = path.join(tempDir, "db", "data.sqlite");
  try {
    adapters?.get(dataFile)?.instance?.close?.();
  } finally {
    adapters?.delete(dataFile);
  }
}

beforeEach(() => {
  resetAdapter();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-mig-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
});

afterEach(() => {
  resetAdapter();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Schema migrations", () => {
  it("fresh DB → applies migrations & stamps schemaVersion", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const db = await getAdapter();
    const row = db.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(parseInt(row.value, 10)).toBe(latestVersion());

    const tables = db.all(`SELECT name FROM sqlite_master WHERE type='table'`).map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "_meta",
        "settings",
        "providerConnections",
        "providerNodes",
        "proxyPools",
        "apiKeys",
        "combos",
        "kv",
        "usageHistory",
        "usageDaily",
        "requestDetails",
      ]),
    );
  });

  it("existing DB at older schemaVersion → re-applies pending migrations on restart", async () => {
    // 1st boot
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      ['{"foo":"bar"}'],
    );
    db.run(`UPDATE _meta SET value = '0' WHERE key = 'schemaVersion'`);

    // 2nd boot: full reset to simulate process restart
    resetAdapter();
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const db2 = await getAdapter2();
    const row = db2.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(parseInt(row.value, 10)).toBe(latestVersion());

    const settings = db2.get(`SELECT data FROM settings WHERE id=1`);
    // Existing data is kept; migration #3 only adds the pinned SAML issuer.
    expect(JSON.parse(settings.data)).toEqual({ foo: "bar", samlIssuer: LEGACY.samlIssuerDefault });
  });

  it("fresh DB + legacy db.json → imports data automatically", async () => {
    // Simulate user upgrading: place legacy JSON in DATA_DIR before first boot
    const legacy = {
      settings: { foo: "legacy-value" },
      apiKeys: [{ id: "k1", key: "abc", name: "test", createdAt: new Date().toISOString() }],
      modelAliases: { "gpt-4": "gpt-4-turbo" },
    };
    fs.writeFileSync(path.join(tempDir, "db.json"), JSON.stringify(legacy));

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const settings = db.get(`SELECT data FROM settings WHERE id=1`);
    expect(JSON.parse(settings.data)).toEqual({ foo: "legacy-value" });

    const keys = db.all(`SELECT * FROM apiKeys`);
    expect(keys).toHaveLength(1);
    expect(keys[0].key).toBe("abc");

    const aliases = db.all(`SELECT * FROM kv WHERE scope='modelAliases'`);
    expect(aliases).toHaveLength(1);
  });

  it("legacy import: duplicate combo names don't abort, and an aborted import retries (YAN-62)", async () => {
    const dbJson = path.join(tempDir, "db.json");
    const conn = { id: "c1", provider: "openai", authType: "apikey" };
    // Missing combo name → NOT NULL failure → MigrationAborted
    fs.writeFileSync(
      dbJson,
      JSON.stringify({ providerConnections: [conn], combos: [{ id: "x0", models: [] }] }),
    );
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    expect(db.all(`SELECT * FROM providerConnections`)).toHaveLength(0);

    // User fixes db.json (duplicate names are now tolerated) and restarts
    fs.writeFileSync(
      dbJson,
      JSON.stringify({
        providerConnections: [conn],
        combos: [
          { id: "x1", name: "fast", models: [] },
          { id: "x2", name: "fast", models: [] },
        ],
      }),
    );
    resetAdapter();
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const db2 = await getAdapter2();
    expect(db2.all(`SELECT id FROM providerConnections`)).toEqual([{ id: "c1" }]);
    expect(db2.all(`SELECT id FROM combos`)).toEqual([{ id: "x1" }]);
  });

  it("legacy import is skipped when the DB already holds user data (YAN-62)", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.run(
      `INSERT INTO combos(id, name, models, createdAt, updatedAt) VALUES('mine', 'mine', '[]', 'x', 'x')`,
    );

    fs.writeFileSync(
      path.join(tempDir, "db.json"),
      JSON.stringify({ combos: [{ id: "legacy", name: "legacy", models: [] }] }),
    );
    resetAdapter();
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const db2 = await getAdapter2();
    expect(db2.all(`SELECT id FROM combos`)).toEqual([{ id: "mine" }]);
  });

  it("migration 011 adds nullable instanceRoleSource idempotently with an idp-only CHECK (YAN-359)", async () => {
    const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
    const m011 = (await import("@/lib/db/migrations/011-sso-role-source.js")).default;
    const db = await createSqlJsAdapter(path.join(tempDir, "pre011.sqlite"));
    db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, instanceRole TEXT NOT NULL)`);
    db.run(`INSERT INTO users(id, instanceRole) VALUES('u0', 'admin')`);
    const cols = () =>
      db.all(`PRAGMA table_info(users)`).filter((c) => c.name === "instanceRoleSource");
    expect(cols()).toHaveLength(0);

    m011.up(db);
    m011.up(db); // idempotent: no duplicate-column error
    expect(cols()).toHaveLength(1);
    expect(cols()[0].notnull).toBe(0);
    expect(db.get(`SELECT instanceRoleSource AS s FROM users WHERE id = 'u0'`).s).toBeNull();

    db.run(`INSERT INTO users(id, instanceRole, instanceRoleSource) VALUES('u1', 'admin', NULL)`);
    db.run(`INSERT INTO users(id, instanceRole, instanceRoleSource) VALUES('u2', 'admin', 'idp')`);
    for (const bad of ["manual", "x"]) {
      expect(() =>
        db.run(`INSERT INTO users(id, instanceRole, instanceRoleSource) VALUES(?, 'admin', ?)`, [
          `bad-${bad}`,
          bad,
        ]),
      ).toThrow(/CHECK/i);
    }
    db.close();
  });

  it("fresh DB schema has users.instanceRoleSource (YAN-359)", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    expect(db.all(`PRAGMA table_info(users)`).map((c) => c.name)).toContain("instanceRoleSource");
  });

  it("auto-sync re-creates missing index when DB lacks it", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.exec(`DROP INDEX IF EXISTS idx_pn_type`);
    expect(db.all(`PRAGMA index_list(providerNodes)`).map((i) => i.name)).not.toContain(
      "idx_pn_type",
    );

    resetAdapter();
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const db2 = await getAdapter2();
    const idx = db2.all(`PRAGMA index_list(providerNodes)`).map((i) => i.name);
    expect(idx).toContain("idx_pn_type");
  });
});
