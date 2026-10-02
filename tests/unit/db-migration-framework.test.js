// YAN-352: the migration framework on every SQLite adapter this runtime has —
// frozen baseline, pre-migration backup, table rebuilds, rollback, no-op reruns.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FIXTURE = fs.readFileSync(path.join(__dirname, "../fixtures/db/v1.0.0.sql"), "utf-8");
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);

// Same gating as src/lib/db/driver.js. bun:sqlite only exists under Bun.
const ADAPTERS = [
  ["bun:sqlite", !!process.versions.bun, "bunSqliteAdapter.js", "createBunSqliteAdapter"],
  [
    "better-sqlite3",
    !process.versions.bun && nodeMajor < 24,
    "betterSqliteAdapter.js",
    "createBetterSqliteAdapter",
  ],
  [
    "node:sqlite",
    !process.versions.bun && (nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5)),
    "nodeSqliteAdapter.js",
    "createNodeSqliteAdapter",
  ],
  ["sql.js", true, "sqljsAdapter.js", "createSqlJsAdapter"],
];

let tempDir;
let opened = [];

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(process.env.TOKENHOP_TEST_ROOT, "mig-fw-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  for (const db of opened) {
    try {
      db.close();
    } catch {}
  }
  opened = [];
  vi.restoreAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const tableNames = (db) =>
  db
    .all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .map((t) => t.name)
    .sort();
const indexNames = (db, table) =>
  db
    .all(`PRAGMA index_list(${table})`)
    .map((i) => i.name)
    .filter((n) => !n.startsWith("sqlite_"))
    .sort();
const columns = (db, table) =>
  db.all(`PRAGMA table_info(${table})`).map(({ name, type, notnull, pk }) => ({
    name,
    type,
    notnull,
    pk,
  }));
const version = (db) => Number(db.get(`SELECT value FROM _meta WHERE key='schemaVersion'`).value);

for (const [driver, available, file, factory] of ADAPTERS) {
  describe.skipIf(!available)(`migration framework on ${driver}`, () => {
    async function open(name = "data.sqlite") {
      const mod = await import(`@/lib/db/adapters/${file}`);
      const db = await mod[factory](path.resolve(tempDir, name));
      opened.push(db);
      return db;
    }

    it("fresh DB: the chain alone builds exactly TABLES (frozen baseline + migrations)", async () => {
      const { runVersionedMigrations } = await import("@/lib/db/migrate.js");
      const { latestVersion } = await import("@/lib/db/migrations/index.js");
      const { TABLES, buildCreateTableSql } = await import("@/lib/db/schema.js");

      const chain = await open("chain.sqlite");
      runVersionedMigrations(chain);
      expect(version(chain)).toBe(latestVersion());

      const declared = await open("declared.sqlite");
      for (const [name, def] of Object.entries(TABLES)) {
        declared.exec(buildCreateTableSql(name, def));
        for (const idx of def.indexes || []) declared.exec(idx);
      }
      expect(tableNames(chain)).toEqual(tableNames(declared));
      for (const t of Object.keys(TABLES)) {
        expect(columns(chain, t), t).toEqual(columns(declared, t));
        expect(indexNames(chain, t), t).toEqual(indexNames(declared, t));
      }
    });

    it("v1.0.0 fixture: upgrades cleanly, takes a backup, and a rerun is a no-op", async () => {
      const { runMigrationOnce, runVersionedMigrations } = await import("@/lib/db/migrate.js");
      const { MIGRATIONS } = await import("@/lib/db/migrations/index.js");
      const { BACKUPS_DIR } = await import("@/lib/db/paths.js");
      fs.rmSync(BACKUPS_DIR, { recursive: true, force: true });

      const db = await open();
      db.exec(FIXTURE);
      const pending = { version: 99, name: "noop", up: vi.fn() };
      MIGRATIONS.push(pending);
      try {
        await runMigrationOnce(db);
      } finally {
        MIGRATIONS.pop();
      }
      expect(pending.up).toHaveBeenCalledOnce();
      expect(version(db)).toBe(99);
      expect(db.all(`SELECT id FROM combos ORDER BY id`)).toEqual([{ id: "c1" }, { id: "c2" }]);
      expect(db.get(`SELECT key FROM apiKeys`).key).toBe("sk-th-legacy");

      const dirs = fs.readdirSync(BACKUPS_DIR);
      expect(dirs).toHaveLength(1);
      expect(dirs[0]).toMatch(/^schema-3-to-99-/);
      const bak = await open(path.join(BACKUPS_DIR, dirs[0], "data.sqlite"));
      expect(bak.get(`SELECT value FROM _meta WHERE key='schemaVersion'`).value).toBe("3");
      expect(bak.get(`SELECT COUNT(*) AS c FROM combos`).c).toBe(2);
      expect(tableNames(bak)).not.toContain("requestDetails");

      const before = db.all(`SELECT * FROM sqlite_master ORDER BY name`);
      expect(runVersionedMigrations(db, [...MIGRATIONS, pending]).applied).toBe(0);
      expect(db.all(`SELECT * FROM sqlite_master ORDER BY name`)).toEqual(before);
    });

    it("backup gate: a fresh DB takes none; a legacy unstamped (v0) DB is backed up and kept", async () => {
      const { runMigrationOnce } = await import("@/lib/db/migrate.js");
      const { latestVersion } = await import("@/lib/db/migrations/index.js");
      const { BACKUPS_DIR } = await import("@/lib/db/paths.js");
      const backups = () => (fs.existsSync(BACKUPS_DIR) ? fs.readdirSync(BACKUPS_DIR) : []);
      fs.rmSync(BACKUPS_DIR, { recursive: true, force: true });

      const fresh = await open("fresh.sqlite");
      await runMigrationOnce(fresh);
      expect(version(fresh)).toBe(latestVersion());
      expect(backups()).toEqual([]);

      const legacy = await open("legacy.sqlite");
      legacy.exec(FIXTURE.replace(/^INSERT INTO _meta.*$/m, ""));
      await runMigrationOnce(legacy);
      expect(version(legacy)).toBe(latestVersion());
      expect(legacy.get(`SELECT COUNT(*) AS c FROM combos`).c).toBe(2);
      expect(backups()).toEqual([expect.stringMatching(/^schema-0-to-/)]);
    });

    it("an up-to-date DB takes no backup", async () => {
      const { runMigrationOnce, runVersionedMigrations } = await import("@/lib/db/migrate.js");
      const { BACKUPS_DIR } = await import("@/lib/db/paths.js");

      const db = await open();
      db.exec(FIXTURE);
      runVersionedMigrations(db);
      fs.rmSync(BACKUPS_DIR, { recursive: true, force: true });
      await runMigrationOnce(db);
      expect(fs.existsSync(BACKUPS_DIR) ? fs.readdirSync(BACKUPS_DIR) : []).toEqual([]);
    });

    it("a failing migration rolls back its changes and leaves schemaVersion untouched", async () => {
      const { runVersionedMigrations } = await import("@/lib/db/migrate.js");
      const db = await open();
      db.exec(FIXTURE);
      const broken = {
        version: 4,
        name: "broken",
        up(m) {
          m.exec(`CREATE TABLE half (id TEXT)`);
          m.run(`DELETE FROM combos`);
          throw new Error("boom");
        },
      };
      expect(() => runVersionedMigrations(db, [broken])).toThrow("boom");
      expect(version(db)).toBe(3);
      expect(tableNames(db)).not.toContain("half");
      expect(db.get(`SELECT COUNT(*) AS c FROM combos`).c).toBe(2);
      expect(db.get(`PRAGMA foreign_keys`).foreign_keys).toBe(1);
    });

    it("sample 004 rebuild: combos gets UNIQUE (workspaceId, name), keeping rows, indexes and FKs", async () => {
      const { runVersionedMigrations } = await import("@/lib/db/migrate.js");
      const { rebuildTable, tableHasColumn, backfill } = await import(
        "@/lib/db/migrations/helpers.js"
      );
      const db = await open();
      db.exec(FIXTURE);
      db.exec(
        `CREATE TABLE comboUses (id TEXT PRIMARY KEY, comboId TEXT REFERENCES combos(id) ON DELETE CASCADE)`,
      );
      db.run(`INSERT INTO comboUses VALUES ('u1', 'c1')`);

      const sample = {
        version: 4,
        name: "combos-workspace-unique",
        up(m) {
          if (tableHasColumn(m, "combos", "workspaceId")) return;
          rebuildTable(m, "combos", {
            columns: {
              id: "TEXT PRIMARY KEY",
              workspaceId: "TEXT NOT NULL DEFAULT 'default'",
              name: "TEXT NOT NULL",
              kind: "TEXT",
              models: "TEXT NOT NULL",
              createdAt: "TEXT NOT NULL",
              updatedAt: "TEXT NOT NULL",
            },
            constraints: ["UNIQUE (workspaceId, name)"],
            indexes: ["CREATE INDEX IF NOT EXISTS idx_combo_name ON combos(name)"],
          });
          backfill(m, `UPDATE combos SET workspaceId = ? WHERE workspaceId = 'default'`, ["ws1"]);
        },
      };
      runVersionedMigrations(db, [sample]);

      expect(version(db)).toBe(4);
      expect(db.all(`SELECT id, workspaceId FROM combos ORDER BY id`)).toEqual([
        { id: "c1", workspaceId: "ws1" },
        { id: "c2", workspaceId: "ws1" },
      ]);
      expect(indexNames(db, "combos")).toContain("idx_combo_name");
      // The CASCADE child survived the DROP of its parent.
      expect(db.all(`SELECT * FROM comboUses`)).toEqual([{ id: "u1", comboId: "c1" }]);
      expect(db.all(`PRAGMA foreign_key_list(comboUses)`)[0].table).toBe("combos");
      expect(db.get(`PRAGMA foreign_keys`).foreign_keys).toBe(1);

      // New composite unique holds; the same name in another workspace is fine.
      const insert = (id, ws) =>
        db.run(
          `INSERT INTO combos(id, workspaceId, name, models, createdAt, updatedAt) VALUES(?, ?, 'fast', '[]', 'x', 'x')`,
          [id, ws],
        );
      expect(() => insert("c3", "ws1")).toThrow(/UNIQUE/);
      insert("c4", "ws2");

      // Rerunning the migration body is a no-op.
      sample.up(db);
      expect(db.get(`SELECT COUNT(*) AS c FROM combos`).c).toBe(3);
    });

    it("a rebuild leaving foreign key violations rolls back", async () => {
      const { runVersionedMigrations } = await import("@/lib/db/migrate.js");
      const { rebuildTable } = await import("@/lib/db/migrations/helpers.js");
      const db = await open();
      db.exec(FIXTURE);
      db.exec(`CREATE TABLE comboUses (id TEXT PRIMARY KEY, comboId TEXT REFERENCES combos(id))`);
      db.run(`INSERT INTO comboUses VALUES ('u1', 'c1')`);

      const dropsParent = {
        version: 4,
        name: "drops-parent-row",
        up(m) {
          rebuildTable(
            m,
            "combos",
            {
              columns: {
                id: "TEXT PRIMARY KEY",
                name: "TEXT UNIQUE NOT NULL",
                kind: "TEXT",
                models: "TEXT NOT NULL",
                createdAt: "TEXT NOT NULL",
                updatedAt: "TEXT NOT NULL",
              },
            },
            `SELECT id, name, kind, models, createdAt, updatedAt FROM combos WHERE id != 'c1'`,
          );
        },
      };
      expect(() => runVersionedMigrations(db, [dropsParent])).toThrow(/foreign key/);
      expect(version(db)).toBe(3);
      expect(db.get(`SELECT COUNT(*) AS c FROM combos`).c).toBe(2);
    });
  });
}

describe("exportDb / importDb schemaVersion", () => {
  it("export carries schemaVersion; import refuses a newer or malformed one", async () => {
    const { exportDb, importDb } = await import("@/lib/db/index.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const dump = await exportDb();
    expect(dump.schemaVersion).toBe(latestVersion());

    await expect(importDb({ ...dump, schemaVersion: latestVersion() + 1 })).rejects.toThrow(
      /newer version/,
    );
    await expect(importDb({ ...dump, schemaVersion: "3" })).rejects.toThrow(/schemaVersion/);
    await importDb(dump);
    const { schemaVersion: _omit, ...legacy } = dump;
    await importDb(legacy);
  });
});
