// YAN-363: activateGatewayKeys — switch-on orchestration, backup/flush/txn
// gates, reopen schema. Real sql.js adapters on isolated temp files (no
// getAdapter/driver: activation is unwired and takes the adapter directly);
// real backups land under the per-file isolated DATA_DIR from
// tests/vitest.config.js. No production activation exists yet.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateGatewayKeys } from "@/lib/db/activateGatewayKeys.js";
import { createSqlJsAdapter } from "@/lib/db/adapters/sqljsAdapter.js";
import { runMigrationOnce } from "@/lib/db/migrate.js";
import { readApiKeyStorageState } from "@/lib/db/apiKeyState.js";
import { BACKUPS_DIR } from "@/lib/db/paths.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";

const NOW = "2026-10-03T00:00:00.000Z";
const WS = "ws-default";
const MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));
const KID = masterKeyId(MASTER);
const HASH_KEY = deriveApiKeyHashKey(MASTER);
const RAW_A = "th_0123456789ABCDEFGHIJKLMNOPQRSTUV";
const RAW_B = "sk-machineid12345678-abc123-0f1e2d3c";
const RAW_GHOST = "th_AMBIGUOUSPRESETTOKENzzzzzzzzzzzz";
const digest = (raw) => hashApiKey(raw, HASH_KEY);

let tempDir;
let db;
let backupsAtCaseStart;

const columnsOf = (d) => d.all("PRAGMA table_info(apiKeys)").map((c) => c.name);
const activationBackups = () =>
  fs.existsSync(BACKUPS_DIR)
    ? fs.readdirSync(BACKUPS_DIR).filter((n) => n.startsWith("gateway-key-activation"))
    : [];

function seedLegacy({ owner = true, presets = null } = {}) {
  db.exec(`DROP TABLE IF EXISTS gatewayVideoJobs`);
  // YAN-370: 014 dropped usageDaily; activation still converts a leftover one.
  db.exec(`CREATE TABLE IF NOT EXISTS usageDaily (dateKey TEXT PRIMARY KEY, data TEXT NOT NULL)`);
  db.exec(`DELETE FROM usageHistory; DELETE FROM usageDaily; DELETE FROM apiKeys;
    DELETE FROM kv WHERE scope = 'cliToolPresets'; DELETE FROM users; DELETE FROM workspaces`);
  db.run(
    `DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid','defaultWorkspaceId')`,
  );
  db.exec(`DROP TABLE IF EXISTS apiKeys`);
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT,
    isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL)`);
  if (owner) {
    db.run(
      `INSERT INTO users(id, instanceRole, status, sessionVersion, createdAt, updatedAt) VALUES(?,?,?,?,?,?)`,
      ["owner-1", "owner", "active", 1, NOW, NOW],
    );
    db.run(
      `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES(?,?,?,?,?,?)`,
      [WS, "Default", "shared", "owner-1", NOW, NOW],
    );
    db.run(`INSERT INTO _meta(key, value) VALUES('defaultWorkspaceId', ?)`, [WS]);
    db.run(
      `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?,?,?,?,?)`,
      [WS, "owner-1", "owner", "manual", NOW],
    );
  }
  db.run(`INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?,?,?,?,?,?)`, [
    "key-1",
    RAW_A,
    "Runner",
    "machine-1",
    1,
    NOW,
  ]);
  db.run(`INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?,?,?,?,?,?)`, [
    "key-2",
    RAW_B,
    "Paused",
    null,
    0,
    NOW,
  ]);
  db.run(`INSERT INTO usageHistory(timestamp, provider, model, apiKey, meta) VALUES(?,?,?,?,?)`, [
    NOW,
    "openai",
    "gpt-4o",
    RAW_A,
    JSON.stringify({ rawModel: "gpt-4o", provider: "openai", apiKey: RAW_A }),
  ]);
  db.run(`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?)`, [
    "2026-10-02",
    JSON.stringify({
      byProvider: { openai: { requests: 1, cost: 0.5 } },
      byApiKey: {
        [`${RAW_A}|gpt-4o|openai`]: { requests: 1, cost: 0.5, meta: { apiKey: RAW_A } },
      },
    }),
  ]);
  if (presets) {
    db.run(
      `INSERT INTO kv(scope, key, value) VALUES('cliToolPresets','apiKeys',?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify(presets)],
    );
  }
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-activation-"));
  db = await createSqlJsAdapter(path.join(tempDir, "act.sqlite"));
  await runMigrationOnce(db);
  seedLegacy();
  // After runMigrationOnce's prune, so the delta below is stable.
  backupsAtCaseStart = activationBackups().length;
});

afterEach(() => {
  vi.restoreAllMocks();
  db?.close();
  db = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("activateGatewayKeys (unwired switch-on orchestrator)", () => {
  it("enabled:false (legacy off) leaves the DB byte-identical: no master/backup/hash", async () => {
    const before = Buffer.from(db.snapshot());
    const result = await activateGatewayKeys(db, { masterKey: MASTER });
    expect(result).toEqual({ status: "skipped-off", isReady: false });
    expect(Buffer.from(db.snapshot()).equals(before)).toBe(true);
    expect(readApiKeyStorageState(db).storage).toBe("legacy");
    expect(activationBackups()).toEqual([]);
  });

  it("switches on a pristine legacy instance: hash marker, hashed rows, video table, backup", async () => {
    const result = await activateGatewayKeys(db, {
      enabled: true,
      beforeServing: true,
      credentialSinksVetted: true,
      masterKey: MASTER,
    });
    expect(result).toMatchObject({ status: "ready", isReady: true, hashKid: KID });
    expect(result.migration).toMatchObject({ keysMigrated: 2, presetsConverted: 0 });

    const state = readApiKeyStorageState(db);
    expect(state).toEqual({ storage: "hashed", version: 1, hashKid: KID });
    const cols = columnsOf(db);
    expect(cols).not.toContain("key");
    for (const c of ["keyHash", "hashKid", "workspaceId", "prefix"]) expect(cols).toContain(c);
    expect(db.get(`SELECT * FROM apiKeys WHERE id = 'key-1'`)).toMatchObject({
      keyHash: digest(RAW_A),
      hashKid: KID,
      workspaceId: WS,
      legacy: 1,
      isActive: 1,
    });
    expect(db.all(`SELECT apiKey FROM usageHistory`)).toEqual([{ apiKey: "key-1" }]);
    const day = JSON.parse(db.get(`SELECT data FROM usageDaily`).data);
    expect(Object.keys(day.byApiKey)).toEqual([`key-1|gpt-4o|openai`]);
    expect(db.get(`SELECT name FROM sqlite_master WHERE name = 'gatewayVideoJobs'`).name).toBe(
      "gatewayVideoJobs",
    );

    // Backup really completed before mutation, under the isolated DATA_DIR.
    const backups = activationBackups();
    expect(backups).toHaveLength(backupsAtCaseStart + 1);
    const newest = backups
      .map((n) => ({ n, m: fs.statSync(path.join(BACKUPS_DIR, n)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0].n;
    const backupFile = path.join(BACKUPS_DIR, newest, "data.sqlite");
    const backupBytes = fs.readFileSync(backupFile);
    expect(backupBytes.length).toBeGreaterThan(0);
    // Pre-activation backup is legacy-shaped and carries the raw keys.
    const { createSqlJsAdapter: open } = await import("@/lib/db/adapters/sqljsAdapter.js");
    const bak = await open(backupFile);
    expect(readApiKeyStorageState(bak).storage).toBe("legacy");
    expect(bak.get(`SELECT key FROM apiKeys WHERE id = 'key-1'`).key).toBe(RAW_A);
    bak.close();
  });

  it("reopen after activation: sync uses the hashed definition, never re-adds the raw column", async () => {
    // Zero-key instance is the sharp case: the legacy `key TEXT NOT NULL`
    // column could otherwise be ALTER-ADDed to an empty table by the old sync.
    db.exec(`DELETE FROM apiKeys`);
    await activateGatewayKeys(db, {
      enabled: true,
      beforeServing: true,
      credentialSinksVetted: true,
      masterKey: MASTER,
    });
    expect(columnsOf(db)).not.toContain("key");
    db.close();

    db = await createSqlJsAdapter(path.join(tempDir, "act.sqlite"));
    await runMigrationOnce(db); // fresh adapter → full sync path re-runs
    expect(readApiKeyStorageState(db)).toEqual({ storage: "hashed", version: 1, hashKid: KID });
    expect(columnsOf(db)).not.toContain("key");
    expect(columnsOf(db)).toContain("keyHash");
    expect(db.get(`SELECT name FROM sqlite_master WHERE name = 'idx_ak_key'`)).toBeUndefined();
  });

  it("idempotency/restart: second activation is already-hashed, no second backup, master never regenerates", async () => {
    await activateGatewayKeys(db, {
      enabled: true,
      beforeServing: true,
      credentialSinksVetted: true,
      masterKey: MASTER,
    });
    const backupsAfterFirst = backupsAtCaseStart + 1;
    const again = await activateGatewayKeys(db, {
      enabled: true,
      beforeServing: true,
      credentialSinksVetted: true,
      masterKey: MASTER,
    });
    expect(again).toMatchObject({ status: "already-hashed", isReady: true, hashKid: KID });
    expect(activationBackups()).toHaveLength(backupsAfterFirst);

    // Restart: brand-new adapter from the persisted file stays already-hashed.
    db.close();
    db = await createSqlJsAdapter(path.join(tempDir, "act.sqlite"));
    const restarted = await activateGatewayKeys(db, {
      enabled: true,
      beforeServing: true,
      credentialSinksVetted: true,
      masterKey: MASTER,
    });
    expect(restarted).toMatchObject({ status: "already-hashed", isReady: true, hashKid: KID });
  });

  it("backup failure aborts with zero mutation", async () => {
    const before = Buffer.from(db.snapshot());
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("simulated backup failure");
    });
    await expect(
      activateGatewayKeys(db, {
        enabled: true,
        beforeServing: true,
        credentialSinksVetted: true,
        masterKey: MASTER,
      }),
    ).rejects.toThrow("simulated backup failure");
    spy.mockRestore();
    expect(Buffer.from(db.snapshot()).equals(before)).toBe(true);
    expect(readApiKeyStorageState(db).storage).toBe("legacy");
    expect(
      db.get(`SELECT name FROM sqlite_master WHERE name = 'gatewayVideoJobs'`),
    ).toBeUndefined();
    // Recovery: with the backup path healthy the same call succeeds.
    await expect(
      activateGatewayKeys(db, {
        enabled: true,
        beforeServing: true,
        credentialSinksVetted: true,
        masterKey: MASTER,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      isReady: true,
    });
  });

  it("nonempty wrong backup snapshot aborts before any mutation", async () => {
    // Build a VALID but WRONG sqlite snapshot: same legacy schema, one key
    // row instead of two. The backup materializes (nonempty, integrity ok),
    // so only the content gate can catch it.
    db.run(`DELETE FROM apiKeys WHERE id = 'key-2'`);
    const wrongBytes = db.snapshot();
    db.run(
      `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?,?,?,?,?,?)`,
      ["key-2", RAW_B, "Paused", null, 0, NOW],
    );
    const writeFileSync = fs.writeFileSync;
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((target, data, opts) => {
      if (
        typeof target === "string" &&
        target.includes("gateway-key-activation-") &&
        target.endsWith("data.sqlite")
      ) {
        return writeFileSync(target, wrongBytes, opts);
      }
      return writeFileSync(target, data, opts);
    });
    await expect(
      activateGatewayKeys(db, {
        enabled: true,
        beforeServing: true,
        credentialSinksVetted: true,
        masterKey: MASTER,
      }),
    ).rejects.toMatchObject({ code: "ACTIVATION_BACKUP_INVALID" });
    spy.mockRestore();
    // Zero mutation: legacy shape, both raw keys, no marker, no video table.
    expect(readApiKeyStorageState(db).storage).toBe("legacy");
    expect(columnsOf(db)).toContain("key");
    expect(db.get(`SELECT COUNT(*) AS c FROM apiKeys`).c).toBe(2);
    expect(db.get(`SELECT key FROM apiKeys WHERE id = 'key-1'`).key).toBe(RAW_A);
    expect(
      db.get(`SELECT name FROM sqlite_master WHERE name = 'gatewayVideoJobs'`),
    ).toBeUndefined();
  });

  it("corrupt nonempty backup file aborts before any mutation", async () => {
    const writeFileSync = fs.writeFileSync;
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((target, data, opts) => {
      if (
        typeof target === "string" &&
        target.includes("gateway-key-activation-") &&
        target.endsWith("data.sqlite")
      ) {
        return writeFileSync(target, Buffer.concat([Buffer.from([0x41]), data.subarray(1)]), opts);
      }
      return writeFileSync(target, data, opts);
    });
    await expect(
      activateGatewayKeys(db, {
        enabled: true,
        beforeServing: true,
        credentialSinksVetted: true,
        masterKey: MASTER,
      }),
    ).rejects.toMatchObject({ code: "ACTIVATION_BACKUP_INVALID" });
    spy.mockRestore();
    expect(readApiKeyStorageState(db).storage).toBe("legacy");
    expect(db.get(`SELECT COUNT(*) AS c FROM apiKeys`).c).toBe(2);
  });

  it("pruneOldBackups never deletes activation copies even past 3 ordinary backups", async () => {
    const { makeBackupDir, pruneOldBackups } = await import("@/lib/db/backup.js");
    const result = await activateGatewayKeys(db, {
      enabled: true,
      beforeServing: true,
      credentialSinksVetted: true,
      masterKey: MASTER,
    });
    const activationDir = result.backupDir;
    // Clear earlier ordinary dirs (earlier cases share this isolated
    // BACKUPS_DIR) so the prune budget covers exactly the 4 we create.
    for (const n of fs
      .readdirSync(BACKUPS_DIR)
      .filter((n) => !n.startsWith("gateway-key-activation"))) {
      try {
        fs.rmSync(path.join(BACKUPS_DIR, n), { recursive: true, force: true });
      } catch {}
    }
    // Make the activation copy the OLDEST entry and stack 4 ordinary backups
    // on top: without the exemption, KEEP_BACKUPS=3 would prune it first.
    const past = new Date(Date.now() - 10_000);
    fs.utimesSync(activationDir, past, past);
    const ordinary = [1, 2, 3, 4].map((i) => {
      // Unique label per dir: same-second slugs would collapse into one.
      const dir = makeBackupDir(`schema-0-to-9-${i}`);
      const at = new Date(Date.now() - 5000 + i * 1000);
      fs.utimesSync(dir, at, at);
      return dir;
    });
    pruneOldBackups();
    // 4 ordinary, budget 3: only the oldest ordinary dir is pruned. The
    // activation copy survives even though its mtime is the oldest of all.
    expect(fs.existsSync(activationDir)).toBe(true);
    expect(fs.existsSync(ordinary[0])).toBe(false);
    expect(ordinary.slice(1).every((d) => fs.existsSync(d))).toBe(true);
    expect(
      fs.readdirSync(BACKUPS_DIR).filter((n) => !n.startsWith("gateway-key-activation")).length,
    ).toBe(3);
  });

  it("production master loader: wrong/missing root on hashed rejects, never regenerates", async () => {
    const { getDataDir } = await import("@/lib/dataDir.js");
    const masterFile = path.join(getDataDir(), "keys", "master");
    // Production path: no fixture masterKey — loader creates the root once.
    const first = await activateGatewayKeys(db, {
      enabled: true,
      beforeServing: true,
      credentialSinksVetted: true,
    });
    expect(fs.statSync(masterFile).size).toBe(32);
    expect(masterKeyId(fs.readFileSync(masterFile))).toBe(first.hashKid);
    const created = fs.readFileSync(masterFile);

    // Restart with a matching root: already-hashed, same kid, no regen.
    const again = await activateGatewayKeys(db, {
      enabled: true,
      beforeServing: true,
      credentialSinksVetted: true,
    });
    expect(again).toMatchObject({
      status: "already-hashed",
      isReady: true,
      hashKid: first.hashKid,
    });
    expect(fs.readFileSync(masterFile).equals(created)).toBe(true);

    // Wrong root: kid mismatch rejects closed, file untouched.
    const wrong = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 11 + 5) % 256));
    fs.writeFileSync(masterFile, wrong);
    fs.chmodSync(masterFile, 0o600);
    await expect(
      activateGatewayKeys(db, {
        enabled: true,
        beforeServing: true,
        credentialSinksVetted: true,
      }),
    ).rejects.toThrow("master key id mismatch");
    expect(fs.readFileSync(masterFile).equals(wrong)).toBe(true);

    // Missing root: expected kid present → reject, never create a new one.
    fs.rmSync(masterFile, { force: true });
    await expect(
      activateGatewayKeys(db, {
        enabled: true,
        beforeServing: true,
        credentialSinksVetted: true,
      }),
    ).rejects.toThrow("master key missing for expected id");
    expect(fs.existsSync(masterFile)).toBe(false);
  });

  it("flush failure after commit reports not-ready and the file on disk stays legacy", async () => {
    const file = path.join(tempDir, "act.sqlite");
    db.flushSync(); // persist the legacy baseline
    const legacyBytes = fs.readFileSync(file);
    // renameSync is on sql.js persist's path only (tmp write + fsync + rename):
    // backup uses copyFileSync/writeFileSync, protectedBackup's fsyncs are untouched.
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("simulated flush failure");
    });
    await expect(
      activateGatewayKeys(db, {
        enabled: true,
        beforeServing: true,
        credentialSinksVetted: true,
        masterKey: MASTER,
      }),
    ).rejects.toThrow("simulated flush failure");
    expect(activationBackups()).toHaveLength(backupsAtCaseStart + 1); // backup ran, mutation rolled nothing (committed in memory)
    // Disk never got the marker: on-disk state is still pristine legacy.
    expect(fs.readFileSync(file).equals(legacyBytes)).toBe(true);
    const onDisk = await createSqlJsAdapter(file);
    expect(readApiKeyStorageState(onDisk).storage).toBe("legacy");
    expect(onDisk.get(`SELECT key FROM apiKeys WHERE id = 'key-1'`).key).toBe(RAW_A);
    onDisk.close();
    // Recovery on the same adapter: flush healthy again → already-hashed and ready.
    spy.mockRestore();
    const retry = await activateGatewayKeys(db, {
      enabled: true,
      beforeServing: true,
      credentialSinksVetted: true,
      masterKey: MASTER,
    });
    expect(retry).toMatchObject({ status: "already-hashed", isReady: true, hashKid: KID });
    db.flushSync();
    const after = await createSqlJsAdapter(file);
    expect(readApiKeyStorageState(after).storage).toBe("hashed");
    expect(columnsOf(after)).not.toContain("key");
    after.close();
  });

  it("sql.js adapter: flushSync throws on persist failure (throwing-flush evidence)", async () => {
    db.run(`INSERT INTO usageHistory(timestamp, apiKey) VALUES (?, ?)`, [NOW, "pending"]);
    // Simulate failure in sql.js persist (scratch write), not in the backup's
    // own fsync — this test targets the post-commit durability gate.
    const spy = vi.spyOn(fs, "writeSync").mockImplementation(() => {
      throw new Error("simulated flush failure");
    });
    expect(() => db.flushSync()).toThrow("simulated flush failure");
    spy.mockRestore();
    expect(() => db.flushSync()).not.toThrow();
    const onDisk = await createSqlJsAdapter(path.join(tempDir, "act.sqlite"));
    expect(onDisk.all(`SELECT apiKey FROM usageHistory ORDER BY id`)).toEqual([
      { apiKey: RAW_A },
      { apiKey: "pending" },
    ]);
    onDisk.close();
  });

  it("sql.js adapter: flushSync throws on persist failure (rename path)", async () => {
    db.run(`INSERT INTO usageHistory(timestamp, apiKey) VALUES (?, ?)`, [NOW, "pending"]);
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("simulated flush failure");
    });
    expect(() => db.flushSync()).toThrow("simulated flush failure");
    spy.mockRestore();
    expect(() => db.flushSync()).not.toThrow();
    const onDisk = await createSqlJsAdapter(path.join(tempDir, "act.sqlite"));
    expect(onDisk.all(`SELECT apiKey FROM usageHistory ORDER BY id`)).toEqual([
      { apiKey: RAW_A },
      { apiKey: "pending" },
    ]);
    onDisk.close();
  });

  it("video table lands in the same transaction: ambiguous preset rolls back both", async () => {
    seedLegacy({ presets: [{ name: "ghost", key: RAW_GHOST }] });
    await expect(
      activateGatewayKeys(db, {
        enabled: true,
        beforeServing: true,
        credentialSinksVetted: true,
        masterKey: MASTER,
      }),
    ).rejects.toMatchObject({
      code: "API_KEY_MIGRATION_AMBIGUOUS_PRESET",
    });
    expect(readApiKeyStorageState(db).storage).toBe("legacy");
    expect(
      db.get(`SELECT name FROM sqlite_master WHERE name = 'gatewayVideoJobs'`),
    ).toBeUndefined();
    expect(db.get(`SELECT key FROM apiKeys WHERE id = 'key-1'`).key).toBe(RAW_A);
    expect(
      db.get(`SELECT value FROM kv WHERE scope = 'cliToolPresets' AND key = 'apiKeys'`).value,
    ).toContain(RAW_GHOST);
  });

  it("malformed marker fails closed: activation refuses, and boot sync re-runs fail too", async () => {
    db.run(`INSERT INTO _meta(key, value) VALUES('apiKeysHashedVersion', '2')`);
    db.run(`INSERT INTO _meta(key, value) VALUES('apiKeysHashKid', 'n0thex0f0f0f0f0f0')`);
    await expect(
      activateGatewayKeys(db, {
        enabled: true,
        beforeServing: true,
        credentialSinksVetted: true,
        masterKey: MASTER,
      }),
    ).rejects.toMatchObject({
      code: "API_KEY_STATE_INVALID",
    });
    db.flushSync();
    const reopened = await createSqlJsAdapter(path.join(tempDir, "act.sqlite"));
    await expect(runMigrationOnce(reopened)).rejects.toMatchObject({
      code: "API_KEY_STATE_INVALID",
    });
    reopened.close();
  });

  it("stray legacy JSON on an activated DB does not crash boot (import skipped)", async () => {
    await activateGatewayKeys(db, {
      enabled: true,
      beforeServing: true,
      credentialSinksVetted: true,
      masterKey: MASTER,
    });
    db.close();
    // Simulate a stray never-imported legacy JSON next to an activated DB.
    const { LEGACY_FILES } = await import("@/lib/db/paths.js");
    fs.mkdirSync(path.dirname(LEGACY_FILES.main), { recursive: true });
    fs.writeFileSync(
      LEGACY_FILES.main,
      JSON.stringify({ apiKeys: [{ id: "x", key: "th_stray" }] }),
    );
    try {
      db = await createSqlJsAdapter(path.join(tempDir, "act.sqlite"));
      await expect(runMigrationOnce(db)).resolves.toBeUndefined();
      expect(readApiKeyStorageState(db).storage).toBe("hashed");
      expect(db.get(`SELECT COUNT(*) AS c FROM apiKeys`).c).toBe(2);
    } finally {
      try {
        fs.rmSync(LEGACY_FILES.main, { force: true });
      } catch {}
    }
  });

  it("owner/Default preconditions: missing owner stops before backup or master use", async () => {
    seedLegacy({ owner: false });
    const backupsBefore = activationBackups().length;
    await expect(
      activateGatewayKeys(db, {
        enabled: true,
        beforeServing: true,
        credentialSinksVetted: true,
        masterKey: MASTER,
      }),
    ).rejects.toMatchObject({
      code: "ACTIVATION_OWNER_MISSING",
    });
    expect(activationBackups()).toHaveLength(backupsBefore);
    expect(readApiKeyStorageState(db).storage).toBe("legacy");
  });
});
