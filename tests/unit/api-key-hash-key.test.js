// YAN-365 (D6): the single stable API-key hash-key getter and the maintenance
// admission seam. Hash identity is frozen (`apiKeysHashKid`); the current KEK
// identity is `credentialsKekKid`. After KEK rotation the SAME derived key
// comes back (wrapped bytes only change), never an HKDF of the rotated root.
// Poisoned adapters block raw mutations and credential use until restart.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertIsolatedHome } from "../helpers/isolatedHome.js";

const root = process.env.TOKENHOP_TEST_ROOT;

let dir;
let adapter;

beforeEach(() => {
  assertIsolatedHome();
  dir = fs.mkdtempSync(path.join(root, "api-hash-key-"));
});

afterEach(() => {
  try {
    adapter?.close?.();
  } catch {}
  adapter = null;
});

async function fixture({ encrypted = false, rotated = false } = {}) {
  const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
  const { runVersionedMigrations } = await import("@/lib/db/migrate.js");
  const { HASHED_API_KEYS_TABLE, buildCreateTableSql } = await import("@/lib/db/schema.js");
  const { deriveApiKeyHashKey, masterKeyId } = await import("@/lib/security/masterKey.js");
  const { buildHashKeyWrapAad, encryptBytes } = await import("@/lib/security/envelope.js");
  const db = await createSqlJsAdapter(
    path.join(dir, `${encrypted ? "enc" : "legacy"}-${rotated}.sqlite`),
  );
  adapter = db;
  runVersionedMigrations(db);
  db.exec(`DROP TABLE apiKeys; ${buildCreateTableSql("apiKeys", HASHED_API_KEYS_TABLE)}`);
  const originalMaster = crypto.randomBytes(32);
  const hashKid = masterKeyId(originalMaster); // frozen identity == root kid until first rotation
  const set = (k, v) =>
    db.run(
      `INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [k, v],
    );
  set("apiKeysHashedVersion", "1");
  set("apiKeysHashKid", hashKid);
  set("defaultWorkspaceId", "ws-default");
  db.run(
    `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES('ws-default', 'Default', 'shared', NULL, 't', 't')`,
  );
  const derived = deriveApiKeyHashKey(originalMaster);
  let rootObj = { kid: hashKid, key: Buffer.from(originalMaster) };
  let kekForWrap = null;
  if (encrypted) {
    const kek = rotated ? crypto.randomBytes(32) : Buffer.from(originalMaster);
    const kekKid = masterKeyId(kek);
    set("credentialsEncryptedVersion", "1");
    set("credentialsKekKid", kekKid);
    set(
      "apiKeyHashKeyWrapped",
      JSON.stringify(
        encryptBytes(kek, kekKid, derived, buildHashKeyWrapAad("ws-default", hashKid)),
      ),
    );
    rootObj = { kid: kekKid, key: Buffer.from(kek) };
    kekForWrap = kek;
  }
  return { db, hashKid, originalMaster, derived, root: rootObj, kekForWrap };
}

const code = async (p) =>
  p.then(
    () => null,
    (e) => e.code,
  );

describe("getApiKeyHashKey / resolveApiKeyHashKeySync", () => {
  it("pre-encryption: HKDF of the frozen kid's master, byte-identical to the old derivation", async () => {
    const { getApiKeyHashKey, resolveApiKeyHashKeySync } = await import(
      "@/lib/security/apiKeyHashKey.js"
    );
    const { db, hashKid, derived, root } = await fixture();
    const viaFacade = await getApiKeyHashKey(db, { root });
    const viaSync = resolveApiKeyHashKeySync(db, root);
    for (const got of [viaFacade, viaSync]) {
      expect(got.hashKid).toBe(hashKid);
      expect(got.hashKey.equals(derived)).toBe(true);
    }
    // The facade without a root loads the master itself (env path here).
    const env = process.env.TOKENHOP_MASTER_KEY;
    process.env.TOKENHOP_MASTER_KEY = root.key.toString("base64");
    try {
      const loaded = await getApiKeyHashKey(db);
      expect(loaded.hashKey.equals(derived)).toBe(true);
    } finally {
      if (env === undefined) delete process.env.TOKENHOP_MASTER_KEY;
      else process.env.TOKENHOP_MASTER_KEY = env;
    }
  });

  it("encrypted, unrotated: unwrap under the current KEK returns the SAME derived key", async () => {
    const { resolveApiKeyHashKeySync, getApiKeyHashKey } = await import(
      "@/lib/security/apiKeyHashKey.js"
    );
    const { db, hashKid, derived, root } = await fixture({ encrypted: true });
    const got = resolveApiKeyHashKeySync(db, root);
    expect(got.hashKid).toBe(hashKid); // identity split: hash kid frozen
    expect(got.hashKey.equals(derived)).toBe(true);
    expect((await getApiKeyHashKey(db, { root })).hashKey.equals(derived)).toBe(true);
  });

  it("encrypted after KEK rotation: frozen bytes survive; no rederive from the rotated root", async () => {
    const { resolveApiKeyHashKeySync } = await import("@/lib/security/apiKeyHashKey.js");
    const { deriveApiKeyHashKey } = await import("@/lib/security/masterKey.js");
    const { db, hashKid, derived, root, kekForWrap } = await fixture({
      encrypted: true,
      rotated: true,
    });
    const got = resolveApiKeyHashKeySync(db, root);
    expect(got.hashKid).toBe(hashKid); // apiKeysHashKid never rewritten
    expect(got.hashKey.equals(derived)).toBe(true); // ORIGINAL derived key
    expect(got.hashKey.equals(deriveApiKeyHashKey(kekForWrap))).toBe(false); // not HKDF(rotated KEK)
    // Existing keyHash bytes keep verifying with the returned key.
    const { hashApiKey } = await import("@/lib/security/masterKey.js");
    const raw = "th_rotation_survives_0123456789";
    const before = hashApiKey(raw, derived);
    expect(hashApiKey(raw, got.hashKey)).toBe(before);
  });

  it("wrong or tampered roots fail closed with typed codes", async () => {
    const { getApiKeyHashKey, resolveApiKeyHashKeySync } = await import(
      "@/lib/security/apiKeyHashKey.js"
    );
    const { masterKeyId } = await import("@/lib/security/masterKey.js");
    const { db, root } = await fixture({ encrypted: true });
    // A different root (kid mismatch) never unwraps.
    const wrong = { kid: masterKeyId(crypto.randomBytes(32)), key: crypto.randomBytes(32) };
    expect(await code(getApiKeyHashKey(db, { root: wrong }))).toBe("KEY_MISMATCH");
    expect(() => resolveApiKeyHashKeySync(db, wrong)).toThrowError(/root does not match/);
    expect(() => resolveApiKeyHashKeySync(db, null)).toThrowError(/root/);
    // Tampered wrapped bytes: uniform auth failure, no key material leaked.
    const raw = db.get(`SELECT value FROM _meta WHERE key = 'apiKeyHashKeyWrapped'`).value;
    const env = JSON.parse(raw);
    env.ct = (env.ct[0] === "A" ? "B" : "A") + env.ct.slice(1);
    db.run(`UPDATE _meta SET value = ? WHERE key = 'apiKeyHashKeyWrapped'`, [JSON.stringify(env)]);
    const { clearApiKeyHashKeyStateCache } = await import("@/lib/security/apiKeyHashKey.js");
    clearApiKeyHashKeyStateCache(db);
    let err = null;
    try {
      resolveApiKeyHashKeySync(db, root);
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("DECRYPT_FAILED");
    expect(err?.message).not.toContain(env.ct);
  });

  it("incoherent encrypted state (missing Default workspace id) fails closed", async () => {
    const { resolveApiKeyHashKeySync } = await import("@/lib/security/apiKeyHashKey.js");
    const { db, root } = await fixture({ encrypted: true });
    db.run(`DELETE FROM _meta WHERE key = 'defaultWorkspaceId'`);
    const { clearApiKeyHashKeyStateCache } = await import("@/lib/security/apiKeyHashKey.js");
    clearApiKeyHashKeyStateCache(db);
    expect(() => resolveApiKeyHashKeySync(db, root)).toThrowError(/defaultWorkspaceId/);
  });

  it("unhashed API key storage never yields a hash key", async () => {
    const { getApiKeyHashKey } = await import("@/lib/security/apiKeyHashKey.js");
    const { db, root } = await fixture();
    db.run(`DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion', 'apiKeysHashKid')`);
    expect(await code(getApiKeyHashKey(db, { root }))).toBe("API_KEY_STATE_INVALID");
  });
});

describe("credential maintenance admission", () => {
  it("poisoning an adapter created outside the driver installs the gate (direct createSqlJsAdapter)", async () => {
    const m = await import("@/lib/db/credentialMaintenance.js");
    const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
    const direct = await createSqlJsAdapter(path.join(dir, "direct-open.sqlite"));
    try {
      // Never touched by driver.initAdapter or installCredentialMaintenanceAdmission.
      direct.exec(`CREATE TABLE probe (k TEXT)`);
      direct.run(`INSERT INTO probe(k) VALUES('before')`);
      m.poisonCredentialMaintenance(direct, new Error("uncertain publish"));
      for (const blocked of [
        () => direct.run(`INSERT INTO probe(k) VALUES('after')`),
        () => direct.exec(`DELETE FROM probe`),
        () => direct.transaction(() => {}),
      ]) {
        let err = null;
        try {
          blocked();
        } catch (e) {
          err = e;
        }
        expect(err?.code).toBe("CREDENTIAL_MAINTENANCE_POISONED");
      }
      // Reads stay live and the rejected writes changed nothing.
      expect(direct.all(`SELECT k FROM probe`)).toEqual([{ k: "before" }]);
    } finally {
      try {
        direct.close();
      } catch {}
    }
  });

  it("poison survives module re-evaluation (HMR / vi.resetModules)", async () => {
    const first = await import("@/lib/db/credentialMaintenance.js");
    const { db } = await fixture();
    first.poisonCredentialMaintenance(db, new Error("uncertain commit"));
    expect(first.isCredentialMaintenancePoisoned(db)).toBe(true);
    vi.resetModules();
    const second = await import("@/lib/db/credentialMaintenance.js");
    expect(second).not.toBe(first); // a genuinely fresh module instance
    expect(second.isCredentialMaintenancePoisoned(db)).toBe(true);
    expect(() => second.assertCredentialOperationAllowed(db)).toThrowError(/blocked until restart/);
    // The gate wrapped by the first instance still fences raw writes.
    let err = null;
    try {
      db.run(`INSERT INTO _meta(key, value) VALUES('hmr-probe', '1')`);
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("CREDENTIAL_MAINTENANCE_POISONED");
  });

  it("runCredentialMaintenanceSync is the only privilege: sync, lexical, poisoning on thenable", async () => {
    const m = await import("@/lib/db/credentialMaintenance.js");
    const { db } = await fixture();
    expect(m.isInCredentialMaintenance(db)).toBe(false);
    const out = m.runCredentialMaintenanceSync(db, () => {
      expect(m.isInCredentialMaintenance(db)).toBe(true);
      return 42;
    });
    expect(out).toBe(42);
    expect(m.isInCredentialMaintenance(db)).toBe(false);
    // A throwing callback propagates without poisoning.
    expect(() =>
      m.runCredentialMaintenanceSync(db, () => {
        throw new Error("boom");
      }),
    ).toThrowError("boom");
    expect(m.isCredentialMaintenancePoisoned(db)).toBe(false);
    // A thenable callback poisons: privilege cannot span an await.
    let thenableErr = null;
    try {
      m.runCredentialMaintenanceSync(db, () => Promise.resolve(1));
    } catch (e) {
      thenableErr = e;
    }
    expect(thenableErr?.code).toBe("CALLBACK_NOT_SYNC");
    expect(m.isCredentialMaintenancePoisoned(db)).toBe(true);
  });

  it("poison is terminal: credential use and raw mutations blocked, reads live", async () => {
    const m = await import("@/lib/db/credentialMaintenance.js");
    const { db } = await fixture();
    m.poisonCredentialMaintenance(
      db,
      Object.assign(new Error("flush failed"), { code: "E_FLUSH" }),
    );
    expect(m.isCredentialMaintenancePoisoned(db)).toBe(true);
    let err = null;
    try {
      m.assertCredentialOperationAllowed(db);
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("CREDENTIAL_MAINTENANCE_POISONED");
    expect(err?.message).toContain("flush failed");
    // New maintenance is refused while poisoned; first cause is kept.
    expect(() => m.runCredentialMaintenanceSync(db, () => 1)).toThrowError(/blocked until restart/);
    m.poisonCredentialMaintenance(db, new Error("second"));
    try {
      m.assertCredentialOperationAllowed(db);
    } catch (e) {
      expect(e.message).toContain("flush failed");
    }
  });

  it("the driver adapter gates run/exec/transaction once poisoned; get/all survive", async () => {
    vi.resetModules();
    const dataDir = fs.mkdtempSync(path.join(root, "driver-gate-"));
    process.env.DATA_DIR = dataDir;
    try {
      const { getAdapter } = await import("@/lib/db/driver.js");
      const m = await import("@/lib/db/credentialMaintenance.js");
      const { getApiKeyHashKey } = await import("@/lib/security/apiKeyHashKey.js");
      const db = await getAdapter();
      db.run(`INSERT INTO _meta(key, value) VALUES('gate-probe', '1')`);
      expect(db.get(`SELECT value FROM _meta WHERE key = 'gate-probe'`).value).toBe("1");
      expect(typeof db.transaction(() => db.get(`SELECT 1 AS x`)).x).toBe("number");
      m.poisonCredentialMaintenance(db, new Error("uncertain commit"));
      for (const blocked of [
        () => db.run(`INSERT INTO _meta(key, value) VALUES('x','y')`),
        () => db.exec(`DELETE FROM _meta WHERE key = 'nope'`),
        () => db.transaction(() => {}),
      ]) {
        let err = null;
        try {
          blocked();
        } catch (e) {
          err = e;
        }
        expect(err?.code).toBe("CREDENTIAL_MAINTENANCE_POISONED");
      }
      // Reads still work (metadata/diagnosis), and credential use is refused.
      expect(db.get(`SELECT value FROM _meta WHERE key = 'gate-probe'`).value).toBe("1");
      expect(Array.isArray(db.all(`SELECT key FROM _meta`))).toBe(true);
      await expect(getApiKeyHashKey(db)).rejects.toMatchObject({
        code: "CREDENTIAL_MAINTENANCE_POISONED",
      });
    } finally {
      delete process.env.DATA_DIR;
    }
  });
});
