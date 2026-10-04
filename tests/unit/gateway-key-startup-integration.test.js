// YAN-363 final wiring: the REAL production startup pipeline on this file's
// isolated DATA_DIR — lock -> adapter open/migrate -> multi-user resolved from
// the stored setting -> strict owner bootstrap -> activateGatewayKeys. One
// sequential flow: legacy off (no side effects) -> activation backup failure
// (sticky, closed) -> switch on (hash migration, owner, master, backup) ->
// restart with the switch off (already-hashed validation, key still works) ->
// wrong master root (sticky reject). Plus: initializeApp never runs before
// readiness, and a second process is still refused the shared DATA_DIR.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ensureGatewayKeyStartup,
  getGatewayKeyActivation,
  isGatewayKeyStartupReady,
  resetGatewayKeyStartupForTests,
} from "@/lib/db/startupReadiness.js";
import { readApiKeyStorageState } from "@/lib/db/apiKeyState.js";
import { createSqlJsAdapter } from "@/lib/db/adapters/sqljsAdapter.js";
import { runMigrationOnce } from "@/lib/db/migrate.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { DATA_DIR } from "@/lib/dataDir.js";

// Fail-closed gate for the layout auto-bootstrap: initializeApp is replaced
// so importing @/shared/services/bootstrap.js can never start real services.
vi.mock("@/shared/services/initializeApp.js", () => ({ default: vi.fn(async () => {}) }));
// Repositories/strict bootstrap must share the very same sql.js adapter.
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: () => openSqlJs() }));

// Stored setting drives this file: the inherited TOKENHOP_MULTI_USER env
// (CI matrix) would otherwise pin featureSwitch's load-time ENV_OVERRIDE and
// override every setSwitch(db) below. Deleted for the whole file, restored after.
const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];

const src = fileURLToPath(new URL("../../src", import.meta.url));
const NOW = "2026-10-03T00:00:00.000Z";
const WS = "ws-default";
const RAW_A = "th_0123456789ABCDEFGHIJKLMNOPQRSTUV";
const DATA_FILE = path.join(DATA_DIR, "db", "data.sqlite");
const BACKUPS_DIR = path.join(DATA_DIR, "db", "backups");
const MASTER_FILE = path.join(DATA_DIR, "keys", "master");
const activationBackups = () =>
  fs.existsSync(BACKUPS_DIR) && fs.statSync(BACKUPS_DIR).isDirectory()
    ? fs.readdirSync(BACKUPS_DIR).filter((n) => n.startsWith("gateway-key-activation"))
    : [];

let tmp;
const setSwitch = async (db, on) => {
  const raw = db.get("SELECT data FROM settings WHERE id = 1")?.data;
  const parsed = raw ? JSON.parse(raw) : {};
  parsed.multiUserEnabled = on;
  db.run(
    `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
    [JSON.stringify(parsed)],
  );
};
const digestOf = (root) => hashApiKey(RAW_A, deriveApiKeyHashKey(root));

// Pre-startup legacy install: migrated schema, legacy raw-key apiKeys table,
// owner + Default workspace (so a sabotaged ACTIVATION backup is reachable
// without the owner-bootstrap backup failing first), raw usage rows.
async function seedLegacyInstall() {
  fs.mkdirSync(path.join(DATA_DIR, "db"), { recursive: true });
  const db = await createSqlJsAdapter(DATA_FILE);
  await runMigrationOnce(db);
  db.exec(`DROP TABLE IF EXISTS gatewayVideoJobs`);
  db.exec(`DELETE FROM usageHistory; DELETE FROM usageDaily; DELETE FROM apiKeys; DELETE FROM users;
    DELETE FROM workspaces`);
  db.run(
    `DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid','defaultWorkspaceId')`,
  );
  db.exec(`DROP TABLE IF EXISTS apiKeys`);
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT,
    isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL)`);
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
  db.run(`INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?,?,?,?,?,?)`, [
    "key-1",
    RAW_A,
    "Runner",
    "machine-1",
    1,
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
      byApiKey: { [`${RAW_A}|gpt-4o|openai`]: { requests: 1, cost: 0.5, meta: { apiKey: RAW_A } } },
    }),
  ]);
  db.flushSync();
  db.close();
}
// Real sql.js startup pipeline: the coordinator's openDb seam opens the SAME
// adapter the app would use when sql.js is the selected driver, on the real
// isolated DATA_FILE, through the real lock + activation path.
let sharedDb;
const openSqlJs = async () => {
  if (!sharedDb) {
    sharedDb = await createSqlJsAdapter(DATA_FILE);
    await runMigrationOnce(sharedDb);
  }
  return sharedDb;
};
const getAdapter = openSqlJs;
const start = () => ensureGatewayKeyStartup({ openDb: openSqlJs });
const storageOf = async () => readApiKeyStorageState(await getAdapter()).storage;
async function waitFor(fn, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  delete process.env[ENV];
  // featureSwitch captures ENV_OVERRIDE at import time. Drop every cached
  // module copy so activation's lazy import re-evaluates with the env unset
  // and falls through to the stored setting setSwitch writes below. The
  // coordinator state is Symbol.for-keyed, so the reset helper still hits
  // the one shared sticky-promise state across copies.
  vi.resetModules();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-key-integration-"));
  await seedLegacyInstall();
});
afterEach(() => {
  resetGatewayKeyStartupForTests();
});
afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("YAN-363 final startup integration (real pipeline)", () => {
  it("layout auto-bootstrap never runs initializeApp before readiness (fail closed)", async () => {
    const { default: initializeApp } = await import("@/shared/services/initializeApp.js");
    globalThis.__appBootstrapped = false;
    await import("@/shared/services/bootstrap.js");
    await new Promise((r) => setTimeout(r, 100)); // gate rejects: never started
    expect(initializeApp).not.toHaveBeenCalled();
  });

  it("switch off on a legacy install: ready, legacy, no master/backup/owner side effects", async () => {
    const { default: initializeApp } = await import("@/shared/services/initializeApp.js");
    await expect(start()).resolves.toBeUndefined();
    expect(isGatewayKeyStartupReady()).toBe(true);
    expect(getGatewayKeyActivation()).toEqual({ status: "skipped-off", isReady: false });
    expect(await storageOf()).toBe("legacy");
    expect(fs.existsSync(MASTER_FILE)).toBe(false); // no key root
    expect(activationBackups()).toEqual([]); // no backup
    // Layout bootstrap imports AFTER readiness: initializeApp finally runs.
    globalThis.__appBootstrapped = false;
    vi.resetModules();
    await import("@/shared/services/bootstrap.js");
    await waitFor(() => initializeApp.mock.calls.length > 0);
  });

  it("activation backup failure: sticky rejection, closed state, zero DB mutation", async () => {
    const db = await getAdapter();
    await setSwitch(db, true);
    fs.rmSync(BACKUPS_DIR, { recursive: true, force: true });
    fs.writeFileSync(BACKUPS_DIR, "not-a-dir"); // sabotage the activation backup
    const boom = start();
    await expect(boom).rejects.toThrow();
    expect(isGatewayKeyStartupReady()).toBe(false);
    expect(start()).toBe(boom); // sticky
    await expect(start()).rejects.toThrow();
    expect(await storageOf()).toBe("legacy"); // zero mutation
    expect((await getAdapter()).get(`SELECT key FROM apiKeys WHERE id = 'key-1'`).key).toBe(RAW_A);
    expect(activationBackups()).toEqual([]);
    fs.rmSync(BACKUPS_DIR, { force: true });
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    expect(fs.statSync(BACKUPS_DIR).isDirectory()).toBe(true); // restored for the next run
  });

  it("switch on: strict owner invariants, hash migration, master root, protected backup", async () => {
    const masterBefore = fs.existsSync(MASTER_FILE) ? fs.readFileSync(MASTER_FILE) : null;
    await expect(start()).resolves.toBeUndefined();
    expect(isGatewayKeyStartupReady()).toBe(true);
    const result = getGatewayKeyActivation();
    expect(result).toMatchObject({ status: "ready", isReady: true });

    const db = await getAdapter();
    const master = fs.readFileSync(MASTER_FILE);
    expect(master.length).toBe(32);
    expect(masterKeyId(master)).toBe(result.hashKid); // reused if failure pre-created it
    if (masterBefore) expect(master.equals(masterBefore)).toBe(true);
    expect(await storageOf()).toBe("hashed");
    const row = db.get(`SELECT * FROM apiKeys WHERE id = 'key-1'`);
    expect(row.keyHash).toBe(digestOf(master)); // existing key still verifiable
    expect(row).toMatchObject({ hashKid: result.hashKid, workspaceId: WS, legacy: 1 });
    expect(db.get(`SELECT apiKey FROM usageHistory`).apiKey).toBe("key-1");
    expect(Object.keys(JSON.parse(db.get(`SELECT data FROM usageDaily`).data).byApiKey)).toEqual([
      "key-1|gpt-4o|openai",
    ]);
    expect(db.get(`SELECT name FROM sqlite_master WHERE name = 'gatewayVideoJobs'`).name).toBe(
      "gatewayVideoJobs",
    );
    expect(activationBackups()).toHaveLength(1); // protected backup landed
  });

  it("restart with the switch off: already-hashed validation, same root, key still works", async () => {
    const master = fs.readFileSync(MASTER_FILE);
    const db = await getAdapter();
    await setSwitch(db, false);
    await expect(start()).resolves.toBeUndefined();
    expect(getGatewayKeyActivation()).toMatchObject({ status: "already-hashed", isReady: true });
    expect(fs.readFileSync(MASTER_FILE).equals(master)).toBe(true); // root never regenerates
    const row = db.get(`SELECT keyHash FROM apiKeys WHERE id = 'key-1'`);
    expect(row.keyHash).toBe(digestOf(master)); // durable detection intact
  });

  it("wrong master root on restart: sticky reject, never regenerates, not ready", async () => {
    const good = fs.readFileSync(MASTER_FILE);
    const wrong = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 11 + 5) % 256));
    fs.writeFileSync(MASTER_FILE, wrong);
    fs.chmodSync(MASTER_FILE, 0o600);
    const db = await getAdapter();
    await setSwitch(db, true);
    const boom = start();
    await expect(boom).rejects.toThrow("master key id mismatch");
    expect(isGatewayKeyStartupReady()).toBe(false);
    expect(start()).toBe(boom); // sticky: this process serves nothing
    expect(fs.readFileSync(MASTER_FILE).equals(wrong)).toBe(true); // untouched
    fs.writeFileSync(MASTER_FILE, good);
    fs.chmodSync(MASTER_FILE, 0o600);
  });

  it("sql.js flush failure keeps readiness closed and prevents background callbacks", async () => {
    const db = await getAdapter();
    const spy = vi.spyOn(db, "flushSync").mockImplementation(() => {
      throw new Error("startup flush refused");
    });
    try {
      const boom = start();
      await expect(boom).rejects.toThrow("startup flush refused");
      expect(isGatewayKeyStartupReady()).toBe(false);
      expect(start()).toBe(boom);
      const writer = vi.fn();
      await start()
        .then(writer)
        .catch(() => {});
      expect(writer).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("after startup, a second process is still refused the shared DATA_DIR", async () => {
    const root = fs.mkdtempSync(path.join(tmp, "child-"));
    const source = fs.readFileSync(path.join(src, "lib/db/processLock.js"), "utf8");
    const badImport = source.match(/from\s+"(?!node:)[^"]+"/);
    if (badImport) throw new Error("processLock.js gained a non-builtin import");
    fs.writeFileSync(path.join(root, "processLock.mjs"), source);
    const marker = path.join(root, "second.marker");
    fs.writeFileSync(
      path.join(root, "main.mjs"),
      `import fs from "node:fs";
import { acquireExclusiveWriterLock } from "./processLock.mjs";
try {
  acquireExclusiveWriterLock(process.argv[2]);
  fs.writeFileSync(process.argv[3], "acquired");
} catch (err) {
  fs.writeFileSync(process.argv[3] + ".err", (err && err.code) || String(err));
  process.exitCode = 1;
}
`,
    );
    const child = spawn(process.execPath, [path.join(root, "main.mjs"), DATA_DIR, marker], {
      stdio: "ignore",
    });
    try {
      await waitFor(() => fs.existsSync(`${marker}.err`));
      expect(fs.readFileSync(`${marker}.err`, "utf8")).toBe("DB_WRITER_LOCK_HELD");
      expect(fs.existsSync(marker)).toBe(false); // never acquired, no DB access
    } finally {
      child.kill();
    }
  });
});
