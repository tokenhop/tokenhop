// YAN-363: pre-import backup. importDb must take a complete, private,
// verified pre-import-* snapshot AFTER root/preflight validation and BEFORE
// either destructive txn; backup failure aborts with zero mutation, preflight
// failure creates no backup, and pruneOldBackups never deletes pre-import
// copies. Real adapter + real isolated DATA_DIR (tests/vitest.config.js).
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import * as dbApi from "@/lib/db/index.js";
import { BACKUPS_DIR } from "@/lib/db/paths.js";
import { makeBackupDir, pruneOldBackups } from "@/lib/db/backup.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";

vi.mock("@/lib/auth/apiKeyPrincipal.js", () => ({
  clearApiKeyPrincipalCache: vi.fn(),
}));

const NOW = "2026-10-03T00:00:00.000Z";
const MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));
const OTHER_MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 11 + 5) % 256));
const KID = masterKeyId(MASTER);
const HASH_KEY = deriveApiKeyHashKey(MASTER);
const RAW_H = "th_HASHEDGATEWAYTOKENxxxxxxxxxxxxxxx";
const RAW_L = "th_LEGACYPLAINTEXTTOKENxxxxxxxxxxxxxxx";
const digest = (raw, key = HASH_KEY) => hashApiKey(raw, key);
const WS = "ws-default";

let db;
const one = (sql) => db.get(sql);
const tableDump = () =>
  JSON.stringify({
    apiKeys: db.all("SELECT * FROM apiKeys"),
    users: db.all("SELECT * FROM users"),
    connections: db.all("SELECT * FROM providerConnections"),
    combos: db.all("SELECT * FROM combos"),
    settings: db.all("SELECT * FROM settings"),
    kv: db.all("SELECT * FROM kv"),
    meta: db.all("SELECT * FROM _meta"),
  });
const preImportDirs = () =>
  fs
    .readdirSync(BACKUPS_DIR)
    .filter((n) => n.startsWith("pre-import-"))
    .map((n) => path.join(BACKUPS_DIR, n));

// Read-only SQLite open for backup content assertions (node:sqlite ≥22.5).
async function openRo(file) {
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(file, { readOnly: true });
}

// Legacy instance: raw-key apiKeys table, one connection, one request row.
function seedLegacyInstance() {
  db.exec(`DROP TABLE IF EXISTS apiKeys`);
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT,
    isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL)`);
  db.run(`DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')`);
  db.run(`DELETE FROM providerConnections`);
  db.run(`DELETE FROM combos`);
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
     VALUES('conn-live', 'openai', 'api_key', 'Live', NULL, 1, 1, ?, ?, ?)`,
    [JSON.stringify({ accessToken: "sk-live-cred" }), NOW, NOW],
  );
  db.run(`INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?,?,?,?,?,?)`, [
    "legacy-live",
    RAW_L,
    "Live runner",
    "machine-1",
    1,
    NOW,
  ]);
  db.run(`DELETE FROM requestDetails`);
  db.run(
    `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES('rd-1', ?, 'openai', 'gpt-4o', NULL, 'ok', ?)`,
    [NOW, JSON.stringify({ model: "gpt-4o" })],
  );
  db.run(`DELETE FROM kv WHERE scope = 'cliToolPresets'`);
}

function legacyPayload() {
  return {
    schemaVersion: 1,
    apiKeys: [{ id: "legacy-new", key: RAW_L, name: "Imported", isActive: true, createdAt: NOW }],
    cliToolPresets: { apiKeys: [{ name: "CI", key: RAW_L }] },
    providerConnections: [
      {
        id: "conn-imported",
        provider: "anthropic",
        authType: "api_key",
        name: "Imported",
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    combos: [{ id: "combo-new", name: "New", kind: null, models: [], createdAt: NOW }],
  };
}

// Hashed instance (same shape as gateway-key-transfer.test.js).
function seedHashedInstance() {
  db.exec(`DROP TABLE IF EXISTS apiKeys`);
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    userId TEXT REFERENCES users(id) ON DELETE CASCADE,
    createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
    keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
    machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
    revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
    expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
  db.exec(
    `DELETE FROM memberships; DELETE FROM identities; DELETE FROM workspaces; DELETE FROM users;
     DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid','defaultWorkspaceId')`,
  );
  db.run(
    `INSERT INTO users(id, email, username, displayName, instanceRole, status, passwordHash, sessionVersion, createdAt, updatedAt, lastLoginAt)
     VALUES('owner', 'owner@x.test', 'owner', 'owner', 'owner', 'active', 'h', 1, ?, ?, NULL)`,
    [NOW, NOW],
  );
  db.run(
    `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES(?, 'Default', 'shared', 'owner', ?, ?)`,
    [WS, NOW, NOW],
  );
  db.run(
    `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?, 'owner', 'owner', 'manual', ?)`,
    [WS, NOW],
  );
  db.run(
    `INSERT INTO apiKeys(id, workspaceId, userId, createdByUserId, keyHash, hashKid, prefix, name, legacy, isActive, allowedModels, createdAt)
     VALUES('hk-live', ?, 'owner', 'owner', ?, ?, ?, 'Live', 0, 1, '[]', ?)`,
    [WS, digest(RAW_H), KID, "th_HA", NOW],
  );
  db.run(
    `INSERT INTO _meta(key, value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?), ('defaultWorkspaceId',?)`,
    [KID, WS],
  );
}

async function importAndCapture(payload, opts) {
  const before = tableDump();
  const result = await dbApi.importDb(payload, opts);
  const dirs = preImportDirs();
  expect(dirs).toHaveLength(1);
  return { result, backupDir: dirs[0], before };
}

beforeEach(async () => {
  db = await getAdapter();
  db.exec("DROP TABLE IF EXISTS gatewayVideoJobs");
  db.exec(`DELETE FROM kv WHERE scope = 'cliToolPresets'`);
  vi.clearAllMocks();
  // Fresh BACKUPS_DIR so preImportDirs() counts only this test's backup.
  fs.rmSync(BACKUPS_DIR, { recursive: true, force: true });
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
});

describe("pre-import backup (legacy instance)", () => {
  beforeEach(seedLegacyInstance);

  it("creates a complete private verified backup of the pre-import state", async () => {
    const { backupDir, before } = await importAndCapture(legacyPayload());

    // Private modes: 0700 dir, 0600 file.
    const file = path.join(backupDir, "data.sqlite");
    expect(fs.statSync(backupDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    // Content = the LIVE pre-import state, not the imported replacement.
    const ro = await openRo(file);
    try {
      const conn = ro.prepare("SELECT id, name FROM providerConnections").get();
      expect(conn).toEqual({ id: "conn-live", name: "Live" });
      const key = ro.prepare("SELECT id, key FROM apiKeys").get();
      expect(key).toEqual({ id: "legacy-live", key: RAW_L });
      expect(ro.prepare("SELECT COUNT(*) AS c FROM requestDetails").get().c).toBe(1); // complete
      expect(ro.prepare("SELECT COUNT(*) AS c FROM combos").get().c).toBe(0);
    } finally {
      ro.close();
    }

    // Live DB was replaced by the import; the dump proves they differ.
    expect(one(`SELECT id FROM providerConnections`).id).toBe("conn-imported");
    expect(before).not.toBe(tableDump());
  });

  it("no mutation window between snapshot and transaction (queued write lands post-txn)", async () => {
    // Deterministic gap proof: the moment the snapshot file is written, queue
    // a microtask that inserts a rogue combo. If any await separated snapshot
    // -> verify -> transaction, the microtask would run in the gap and the
    // destructive txn would wipe the rogue row. With a synchronous path the
    // microtask can only run after the txn commits, so the rogue row survives
    // in the live DB while the backup (taken before it) lacks it.
    const fsyncSync = fs.fsyncSync;
    let queued = false;
    const spy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      const result = fsyncSync(fd);
      const stat = fs.fstatSync(fd);
      if (
        !queued &&
        stat.isFile() &&
        preImportDirs().some((dir) => {
          const backup = fs.statSync(path.join(dir, "data.sqlite"));
          return backup.dev === stat.dev && backup.ino === stat.ino;
        })
      ) {
        queued = true;
        queueMicrotask(() => {
          db.run(
            `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES('combo-rogue', 'Rogue', NULL, '[]', ?, ?)`,
            [NOW, NOW],
          );
        });
      }
      return result;
    });
    try {
      await dbApi.importDb(legacyPayload());
    } finally {
      spy.mockRestore();
    }
    expect(queued).toBe(true);
    // Rogue survived: it ran after the txn committed.
    expect(one(`SELECT id FROM combos WHERE id = 'combo-rogue'`).id).toBe("combo-rogue");
    expect(one(`SELECT id FROM combos WHERE id = 'combo-new'`).id).toBe("combo-new");
    // Backup predates the rogue write: combos table is empty there.
    const ro = await openRo(path.join(preImportDirs()[0], "data.sqlite"));
    try {
      expect(ro.prepare("SELECT COUNT(*) AS c FROM combos").get().c).toBe(0);
    } finally {
      ro.close();
    }
  });

  it("backup failure aborts with zero mutation", async () => {
    const before = tableDump();
    fs.rmSync(BACKUPS_DIR, { recursive: true, force: true });
    fs.writeFileSync(BACKUPS_DIR, "not-a-dir"); // sabotage: prefix dir cannot exist
    await expect(dbApi.importDb(legacyPayload())).rejects.toMatchObject({
      code: "IMPORT_BACKUP_FAILED",
    });
    expect(tableDump()).toBe(before); // untouched
    expect(one(`SELECT id FROM apiKeys WHERE id = 'legacy-live'`).id).toBe("legacy-live");
    fs.rmSync(BACKUPS_DIR, { force: true });
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  });

  it("corrupt backup bytes abort with zero mutation, not just a size check", async () => {
    // Corrupt the SQLite header AFTER the write and fsync, BEFORE quick_check
    // reads it (node:sqlite skips the writeFileSync path): the size stays
    // plausible, so the integrity gate must be what refuses it.
    const fsyncSync = fs.fsyncSync;
    const spy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      const src = fs.fstatSync(fd);
      for (const d of preImportDirs()) {
        const file = path.join(d, "data.sqlite");
        if (src.dev === fs.statSync(file).dev && src.ino === fs.statSync(file).ino) {
          fs.writeSync(fd, Buffer.from("XXXXXXXXSQLite f"), 0, 16, 0);
        }
      }
      return fsyncSync(fd);
    });
    const before = tableDump();
    try {
      await expect(dbApi.importDb(legacyPayload())).rejects.toMatchObject({
        code: "IMPORT_BACKUP_FAILED",
      });
    } finally {
      spy.mockRestore();
    }
    expect(tableDump()).toBe(before);
  });

  it("preflight failure creates no backup", async () => {
    const before = tableDump();
    const payload = legacyPayload();
    payload.apiKeys[0].key = ""; // malformed: raw key required
    await expect(dbApi.importDb(payload)).rejects.toThrow();
    expect(preImportDirs()).toEqual([]);
    expect(tableDump()).toBe(before);
  });

  it("pruneOldBackups keeps pre-import copies past 3 ordinary backups", async () => {
    await dbApi.importDb(legacyPayload());
    const backupDir = preImportDirs()[0];
    // Make the pre-import copy the OLDEST entry, then stack 4 ordinary dirs.
    const past = new Date(Date.now() - 10_000);
    fs.utimesSync(backupDir, past, past);
    const ordinary = [1, 2, 3, 4].map((i) => {
      const dir = makeBackupDir(`schema-0-to-9-${i}`);
      const at = new Date(Date.now() - 5000 + i * 1000);
      fs.utimesSync(dir, at, at);
      return dir;
    });
    pruneOldBackups();
    expect(fs.existsSync(backupDir)).toBe(true);
    expect(fs.existsSync(ordinary[0])).toBe(false); // oldest ordinary pruned
    expect(ordinary.slice(1).every((d) => fs.existsSync(d))).toBe(true);
  });
});

describe("pre-import backup (hashed instance)", () => {
  beforeEach(seedHashedInstance);

  it("backs up the hashed state before a v2 import; restore stays functional", async () => {
    const snapshot = await dbApi.exportDb();
    const { backupDir, result } = await importAndCapture(snapshot, { masterKey: MASTER });
    expect(result.formatVersion).toBe(2);

    // Backup captured the pre-import hashed rows (before the wipe above).
    const ro = await openRo(path.join(backupDir, "data.sqlite"));
    try {
      expect(ro.prepare("SELECT id FROM apiKeys").get()).toEqual({ id: "hk-live" });
      expect(ro.prepare("SELECT value FROM _meta WHERE key = 'apiKeysHashKid'").get().value).toBe(
        KID,
      );
    } finally {
      ro.close();
    }

    // Live DB restored by the import and still verifiable under the root.
    expect(one(`SELECT keyHash FROM apiKeys WHERE id = 'hk-live'`).keyHash).toBe(digest(RAW_H));
    const { getEligibleApiKeySync } = await import("@/lib/db/repos/apiKeysRepo.js");
    expect(
      getEligibleApiKeySync(db, "hk-live", { keyHash: digest(RAW_H), now: NOW }),
    ).toMatchObject({ id: "hk-live" });
  });

  it("wrong master fails root proof before any backup is created", async () => {
    const before = tableDump();
    await expect(dbApi.importDb(legacyPayload(), { masterKey: OTHER_MASTER })).rejects.toThrow(
      expect.objectContaining({ code: "TRANSFER_ROOT_MISMATCH" }),
    );
    expect(preImportDirs()).toEqual([]);
    expect(tableDump()).toBe(before);
  });
});
