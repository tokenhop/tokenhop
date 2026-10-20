import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqlJsAdapter } from "@/lib/db/adapters/sqljsAdapter.js";
import { readCredentialEncryptionState } from "@/lib/db/credentialEncryptionState.js";
import { readApiKeyStorageState } from "@/lib/db/apiKeyState.js";
import { prepareCredentialContext } from "@/lib/db/helpers/credentialStorage.js";

vi.mock("@/lib/db/driver.js", () => ({ getAdapter: vi.fn() }));
vi.mock("@/lib/security/masterKey.js", async (importOriginal) => ({
  ...(await importOriginal()),
  loadMasterKey: vi.fn(),
}));
import { getAdapter } from "@/lib/db/driver.js";
import { loadMasterKey } from "@/lib/security/masterKey.js";
import { prepareCredentialCtx } from "@/lib/db/repos/connectionsRepo.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";

let db;
const kid = "0123456789abcdef";
const invalid = (code) => expect.objectContaining({ code });
const markerReads = () => db.all.mock.calls.filter(([sql]) => sql.includes("FROM _meta")).length;
function meta(key, value) {
  db.run("INSERT OR REPLACE INTO _meta(key,value) VALUES(?,?)", [key, value]);
}
function encrypted() {
  meta("credentialsEncryptedVersion", "1");
  meta("credentialsKekKid", kid);
  meta("apiKeyHashKeyWrapped", "{}");
}
function settings(raw) {
  db.run("INSERT OR REPLACE INTO settings(id,data) VALUES(1,?)", [JSON.stringify(raw)]);
}

beforeEach(async () => {
  db = await createSqlJsAdapter(path.join(process.env.DATA_DIR, "credential-efficiency.sqlite"));
  db.exec(`CREATE TABLE IF NOT EXISTS _meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS workspaceKeys(workspaceId TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY, data TEXT);`);
  db.exec("DELETE FROM _meta; DELETE FROM workspaceKeys; DELETE FROM settings;");
  vi.spyOn(db, "all");
  vi.spyOn(db, "get");
  getAdapter.mockResolvedValue(db);
  loadMasterKey.mockReset();
  loadMasterKey.mockRejectedValue(
    Object.assign(new Error("root missing"), { code: "KEY_MISSING" }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe("credential context round trips", () => {
  it("batches absent markers and retains legacy workspace-key checks", () => {
    expect(readCredentialEncryptionState(db)).toEqual({
      storage: "legacy",
      version: null,
      kekKid: null,
      cleanupPending: false,
      pendingRotation: null,
    });
    expect(markerReads()).toBe(1);
    expect(db.all.mock.calls[0][1]).toHaveLength(5);
    expect(db.get.mock.calls.some(([sql]) => sql.includes("sqlite_master"))).toBe(true);
    expect(db.get.mock.calls.some(([sql]) => sql.includes("COUNT(*)"))).toBe(true);
    db.run("INSERT INTO workspaceKeys(workspaceId) VALUES(?)", ["ws"]);
    expect(() => readCredentialEncryptionState(db)).toThrow(invalid("CREDENTIAL_STATE_INVALID"));
  });

  it.each([
    ["credentialsEncryptedVersion", "1"],
    ["credentialsKekKid", kid],
    ["credentialsCleanupPending", "bad"],
    ["credentialsPendingRotation", "{"],
  ])("rejects half/corrupt marker %s", (key, value) => {
    meta(key, value);
    expect(() => readCredentialEncryptionState(db)).toThrow(invalid("CREDENTIAL_STATE_INVALID"));
  });

  it("propagates metadata query errors", () => {
    db.all.mockImplementationOnce(() => {
      throw new Error("read failed");
    });
    expect(() => readCredentialEncryptionState(db)).toThrow("read failed");
  });

  it("reuses supplied validated state and preserves root kid validation", () => {
    encrypted();
    const state = readCredentialEncryptionState(db);
    db.all.mockClear();
    expect(prepareCredentialContext(db, { kid, key: Buffer.alloc(32) }, { state }).state).toBe(
      state,
    );
    expect(markerReads()).toBe(0);
    expect(() =>
      prepareCredentialContext(db, { kid: "wrong", key: Buffer.alloc(32) }, { state }),
    ).toThrow(invalid("KEY_MISMATCH"));
  });

  it("prepares legacy context once and encrypted context with post-load marker check", async () => {
    expect((await prepareCredentialCtx(db)).encrypted).toBe(false);
    expect(markerReads()).toBe(1);
    encrypted();
    db.all.mockClear();
    loadMasterKey.mockResolvedValue({ kid, key: Buffer.alloc(32) });
    expect((await prepareCredentialCtx(db)).encrypted).toBe(true);
    // YAN-1106: no write happens between state, signature and the post-await
    // recheck, so they share ONE live read (write-generation memo). A write in
    // that window still forces a re-read: see marker-generation.test.js.
    expect(markerReads()).toBe(1);
  });

  it("batches API-key markers with stable null semantics and half-marker errors", () => {
    expect(readApiKeyStorageState(db)).toEqual({ storage: "legacy", version: null, hashKid: null });
    expect(markerReads()).toBe(1);
    meta("apiKeysHashedVersion", "1");
    expect(() => readApiKeyStorageState(db)).toThrow(invalid("API_KEY_STATE_INVALID"));
    meta("apiKeysHashKid", kid);
    expect(readApiKeyStorageState(db)).toEqual({ storage: "hashed", version: 1, hashKid: kid });
  });

  it("reads empty settings on encrypted storage without loading missing root", async () => {
    encrypted();
    settings({ oidcClientSecret: "", outboundProxyUrl: null, requireLogin: true });
    expect((await getSettings()).requireLogin).toBe(true);
    expect(loadMasterKey).not.toHaveBeenCalled();
    expect(markerReads()).toBe(1);
    meta("credentialsCleanupPending", "bad");
    await expect(getSettings()).rejects.toThrow(invalid("CREDENTIAL_STATE_INVALID"));
  });

  it("nonempty envelopes still need root, lookalikes still reject without marker", async () => {
    settings({ oidcClientSecret: { v: 1, kid, iv: "", ct: "", tag: "" } });
    encrypted();
    await expect(getSettings()).rejects.toThrow(invalid("KEY_MISSING"));
    expect(loadMasterKey).toHaveBeenCalledOnce();
    db.exec("DELETE FROM _meta");
    await expect(getSettings()).rejects.toThrow(invalid("ENVELOPE_INVALID"));
  });
});

import fs from "node:fs";
import os from "node:os";
import { runMigrationOnce } from "@/lib/db/migrate.js";
import { hashApiKey } from "@/lib/security/masterKey.js";
import { activateCredentialEncryption } from "@/lib/db/activateCredentialEncryption.js";
import { rotateKek } from "@/lib/security/keyRotation.js";
import { updateSettings } from "@/lib/db/repos/settingsRepo.js";

describe("settings writes reject a rotation committed during root load", () => {
  const secret = "settings-rotation-secret";
  let ambient, realDb, MASTER, NEW_MASTER, KID, NEW_KID;

  beforeEach(async () => {
    const { masterKeyId, deriveApiKeyHashKey } = await import("@/lib/security/masterKey.js");
    MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));
    NEW_MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 23 + 9) % 256));
    KID = masterKeyId(MASTER);
    NEW_KID = masterKeyId(NEW_MASTER);
    ambient = process.env.DATA_DIR;
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-settings-rotate-"));
    realDb = await createSqlJsAdapter(path.join(process.env.DATA_DIR, "db.sqlite"));
    await runMigrationOnce(realDb);
    realDb.exec(`DROP TABLE IF EXISTS apiKeys`);
    realDb.run(`INSERT INTO users(id,email,username,displayName,instanceRole,status,sessionVersion,createdAt,updatedAt)
      VALUES('owner-x','owner@x.test','owner','owner','owner','active',1,'n','n')`);
    realDb.run(`INSERT INTO workspaces(id,name,kind,createdBy,createdAt,updatedAt)
      VALUES('ws-x','Default','shared','owner-x','n','n')`);
    realDb.run(
      `INSERT INTO memberships(workspaceId,userId,role,source,createdAt) VALUES('ws-x','owner-x','owner','manual','n')`,
    );
    realDb.run(`INSERT INTO _meta(key,value) VALUES('defaultWorkspaceId','ws-x')`);
    realDb.run(`INSERT OR REPLACE INTO settings(id,data) VALUES(1,?)`, [
      JSON.stringify({ oidcClientSecret: secret }),
    ]);
    realDb.exec(`CREATE TABLE apiKeys (id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL,
      userId TEXT, createdByUserId TEXT, keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL,
      prefix TEXT NOT NULL, name TEXT, machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0,
      isActive INTEGER NOT NULL DEFAULT 1, revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]',
      allowedCombos TEXT NOT NULL DEFAULT '[]', expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
    realDb.run(
      `INSERT INTO apiKeys(id,workspaceId,userId,createdByUserId,keyHash,hashKid,prefix,name,legacy,isActive,allowedModels,createdAt)
      VALUES('hk-x','ws-x','owner-x','owner-x',?,?,'th_H','k',1,1,'[]','n')`,
      [hashApiKey("th_rotationxxxxxxxxxxxxxxxxxxxxxxxxxxx", deriveApiKeyHashKey(MASTER)), KID],
    );
    realDb.run(
      `INSERT INTO _meta(key,value) VALUES('apiKeysHashedVersion','1'),('apiKeysHashKid',?)`,
      [KID],
    );
    getAdapter.mockResolvedValue(realDb);
    await activateCredentialEncryption(realDb, {
      enabled: true,
      beforeServing: true,
      root: { kid: KID, key: MASTER },
    });
    loadMasterKey.mockReset();
  });

  afterEach(() => {
    realDb.close();
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
    process.env.DATA_DIR = ambient;
  });

  it("aborts a settings secret write when KEK rotates during root load; no-secret writes unaffected", async () => {
    // updateSettings read the marker (old KEK), then rotation commits while the
    // root loads: the write must fail closed and leave the stored row untouched.
    loadMasterKey.mockImplementationOnce(async () => {
      await rotateKek(realDb, {
        newRoot: { kid: NEW_KID, key: NEW_MASTER },
        root: { kid: KID, key: MASTER },
        fileManaged: false,
      });
      return { kid: KID, key: MASTER };
    });
    const before = realDb.get(`SELECT data FROM settings WHERE id = 1`).data;
    await expect(updateSettings({ oidcClientSecret: "new-secret" })).rejects.toMatchObject({
      code: "KEY_MISMATCH",
    });
    expect(realDb.get(`SELECT data FROM settings WHERE id = 1`).data).toBe(before);
    expect(before).not.toContain("new-secret");

    // Post-rotation the live marker is NEW_KID: a fresh write succeeds, decrypts.
    loadMasterKey.mockImplementation(async () => ({ kid: NEW_KID, key: NEW_MASTER }));
    await updateSettings({ oidcClientSecret: "after-rotation" });
    expect((await getSettings()).oidcClientSecret).toBe("after-rotation");
    expect(realDb.get(`SELECT data FROM settings WHERE id = 1`).data).not.toContain(
      "after-rotation",
    );

    // A non-secret update preserves the existing encrypted secret.
    loadMasterKey.mockClear();
    await expect(updateSettings({ requireLogin: false })).resolves.toMatchObject({
      requireLogin: false,
    });
  });
});
