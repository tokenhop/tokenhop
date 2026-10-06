// YAN-365 (task 2.4, T lane): C5–C8 lifecycle integration tests — KEK/DEK
// rotation, crash boundaries, workspace deletion / cache purge, Default
// protection, env-managed KEK refusal, MITM established reads. Authored red
// in B2 against B1 contracts; O turns green in B3/B4/B6. B4+ module imports
// are lazy so red failures always name a missing contract, not a load error.
//
// Real sql.js adapter, isolated temp DATA_DIR/HOME (tests/vitest.config.js).
// Crash-boundary fixtures use a child process with an independent disk reopen
// (not vi.resetModules / in-memory reuse) per the testing strategy.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqlJsAdapter } from "@/lib/db/adapters/sqljsAdapter.js";
import { runMigrationOnce } from "@/lib/db/migrate.js";
import { readCredentialEncryptionState } from "@/lib/db/credentialEncryptionState.js";
import {
  clearCredentialCache,
  decodeCredentialRowSync,
  prepareCredentialContext,
} from "@/lib/db/helpers/credentialStorage.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { BACKUPS_DIR } from "@/lib/db/paths.js";
import { assertIsolatedHome } from "../helpers/isolatedHome.js";

const loadActivate = () => import("../../src/lib/db/activateCredentialEncryption.js");
const loadRotation = () => import("../../src/lib/security/keyRotation.js");

const NOW = "2026-10-06T00:00:00.000Z";
const MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));
const NEW_MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 23 + 9) % 256));
const KID = masterKeyId(MASTER);
const NEW_KID = masterKeyId(NEW_MASTER);
const OLD_HASH_KEY = deriveApiKeyHashKey(MASTER);
const RAW = "th_HASHEDGATEWAYTOKENxxxxxxxxxxxxxxx";
const RAW_LEGACY = "sk-machineid12345678-abc123-0f1e2d3c";
const digest = (raw, key = OLD_HASH_KEY) => hashApiKey(raw, key);
const DEFAULT_WS = "ws-default";
const OTHER_WS = "ws-other";
const code = (c) => expect.objectContaining({ code: c });
const KEYS_DIR = () => path.join(process.env.DATA_DIR, "keys");

// Real 0600 master file in a 0700 keys dir under the isolated DATA_DIR.
function provisionMasterFile(key) {
  assertIsolatedHome();
  fs.mkdirSync(KEYS_DIR(), { recursive: true, mode: 0o700 });
  fs.chmodSync(KEYS_DIR(), 0o700);
  const file = path.join(KEYS_DIR(), "master");
  fs.writeFileSync(file, key, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

let tempDir;
let db;

function seedEncryptedReady() {
  db.exec(`DROP TABLE IF EXISTS apiKeys`);
  db.exec(`DELETE FROM memberships; DELETE FROM identities; DELETE FROM providerNodes;
    DELETE FROM providerConnections; DELETE FROM workspaces; DELETE FROM users;
    DELETE FROM _meta WHERE key IN ('defaultWorkspaceId','apiKeysHashedVersion','apiKeysHashKid')`);
  db.run(
    `INSERT INTO users(id, email, username, displayName, instanceRole, status, sessionVersion, createdAt, updatedAt)
     VALUES('owner-1','owner@x.test','owner','owner','owner','active',1,?,?)`,
    [NOW, NOW],
  );
  db.run(
    `INSERT INTO users(id, email, username, displayName, instanceRole, status, sessionVersion, createdAt, updatedAt)
     VALUES('user-1','user@x.test','user','user','user','active',1,?,?)`,
    [NOW, NOW],
  );
  for (const [id, kind, by] of [
    [DEFAULT_WS, "shared", "owner-1"],
    [OTHER_WS, "shared", "owner-1"],
  ]) {
    db.run(
      `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES(?,?,?,?,?,?)`,
      [id, id, kind, by, NOW, NOW],
    );
    db.run(
      `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?,?,?,?,?)`,
      [id, "owner-1", "owner", "manual", NOW],
    );
  }
  db.run(`INSERT INTO _meta(key, value) VALUES('defaultWorkspaceId', ?)`, [DEFAULT_WS]);
  db.run(`INSERT INTO settings(id, data) VALUES(1, ?)`, [
    JSON.stringify({
      oidcClientSecret: "sk-sent-oidcClientSecret-3522",
      samlPrivateKey: "sk-sent-samlPrivateKey-3523",
      samlDecryptionKey: "sk-sent-samlDecryptionKey-3524",
      samlSigningKey: "sk-sent-samlSigningKey-3525",
      mitmSudoEncrypted: "sk-sent-mitmSudoEncrypted-3526",
    }),
  ]);
  for (const [id, ws, token] of [
    ["conn-default", DEFAULT_WS, "sk-sent-default-token-3527"],
    ["conn-other", OTHER_WS, "sk-sent-other-token-3528"],
  ]) {
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, workspaceId, createdByUserId, createdAt, updatedAt)
       VALUES(?, 'openai','api_key',?,NULL,1,1,?,?,'owner-1',?,?)`,
      [id, id, JSON.stringify({ accessToken: token }), ws, NOW, NOW],
    );
  }
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    userId TEXT REFERENCES users(id) ON DELETE CASCADE,
    createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
    keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
    machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
    revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
    expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
  db.run(
    `INSERT INTO apiKeys(id, workspaceId, userId, createdByUserId, keyHash, hashKid, prefix, name, legacy, isActive, allowedModels, createdAt)
     VALUES('hk-1', ?, 'owner-1', 'owner-1', ?, ?, ?, 'Runner', 1, 1, '[]', ?)`,
    [OTHER_WS, digest(RAW), KID, "th_HA", NOW],
  );
  db.run(`INSERT INTO _meta(key, value) VALUES('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)`, [
    KID,
  ]);
}

async function activated(extra = {}) {
  const { activateCredentialEncryption } = await loadActivate();
  const result = await activateCredentialEncryption(db, {
    enabled: true,
    beforeServing: true,
    root: { kid: KID, key: MASTER },
    ...extra,
  });
  expect(result).toMatchObject({ status: "ready" });
  return result;
}

function decodedToken(_ws, connId, root = { kid: KID, key: MASTER }) {
  const ctx = prepareCredentialContext(db, root);
  return decodeCredentialRowSync(
    db,
    db.get(`SELECT * FROM providerConnections WHERE id = ?`, [connId]),
    ctx,
    {
      table: "providerConnections",
      mode: "runtime",
    },
  ).accessToken;
}

beforeEach(async () => {
  assertIsolatedHome();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-cred-lifecycle-"));
  db = await createSqlJsAdapter(path.join(tempDir, "act.sqlite"));
  await runMigrationOnce(db);
  seedEncryptedReady();
});

afterEach(() => {
  clearCredentialCache(db);
  db?.close();
  db = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
  assertIsolatedHome();
  fs.rmSync(KEYS_DIR(), { recursive: true, force: true });
  fs.rmSync(BACKUPS_DIR, { recursive: true, force: true });
});

describe("KEK rotation (C5/D6/D12)", () => {
  it("rewraps DEKs and the derived hash key; field bytes, keyHashes and hash identity unchanged", async () => {
    await activated();
    const beforeKeys = db.all(
      `SELECT workspaceId, kid, wrappedDek FROM workspaceKeys ORDER BY workspaceId`,
    );
    const beforeRows = db.all(`SELECT id, data FROM providerConnections ORDER BY id`);
    const beforeHash = db.get(`SELECT keyHash, hashKid FROM apiKeys WHERE id = 'hk-1'`);
    const beforeSettings = db.get(`SELECT data FROM settings WHERE id = 1`).data;

    const { rotateKek } = await loadRotation();
    await rotateKek(db, {
      newRoot: { kid: NEW_KID, key: NEW_MASTER },
      root: { kid: KID, key: MASTER },
      fileManaged: false,
    });

    // Root identity moved; hash-key identity and bytes frozen (D6).
    expect(readCredentialEncryptionState(db)).toMatchObject({
      storage: "encrypted",
      kekKid: NEW_KID,
    });
    expect(db.get(`SELECT keyHash, hashKid FROM apiKeys WHERE id = 'hk-1'`)).toEqual(beforeHash);
    // Credential ciphertext untouched by KEK rotation (only wraps change).
    expect(db.all(`SELECT id, data FROM providerConnections ORDER BY id`)).toEqual(beforeRows);
    expect(db.get(`SELECT data FROM settings WHERE id = 1`).data).toBe(beforeSettings);
    // Every DEK rewrapped under the new root: same workspaces, same DEK kids,
    // different wrapped bytes, and unwrap succeeds with the new root only.
    const afterKeys = db.all(
      `SELECT workspaceId, kid, wrappedDek FROM workspaceKeys ORDER BY workspaceId`,
    );
    expect(afterKeys.map((r) => r.workspaceId)).toEqual(beforeKeys.map((r) => r.workspaceId));
    expect(afterKeys.map((r) => r.kid)).toEqual(beforeKeys.map((r) => r.kid));
    expect(afterKeys.every((r, i) => r.wrappedDek !== beforeKeys[i].wrappedDek)).toBe(true);
    clearCredentialCache(db);
    expect(decodedToken(DEFAULT_WS, "conn-default", { kid: NEW_KID, key: NEW_MASTER })).toBe(
      "sk-sent-default-token-3527",
    );
    expect(() => decodedToken(DEFAULT_WS, "conn-default", { kid: KID, key: MASTER })).toThrow(
      code("KEY_MISMATCH"),
    );
    // The same raw gateway keys still authenticate (H1-class check via digest
    // stability): digest under the preserved derived key matches the stored hash.
    expect(hashApiKey(RAW, OLD_HASH_KEY)).toBe(beforeHash.keyHash);
  });

  it("no retired/old master file remains after a successful file rotation", async () => {
    await activated();
    provisionMasterFile(MASTER);
    const { rotateKek } = await loadRotation();
    await rotateKek(db, { newRoot: { kid: NEW_KID, key: NEW_MASTER }, fileManaged: true });
    expect(fs.readFileSync(path.join(KEYS_DIR(), "master")).equals(NEW_MASTER)).toBe(true);
    const names = fs.existsSync(KEYS_DIR()) ? fs.readdirSync(KEYS_DIR()).sort() : [];
    expect(names).toEqual(["master"]);
  });

  it("pending-rotation marker is durable and recovery finishes before readiness (DB-first)", async () => {
    await activated();
    provisionMasterFile(MASTER);
    const { rotateKek } = await loadRotation();
    // Crash boundary: durable DB rewrap + pending marker written, rename not
    // yet performed — recovery promotes the staged key only after proof.
    const result = await rotateKek(db, {
      newRoot: { kid: NEW_KID, key: NEW_MASTER },
      fileManaged: true,
      crashAfter: "commit-before-rename",
    });
    expect(result).toMatchObject({ status: "crash-pending-rotation" });
    const state = readCredentialEncryptionState(db);
    expect(state.pendingRotation).toMatchObject({ oldKid: KID, newKid: NEW_KID });

    const reopened = await createSqlJsAdapter(path.join(tempDir, "act.sqlite"));
    try {
      const { recoverKeyRotation } = await loadRotation();
      const recovered = await recoverKeyRotation(reopened);
      expect(recovered).toMatchObject({ status: "ready" });
      expect(readCredentialEncryptionState(reopened).pendingRotation).toBeNull();
      expect(readCredentialEncryptionState(reopened).kekKid).toBe(NEW_KID);
      const ctx = prepareCredentialContext(reopened, { kid: NEW_KID, key: NEW_MASTER });
      const decoded = decodeCredentialRowSync(
        reopened,
        reopened.get(`SELECT * FROM providerConnections WHERE id = 'conn-other'`),
        ctx,
        { table: "providerConnections", mode: "runtime" },
      );
      expect(decoded.accessToken).toBe("sk-sent-other-token-3528");
      const names = fs.readdirSync(KEYS_DIR()).sort();
      expect(names).toEqual(["master"]);
    } finally {
      clearCredentialCache(reopened);
      reopened.close();
    }
  });

  it("env-managed KEK rotation is refused with 409 KEK_ENV_MANAGED and zero mutation (D9)", async () => {
    await activated();
    const before = db.snapshot();
    // activated() itself took the activation backup; rotation must add none.
    const backupsBefore = fs.existsSync(BACKUPS_DIR) ? fs.readdirSync(BACKUPS_DIR).sort() : [];
    process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
    try {
      const { rotateKek } = await loadRotation();
      await expect(
        rotateKek(db, { newRoot: { kid: NEW_KID, key: NEW_MASTER } }),
      ).rejects.toMatchObject({ code: "KEK_ENV_MANAGED", status: 409 });
      expect(db.snapshot().equals(before)).toBe(true);
      expect(fs.existsSync(KEYS_DIR())).toBe(false);
      expect(fs.existsSync(BACKUPS_DIR) ? fs.readdirSync(BACKUPS_DIR).sort() : []).toEqual(
        backupsBefore,
      );
    } finally {
      delete process.env.TOKENHOP_MASTER_KEY;
    }
  });
});

describe("workspace DEK rotation (C6/D5)", () => {
  it("re-encrypts only the target workspace including Default instance settings", async () => {
    await activated();
    const beforeOther = db.get(`SELECT data FROM providerConnections WHERE id = 'conn-other'`);
    const beforeKeys = db.all(`SELECT * FROM workspaceKeys ORDER BY workspaceId`);

    const { rotateWorkspaceDek } = await loadRotation();
    await rotateWorkspaceDek(db, DEFAULT_WS, { root: { kid: KID, key: MASTER } });

    const afterKeys = db.all(`SELECT * FROM workspaceKeys ORDER BY workspaceId`);
    const target = afterKeys.find((r) => r.workspaceId === DEFAULT_WS);
    const oldTarget = beforeKeys.find((r) => r.workspaceId === DEFAULT_WS);
    expect(target.kid).not.toBe(oldTarget.kid);
    expect(target.wrappedDek).not.toBe(oldTarget.wrappedDek);
    // Other workspace DEK untouched, its ciphertext byte-identical.
    const other = afterKeys.find((r) => r.workspaceId === OTHER_WS);
    const oldOther = beforeKeys.find((r) => r.workspaceId === OTHER_WS);
    expect(other).toEqual(oldOther);
    expect(db.get(`SELECT data FROM providerConnections WHERE id = 'conn-other'`)).toEqual(
      beforeOther,
    );
    // Default connection ciphertext changed (new DEK kid inside).
    const changed = JSON.parse(
      db.get(`SELECT data FROM providerConnections WHERE id = 'conn-default'`).data,
    );
    expect(changed.accessToken.kid).toBe(target.kid);
    // Settings rotated in the same transaction (D5).
    const settingsRow = JSON.parse(db.get(`SELECT data FROM settings WHERE id = 1`).data);
    expect(settingsRow.oidcClientSecret.kid).toBe(target.kid);
    // Old plaintext of rotated fields is gone from the DB text.
    expect(db.get(`SELECT data FROM settings WHERE id = 1`).data).not.toContain(
      "sk-sent-oidcClientSecret-3522",
    );
  });

  it("DEK rotation works under an env-managed KEK root", async () => {
    await activated();
    process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
    try {
      const { rotateWorkspaceDek } = await loadRotation();
      await rotateWorkspaceDek(db, OTHER_WS);
      clearCredentialCache(db);
      expect(decodedToken(OTHER_WS, "conn-other")).toBe("sk-sent-other-token-3528");
    } finally {
      delete process.env.TOKENHOP_MASTER_KEY;
    }
  });
});

describe("workspace deletion, Default protection and cache purge (C7/D5/D7)", () => {
  it("deleting a workspace removes its DEK row and evicts its cached DEK (crypto-shredding)", async () => {
    await activated();
    // Warm the cache, then delete through the repo seam.
    expect(decodedToken(OTHER_WS, "conn-other")).toBe("sk-sent-other-token-3528");
    // Capture the stored envelope before deletion: the fabricated-row probe
    // below must carry a real envelope, otherwise nothing would ask for a DEK.
    const stored = JSON.parse(
      db.get(`SELECT data FROM providerConnections WHERE id = 'conn-other'`).data,
    );
    // Adapter-passed twin: tenancy-guard lint requires deleteWorkspace to take ctx.
    const { deleteWorkspaceUnscoped: deleteWorkspace } = await import(
      "../../src/lib/db/repos/workspacesRepo.js"
    );
    await deleteWorkspace(db, OTHER_WS, { actor: { id: "owner-1", instanceRole: "owner" } });
    expect(
      db.get(`SELECT COUNT(*) AS c FROM workspaceKeys WHERE workspaceId = ?`, [OTHER_WS]).c,
    ).toBe(0);
    // Cache resurrection must not serve the evicted DEK: no rows remain.
    const ctx = prepareCredentialContext(db, { kid: KID, key: MASTER });
    const rows = db.all(`SELECT * FROM providerConnections WHERE id = 'conn-other'`);
    expect(rows).toEqual([]);
    expect(() =>
      decodeCredentialRowSync(
        db,
        {
          id: "conn-other",
          data: JSON.stringify({ accessToken: stored.accessToken }),
          workspaceId: OTHER_WS,
        },
        ctx,
        {
          table: "providerConnections",
          mode: "runtime",
        },
      ),
    ).toThrow(code("KEY_MISSING"));
  });

  it("Default deletion is always refused with 409 DEFAULT_WORKSPACE_PROTECTED, secrets or not (D5)", async () => {
    await activated();
    // Adapter-passed twin: tenancy-guard lint requires deleteWorkspace to take ctx.
    const { deleteWorkspaceUnscoped: deleteWorkspace } = await import(
      "../../src/lib/db/repos/workspacesRepo.js"
    );
    const before = db.snapshot();
    await expect(
      deleteWorkspace(db, DEFAULT_WS, { actor: { id: "owner-1", instanceRole: "owner" } }),
    ).rejects.toMatchObject({ code: "DEFAULT_WORKSPACE_PROTECTED", status: 409 });
    expect(db.snapshot().equals(before)).toBe(true);
    expect(
      db.get(`SELECT COUNT(*) AS c FROM workspaceKeys WHERE workspaceId = ?`, [DEFAULT_WS]).c,
    ).toBe(1);
    // Refused even after the instance secrets were cleared from settings.
    db.run(`UPDATE settings SET data = ? WHERE id = 1`, [
      JSON.stringify({ displayName: "instance" }),
    ]);
    const before2 = db.snapshot();
    await expect(
      deleteWorkspace(db, DEFAULT_WS, { actor: { id: "owner-1", instanceRole: "owner" } }),
    ).rejects.toMatchObject({ code: "DEFAULT_WORKSPACE_PROTECTED", status: 409 });
    expect(db.snapshot().equals(before2)).toBe(true);
  });
});

describe("per-row integrity after disk reopen (D3)", () => {
  it("corrupt credential allows recovery; only its runtime read fails without poison", async () => {
    await activated();
    const row = db.get("SELECT * FROM providerConnections WHERE id = 'conn-other'");
    const raw = JSON.parse(row.data);
    raw.accessToken.tag = Buffer.alloc(16).toString("base64");
    db.run("UPDATE providerConnections SET data = ? WHERE id = 'conn-other'", [
      JSON.stringify(raw),
    ]);
    db.flushSync();
    const reopened = await createSqlJsAdapter(path.join(tempDir, "act.sqlite"));
    try {
      const { activateCredentialEncryption } = await loadActivate();
      const { isCredentialMaintenancePoisoned } = await import("@/lib/db/credentialMaintenance.js");
      await expect(
        activateCredentialEncryption(reopened, {
          enabled: false,
          beforeServing: true,
          root: { kid: KID, key: MASTER },
        }),
      ).resolves.toMatchObject({ status: "ready" });
      const ctx = prepareCredentialContext(reopened, { kid: KID, key: MASTER });
      expect(() =>
        decodeCredentialRowSync(
          reopened,
          reopened.get("SELECT * FROM providerConnections WHERE id = 'conn-other'"),
          ctx,
          { table: "providerConnections" },
        ),
      ).toThrow(code("DECRYPT_FAILED"));
      expect(
        decodeCredentialRowSync(
          reopened,
          reopened.get("SELECT * FROM providerConnections WHERE id = 'conn-default'"),
          ctx,
          { table: "providerConnections" },
        ).accessToken,
      ).toBe("sk-sent-default-token-3527");
      expect(isCredentialMaintenancePoisoned(reopened)).toBe(false);
    } finally {
      clearCredentialCache(reopened);
      reopened.close();
    }
  });
});

describe("legacy MITM (D11/C3 corner)", () => {
  it("activation strictly decrypts the legacy machine cipher once; corrupt sudo aborts activation typed", async () => {
    // Seed a legacy MITM value in the legacy machine format ivHex:tagHex:ctHex.
    const legacyBlob = { mitmSudoEncrypted: "00112233445566778899aabb:1122:deadbeef" };
    db.run(`UPDATE settings SET data = ? WHERE id = 1`, [JSON.stringify(legacyBlob)]);
    const { activateCredentialEncryption } = await loadActivate();
    await expect(
      activateCredentialEncryption(db, {
        enabled: true,
        beforeServing: true,
        root: { kid: KID, key: MASTER },
      }),
    ).rejects.toMatchObject({ code: expect.any(String) }); // typed abort, never silent null
    // Zero mutation on abort: no marker latched, no DEKs.
    expect(() => readCredentialEncryptionState(db)).not.toThrow();
    expect(db.get(`SELECT COUNT(*) AS c FROM workspaceKeys`).c).toBe(0);
  });
});

describe("crash boundaries via child process with independent disk reopen", () => {
  // Shared fixture DB the child activates into; the child is killed at a named
  // boundary, then a fresh adapter reopen (here, and again in a second child)
  // must recover without plaintext loss or a regenerated root.
  // Plain Node child: a resolve hook mirrors vitest's `@/` + `open-sse/`
  // aliases (vitest applies them to the parent only) and completes Node's
  // ESM resolution for this repo's extensionless / directory imports
  // (e.g. `@/shared/brand` -> `src/shared/brand/index.js`).
  // Same isolated HOME/DATA_DIR inherited from this test process.
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const HOOKS = `
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const REPO = ${JSON.stringify(REPO)};
const ALIASES = [
  ["@/", REPO + "/src/"],
  ["open-sse/", REPO + "/open-sse/"],
];
function candidates(p) {
  return [p, p + ".js", p + ".cjs", p + ".mjs", p + "/index.js", p + "/index.cjs", p + "/index.mjs"];
}
function firstExisting(paths) {
  for (const p of paths) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}
export async function resolve(spec, ctx, next) {
  for (const [prefix, dir] of ALIASES) {
    if (spec.startsWith(prefix)) {
      const hit = firstExisting(candidates(dir + spec.slice(prefix.length)));
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
      // Name the missing aliased module (e.g. the unbuilt B3 activation file).
      throw Object.assign(new Error("Cannot find module " + dir + spec.slice(prefix.length)), {
        code: "ERR_MODULE_NOT_FOUND",
      });
    }
  }
  if ((spec.startsWith("./") || spec.startsWith("../")) && ctx.parentURL) {
    const hit = firstExisting(candidates(fileURLToPath(new URL(spec, ctx.parentURL))));
    if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
  }
  return next(spec, ctx);
}`;
  const REGISTER = `import { register } from "node:module"; register("data:text/javascript;base64,${Buffer.from(HOOKS).toString("base64")}");`;
  const CHILD = `
const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
const { runMigrationOnce } = await import("@/lib/db/migrate.js");
const { activateCredentialEncryption } = await import("@/lib/db/activateCredentialEncryption.js");
const db = await createSqlJsAdapter(process.env.FIXTURE_DB);
await runMigrationOnce(db);
const root = { kid: process.env.FAKE_KID, key: Buffer.from(process.env.FAKE_KEY_B64, "base64") };
const res = await activateCredentialEncryption(db, {
  enabled: true, beforeServing: true, root,
  crashAfter: process.env.CRASH_AT || undefined,
});
if (!process.env.CRASH_AT) console.log("STATUS=" + res.status);
db.close();
`;

  function childRun({ crashAt = null } = {}) {
    const env = {
      ...process.env,
      FIXTURE_DB: path.join(tempDir, "act.sqlite"),
      FAKE_KID: KID,
      FAKE_KEY_B64: MASTER.toString("base64"),
      CRASH_AT: crashAt ?? "",
      // Child inherits the isolated HOME/DATA_DIR from this test process.
    };
    return new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "--import",
          `data:text/javascript,${encodeURIComponent(REGISTER)}`,
          "-e",
          CHILD,
        ],
        {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("exit", (exitCode, signal) => resolve({ exitCode, signal, out }));
    });
  }

  it("kill at the activation-commit-before-VACUUM boundary: restart finishes cleanup before readiness", async () => {
    await childRun({ crashAt: "commit-before-cleanup" });
    // Recovery run without a crash boundary must finish cleanup and be ready.
    const second = await childRun({});
    expect(second.out).toContain("STATUS=ready");
    // Independent reopen here verifies state and decryption.
    const reopened = await createSqlJsAdapter(path.join(tempDir, "act.sqlite"));
    try {
      expect(readCredentialEncryptionState(reopened).cleanupPending).toBe(false);
      const ctx = prepareCredentialContext(reopened, { kid: KID, key: MASTER });
      const decoded = decodeCredentialRowSync(
        reopened,
        reopened.get(`SELECT * FROM providerConnections WHERE id = 'conn-other'`),
        ctx,
        { table: "providerConnections", mode: "runtime" },
      );
      expect(decoded.accessToken).toBe("sk-sent-other-token-3528");
      const rawText = reopened
        .all(`SELECT data FROM providerConnections`)
        .map((r) => r.data)
        .join("\n");
      expect(rawText).not.toContain("sk-sent-other-token-3528");
    } finally {
      clearCredentialCache(reopened);
      reopened.close();
    }
  }, 30000);
});

describe("KEK rotation safety (B4)", () => {
  it("env-managed refusal beats everything, even invalid options", async () => {
    await activated();
    process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
    try {
      const { rotateKek } = await loadRotation();
      await expect(rotateKek(db, { newRoot: null, crashAfter: "bogus" })).rejects.toMatchObject({
        code: "KEK_ENV_MANAGED",
        status: 409,
        message: expect.stringContaining("keys/master"),
      });
      expect(fs.existsSync(KEYS_DIR())).toBe(false);
    } finally {
      delete process.env.TOKENHOP_MASTER_KEY;
    }
  });

  it("an existing stage is never overwritten (ROTATION_IN_FLIGHT) and the live master is untouched", async () => {
    await activated();
    provisionMasterFile(MASTER);
    const stage = path.join(KEYS_DIR(), "master.next");
    fs.writeFileSync(stage, Buffer.alloc(32, 9), { mode: 0o600 });
    const { rotateKek } = await loadRotation();
    await expect(
      rotateKek(db, { newRoot: { kid: NEW_KID, key: NEW_MASTER }, fileManaged: true }),
    ).rejects.toMatchObject({ code: "ROTATION_IN_FLIGHT" });
    expect(fs.readFileSync(stage).equals(Buffer.alloc(32, 9))).toBe(true);
    expect(fs.readFileSync(path.join(KEYS_DIR(), "master")).equals(MASTER)).toBe(true);
    expect(readCredentialEncryptionState(db).kekKid).toBe(KID);
  });

  it("the staged key is exclusive 0600 and master.next never links or leaks a retired master", async () => {
    await activated();
    provisionMasterFile(MASTER);
    const { rotateKek } = await loadRotation();
    const res = await rotateKek(db, {
      newRoot: { kid: NEW_KID, key: NEW_MASTER },
      fileManaged: true,
      crashAfter: "staged",
    });
    expect(res).toMatchObject({ status: "crash-pending-rotation", boundary: "staged" });
    const stage = path.join(KEYS_DIR(), "master.next");
    const st = fs.lstatSync(stage);
    expect(st.isFile() && !st.isSymbolicLink()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    expect(st.nlink).toBe(1);
  });

  it("recovery with a stage whose kid does not match the pending marker poisons and retains both files", async () => {
    await activated();
    provisionMasterFile(MASTER);
    const { rotateKek, recoverKeyRotation } = await loadRotation();
    await rotateKek(db, {
      newRoot: { kid: NEW_KID, key: NEW_MASTER },
      fileManaged: true,
      crashAfter: "commit-before-rename",
    });
    // Tamper: replace the stage with a different (wrong) key.
    const stage = path.join(KEYS_DIR(), "master.next");
    fs.rmSync(stage);
    fs.writeFileSync(stage, Buffer.alloc(32, 7), { mode: 0o600 });
    await expect(recoverKeyRotation(db)).rejects.toMatchObject({ code: "KEY_MISMATCH" });
    expect(fs.existsSync(stage)).toBe(true); // retained, never deleted on uncertainty
    expect(fs.readFileSync(path.join(KEYS_DIR(), "master")).equals(MASTER)).toBe(true);
    expect(readCredentialEncryptionState(db).pendingRotation).toMatchObject({ newKid: NEW_KID });
    const { assertCredentialOperationAllowed } = await import(
      "../../src/lib/db/credentialMaintenance.js"
    );
    expect(() => assertCredentialOperationAllowed(db)).toThrow(/blocked until restart/);
  });

  it("recovery fails closed when TOKENHOP_MASTER_KEY appears during a pending file rotation", async () => {
    await activated();
    provisionMasterFile(MASTER);
    const { rotateKek, recoverKeyRotation } = await loadRotation();
    await rotateKek(db, {
      newRoot: { kid: NEW_KID, key: NEW_MASTER },
      fileManaged: true,
      crashAfter: "commit-before-rename",
    });
    process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
    try {
      await expect(recoverKeyRotation(db)).rejects.toMatchObject({ code: "KEK_ENV_MANAGED" });
    } finally {
      delete process.env.TOKENHOP_MASTER_KEY;
    }
    expect(fs.existsSync(path.join(KEYS_DIR(), "master.next"))).toBe(true);
    expect(readCredentialEncryptionState(db).pendingRotation).not.toBeNull();
  });

  it("a stage without a DB marker is a pre-commit leftover: removed, master and DB untouched", async () => {
    await activated();
    provisionMasterFile(MASTER);
    const { rotateKek, recoverKeyRotation } = await loadRotation();
    await rotateKek(db, {
      newRoot: { kid: NEW_KID, key: NEW_MASTER },
      fileManaged: true,
      crashAfter: "staged",
    });
    const before = Buffer.from(db.snapshot());
    await expect(recoverKeyRotation(db)).resolves.toMatchObject({ status: "ready" });
    expect(fs.existsSync(path.join(KEYS_DIR(), "master.next"))).toBe(false);
    expect(fs.readFileSync(path.join(KEYS_DIR(), "master")).equals(MASTER)).toBe(true);
    expect(Buffer.from(db.snapshot()).equals(before)).toBe(true);
  });

  it("no stage, master still old, marker pending: the new key is lost, recovery poisons and never invents a root", async () => {
    await activated();
    provisionMasterFile(MASTER);
    const { rotateKek, recoverKeyRotation } = await loadRotation();
    await rotateKek(db, {
      newRoot: { kid: NEW_KID, key: NEW_MASTER },
      fileManaged: true,
      crashAfter: "commit-before-rename",
    });
    fs.rmSync(path.join(KEYS_DIR(), "master.next"));
    await expect(recoverKeyRotation(db)).rejects.toMatchObject({ code: "KEY_MISSING" });
    expect(fs.readdirSync(KEYS_DIR()).sort()).toEqual(["master"]);
    expect(fs.readFileSync(path.join(KEYS_DIR(), "master")).equals(MASTER)).toBe(true);
  });

  it("a live-root generation change before the critical section aborts rotation with zero DB mutation", async () => {
    await activated();
    provisionMasterFile(MASTER);
    const { rotateKek } = await loadRotation();
    const before = Buffer.from(db.snapshot());
    // Explicit root differs from the file master: refused during preflight.
    await expect(
      rotateKek(db, {
        newRoot: { kid: NEW_KID, key: NEW_MASTER },
        root: { kid: KID, key: Buffer.alloc(32, 3) },
        fileManaged: true,
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/KEY_MISMATCH|ROOT_INVALID/) });
    expect(Buffer.from(db.snapshot()).equals(before)).toBe(true);
    expect(fs.existsSync(path.join(KEYS_DIR(), "master.next"))).toBe(false);
  });

  it("after a successful file rotation the runtime root getter reloads the new root and old root is rejected", async () => {
    await activated();
    provisionMasterFile(MASTER);
    const { rotateKek } = await loadRotation();
    await rotateKek(db, { newRoot: { kid: NEW_KID, key: NEW_MASTER }, fileManaged: true });
    const { loadMasterKey } = await import("../../src/lib/security/masterKey.js");
    const { getApiKeyHashKey } = await import("../../src/lib/security/apiKeyHashKey.js");
    const loaded = await loadMasterKey({ expectedKid: NEW_KID });
    expect(loaded.kid).toBe(NEW_KID);
    await expect(loadMasterKey({ expectedKid: KID })).rejects.toThrow(/id mismatch/);
    // The hash getter loads fresh and still yields the frozen original derived key.
    const hk = await getApiKeyHashKey(db);
    expect(hk.hashKey.equals(OLD_HASH_KEY)).toBe(true);
    expect(hashApiKey(RAW, hk.hashKey)).toBe(digest(RAW));
    // Cached DEKs for the old wraps are gone: decode under the new root works.
    expect(decodedToken(OTHER_WS, "conn-other", loaded)).toBe("sk-sent-other-token-3528");
  });

  it("rotating the same workspace DEK twice keeps data readable; unencrypted workspace is a noop", async () => {
    await activated();
    const { rotateWorkspaceDek } = await loadRotation();
    const a = await rotateWorkspaceDek(db, OTHER_WS, { root: { kid: KID, key: MASTER } });
    const b = await rotateWorkspaceDek(db, OTHER_WS, { root: { kid: KID, key: MASTER } });
    expect(a.dekKid).not.toBe(b.dekKid);
    clearCredentialCache(db);
    expect(decodedToken(OTHER_WS, "conn-other")).toBe("sk-sent-other-token-3528");
    // Default has its own DEK; ownership/workspaceId is never changed by DEK rotation.
    expect(
      db.get(`SELECT workspaceId FROM providerConnections WHERE id = 'conn-other'`).workspaceId,
    ).toBe(OTHER_WS);
  });
});

describe("masterKey sync primitives validate the keys/ parent like the async loader (B4 review)", () => {
  // keys/ replaced by a symlink to an outside dir that holds a plausible
  // master + stage: sync read/promote/remove must refuse and change nothing.
  function symlinkedKeysDir() {
    assertIsolatedHome();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-keys-outside-"));
    fs.chmodSync(outside, 0o700);
    fs.writeFileSync(path.join(outside, "master"), MASTER, { mode: 0o600 });
    fs.writeFileSync(path.join(outside, "master.next"), NEW_MASTER, { mode: 0o600 });
    fs.rmSync(KEYS_DIR(), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(KEYS_DIR()), { recursive: true });
    fs.symlinkSync(outside, KEYS_DIR());
    return outside;
  }
  const dump = (dir) =>
    fs
      .readdirSync(dir)
      .sort()
      .map((n) => [n, fs.readFileSync(path.join(dir, n)).toString("hex")]);

  it("symlinked keys dir: sync read, promote and remove all reject with MASTER_KEY_INVALID and touch nothing outside", async () => {
    const outside = symlinkedKeysDir();
    try {
      const before = dump(outside);
      const mk = await import("../../src/lib/security/masterKey.js");
      for (const run of [
        () => mk.readMasterKeyFileSync("master"),
        () => mk.readMasterKeyFileSync("stage"),
        () => mk.promoteStagedMasterSync(),
        () => mk.removeStagedMasterSync(),
        () => mk.stageMasterKeySync(Buffer.alloc(32, 5)),
      ]) {
        expect(run).toThrow(/keys directory must not be a symlink/);
        try {
          run();
        } catch (e) {
          expect(e.code).toBe("MASTER_KEY_INVALID");
        }
      }
      expect(dump(outside)).toEqual(before); // nothing outside changed
      expect(fs.lstatSync(KEYS_DIR()).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(KEYS_DIR(), { force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("mode parity: group/other-accessible keys dir is rejected by sync (read/promote/remove) exactly like async", async () => {
    provisionMasterFile(MASTER);
    fs.writeFileSync(path.join(KEYS_DIR(), "master.next"), NEW_MASTER, { mode: 0o600 });
    fs.chmodSync(KEYS_DIR(), 0o755);
    const mk = await import("../../src/lib/security/masterKey.js");
    try {
      const asyncErr = await mk.loadMasterKey().then(
        () => null,
        (e) => e,
      );
      expect(asyncErr?.message).toMatch(/keys directory must not be group\/other accessible/);
      for (const run of [
        () => mk.readMasterKeyFileSync("master"),
        () => mk.promoteStagedMasterSync(),
        () => mk.removeStagedMasterSync(),
      ]) {
        expect(run).toThrow(asyncErr.message);
      }
      // Nothing moved: stage still there, master bytes intact.
      expect(fs.existsSync(path.join(KEYS_DIR(), "master.next"))).toBe(true);
      expect(fs.readFileSync(path.join(KEYS_DIR(), "master")).equals(MASTER)).toBe(true);
    } finally {
      fs.chmodSync(KEYS_DIR(), 0o700);
    }
  });

  it("a missing keys dir stays a benign missing result for reads (no throw, no create)", async () => {
    assertIsolatedHome();
    fs.rmSync(KEYS_DIR(), { recursive: true, force: true });
    const mk = await import("../../src/lib/security/masterKey.js");
    expect(mk.readMasterKeyFileSync("master")).toEqual({ status: "missing" });
    expect(fs.existsSync(KEYS_DIR())).toBe(false);
  });

  it("existing master-key error messages keep their text and now carry MASTER_KEY_INVALID", async () => {
    const mk = await import("../../src/lib/security/masterKey.js");
    expect(() => mk.masterKeyId(Buffer.alloc(3))).toThrow(
      "[master-key] master key must be a 32-byte Buffer",
    );
    try {
      mk.masterKeyId(Buffer.alloc(3));
    } catch (e) {
      expect(e.code).toBe("MASTER_KEY_INVALID");
    }
  });

  it("recovery: unreadable stage with NO pending marker throws with the fixed stage path and guidance, and does not delete it", async () => {
    await activated();
    provisionMasterFile(MASTER);
    const stage = path.join(KEYS_DIR(), "master.next");
    fs.writeFileSync(stage, Buffer.alloc(7, 1), { mode: 0o600 }); // corrupt size
    const { recoverKeyRotation } = await loadRotation();
    await expect(recoverKeyRotation(db)).rejects.toMatchObject({
      code: "KEY_MISSING",
      message: expect.stringContaining(stage),
    });
    await expect(recoverKeyRotation(db)).rejects.toThrow(
      /unreferenced leftover.*delete it by hand/,
    );
    expect(fs.existsSync(stage)).toBe(true); // never auto-deleted
    expect(fs.readFileSync(path.join(KEYS_DIR(), "master")).equals(MASTER)).toBe(true);
    // No pending marker -> no poison.
    const { assertCredentialOperationAllowed } = await import(
      "../../src/lib/db/credentialMaintenance.js"
    );
    expect(() => assertCredentialOperationAllowed(db)).not.toThrow();
  });
});

// ─── B4: KEK rotation crash matrix (actual child kill + independent reopen) ──
// Real SIGKILL at each durable boundary (stage fsynced / DB committed /
// renamed / finalized) on both supported driver families (sql.js and the
// native node:sqlite adapter), then a fresh process recovers from disk only.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HOOKS = `
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const REPO = ${JSON.stringify(REPO)};
const ALIASES = [
  ["@/", REPO + "/src/"],
  ["open-sse/", REPO + "/open-sse/"],
];
function candidates(p) {
  return [p, p + ".js", p + ".cjs", p + ".mjs", p + "/index.js", p + "/index.cjs", p + "/index.mjs"];
}
function firstExisting(paths) {
  for (const p of paths) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}
export async function resolve(spec, ctx, next) {
  for (const [prefix, dir] of ALIASES) {
    if (spec.startsWith(prefix)) {
      const hit = firstExisting(candidates(dir + spec.slice(prefix.length)));
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
      throw Object.assign(new Error("Cannot find module " + dir + spec.slice(prefix.length)), {
        code: "ERR_MODULE_NOT_FOUND",
      });
    }
  }
  if ((spec.startsWith("./") || spec.startsWith("../")) && ctx.parentURL) {
    const hit = firstExisting(candidates(fileURLToPath(new URL(spec, ctx.parentURL))));
    if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
  }
  return next(spec, ctx);
}`;
const SEED_SQL = [
  "DROP TABLE IF EXISTS apiKeys",
  "DELETE FROM memberships; DELETE FROM identities; DELETE FROM providerNodes; DELETE FROM providerConnections; DELETE FROM workspaces; DELETE FROM users",
  "DELETE FROM _meta WHERE key IN ('defaultWorkspaceId','apiKeysHashedVersion','apiKeysHashKid')",
  `INSERT INTO users(id, email, username, displayName, instanceRole, status, sessionVersion, createdAt, updatedAt)
   VALUES('owner-1','owner@x.test','owner','owner','owner','active',1,'${"2026-10-06T00:00:00.000Z"}','${"2026-10-06T00:00:00.000Z"}')`,
  `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES('ws-default','Default','shared','owner-1','${"2026-10-06T00:00:00.000Z"}','${"2026-10-06T00:00:00.000Z"}')`,
  `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES('ws-other','Other','shared','owner-1','${"2026-10-06T00:00:00.000Z"}','${"2026-10-06T00:00:00.000Z"}')`,
  "INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES('ws-default','owner-1','owner','manual','2026-10-06T00:00:00.000Z')",
  "INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES('ws-other','owner-1','owner','manual','2026-10-06T00:00:00.000Z')",
  "INSERT INTO _meta(key, value) VALUES('defaultWorkspaceId','ws-default')",
  "DELETE FROM settings",
  `INSERT INTO settings(id, data) VALUES(1, '{"oidcClientSecret":"sk-sent-oidcClientSecret-3522"}')`,
  `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, workspaceId, createdByUserId, createdAt, updatedAt)
   VALUES('conn-other','openai','api_key','Other',NULL,1,1,'{"accessToken":"sk-sent-other-token-3528"}','ws-other','owner-1','2026-10-06T00:00:00.000Z','2026-10-06T00:00:00.000Z')`,
  "CREATE TABLE apiKeys (id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, userId TEXT REFERENCES users(id) ON DELETE CASCADE, createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL, keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT, machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1, revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]', expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)",
  `INSERT INTO apiKeys(id, workspaceId, userId, createdByUserId, keyHash, hashKid, prefix, name, legacy, isActive, allowedModels, createdAt)
   VALUES('hk-1','ws-other','owner-1','owner-1','${digest(RAW)}','${KID}','th_HA','Runner',1,1,'[]','2026-10-06T00:00:00.000Z')`,
  `INSERT INTO _meta(key, value) VALUES('apiKeysHashedVersion','1'), ('apiKeysHashKid','${KID}')`,
];

const CHILD_MATRIX = `
import fs from "node:fs";
import path from "node:path";
const driver = process.env.CHILD_DRIVER;
const open =
  driver === "native"
    ? (await import("@/lib/db/adapters/nodeSqliteAdapter.js")).createNodeSqliteAdapter
    : (await import("@/lib/db/adapters/sqljsAdapter.js")).createSqlJsAdapter;
const { runMigrationOnce } = await import("@/lib/db/migrate.js");
const { readCredentialEncryptionState } = await import("@/lib/db/credentialEncryptionState.js");
const { activateCredentialEncryption } = await import("@/lib/db/activateCredentialEncryption.js");
const { rotateKek, recoverKeyRotation } = await import("@/lib/security/keyRotation.js");
const { prepareCredentialContext, decodeCredentialRowSync, clearCredentialCache } = await import("@/lib/db/helpers/credentialStorage.js");
const { masterKeyId } = await import("@/lib/security/masterKey.js");
const MASTER = Buffer.from(process.env.FAKE_KEY_B64, "base64");
const NEW = Buffer.from(process.env.NEW_KEY_B64, "base64");
const KID = masterKeyId(MASTER);
const NEW_KID = masterKeyId(NEW);
const db = await open(process.env.FIXTURE_DB);
await runMigrationOnce(db);
for (const sql of ${"JSON_PLACEHOLDER"}) {
  if (process.env.CHILD_MODE === "rotate") db.exec(sql);
}
const keysDir = path.join(process.env.DATA_DIR, "keys");
if (process.env.CHILD_MODE === "rotate") {
  await activateCredentialEncryption(db, {
    enabled: true,
    beforeServing: true,
    root: { kid: KID, key: MASTER },
  });
  fs.mkdirSync(keysDir, { recursive: true });
  fs.chmodSync(keysDir, 0o700);
  fs.writeFileSync(path.join(keysDir, "master"), MASTER, { mode: 0o600 });
  fs.chmodSync(path.join(keysDir, "master"), 0o600);
  const res = await rotateKek(db, {
    newRoot: { kid: NEW_KID, key: NEW },
    fileManaged: true,
    crashAfter: process.env.CRASH_AT || undefined,
  });
  console.log("ROT=" + res.status);
  if (process.env.HARD_KILL === "1") process.kill(process.pid, "SIGKILL");
  db.close();
} else {
  const res = await recoverKeyRotation(db);
  const state = readCredentialEncryptionState(db);
  // Root is chosen from the marker the child reads itself — never a guess:
  // the rewrap committed exactly when the marker kid moved.
  const root = { kid: state.kekKid, key: state.kekKid === NEW_KID ? NEW : MASTER };
  const ctx = prepareCredentialContext(db, root);
  const row = db.get("SELECT * FROM providerConnections WHERE id = 'conn-other'");
  const decoded = decodeCredentialRowSync(db, row, ctx, { table: "providerConnections", mode: "runtime" });
  const names = fs.existsSync(keysDir) ? fs.readdirSync(keysDir).sort().join(",") : "";
  console.log("STATUS=" + res.status);
  console.log("KEK=" + state.kekKid);
  console.log("PENDING=" + (state.pendingRotation ? "1" : "0"));
  console.log("TOK=" + (decoded.accessToken === "sk-sent-other-token-3528"));
  console.log("FILES=" + names);
  clearCredentialCache(db);
  db.close();
}
`;

function matrixChild({ mode, driver, fixtureDb, crashAt = null, hardKill = false }) {
  const register = `import { register } from "node:module"; register("data:text/javascript;base64,${Buffer.from(HOOKS).toString("base64")}");`;
  const child = CHILD_MATRIX.replace("JSON_PLACEHOLDER", JSON.stringify(SEED_SQL));
  const env = {
    ...process.env,
    CHILD_MODE: mode,
    CHILD_DRIVER: driver,
    FIXTURE_DB: fixtureDb,
    FAKE_KEY_B64: MASTER.toString("base64"),
    NEW_KEY_B64: NEW_MASTER.toString("base64"),
    CRASH_AT: crashAt ?? "",
    HARD_KILL: hardKill ? "1" : "",
  };
  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--import",
        `data:text/javascript,${encodeURIComponent(register)}`,
        "-e",
        child,
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (out += d));
    proc.on("exit", (exitCode, signal) => resolve({ exitCode, signal, out }));
  });
}

const cases = [
  // [boundary, hardKill, expectNew, expectPendingAfter, expectFiles]
  ["staged", true, false, false, "master"],
  ["commit-before-rename", true, true, false, "master"],
  ["renamed", true, true, false, "master"],
  ["finalized", true, true, false, "master"],
];

for (const driver of ["native", "sqljs"]) {
  describe(`KEK rotation crash matrix (${driver === "native" ? "node:sqlite" : "sql.js"} child kills)`, () => {
    for (const [boundary, hardKill, expectNew, , expectFiles] of cases) {
      it(`kill at ${boundary}: independent restart recovers from disk before readiness`, async () => {
        assertIsolatedHome();
        const fixture = fs.mkdtempSync(path.join(os.tmpdir(), `tokenhop-kek-${driver}-`));
        try {
          const fixtureDb = path.join(fixture, "matrix.sqlite");
          const killed = await matrixChild({
            mode: "rotate",
            driver,
            fixtureDb,
            crashAt: boundary,
            hardKill,
          });
          // Actual kill at the boundary (no graceful close), or a clean
          // fixture-boundary return the child then dies before closing.
          expect(killed.out).toContain(
            `ROT=crash-${boundary === "staged" ? "pending-rotation" : boundary === "finalized" ? "finalized" : "pending-rotation"}`,
          );
          if (hardKill) expect(killed.signal).toBe("SIGKILL");
          const recovered = await matrixChild({
            mode: "recover",
            driver,
            fixtureDb,
          });
          expect(recovered.exitCode).toBe(0);
          expect(recovered.out).toContain("STATUS=ready");
          expect(recovered.out).toContain(`KEK=${expectNew ? NEW_KID : KID}`);
          expect(recovered.out).toContain("PENDING=0");
          expect(recovered.out).toContain("TOK=true");
          expect(recovered.out).toContain(`FILES=${expectFiles}`);
        } finally {
          fs.rmSync(fixture, { recursive: true, force: true });
        }
      }, 45000);
    }
  });
}

// Raw legacy sk- key still digests under the preserved derived hash key after
// KEK rotation (H1 continuity) — kept as a plain assertion, not a claim of
// "all consumers" coverage.
it("legacy sk- raw key digest stays identical across KEK rotation", async () => {
  await activated();
  const before = digest(RAW_LEGACY);
  const { rotateKek } = await loadRotation();
  await rotateKek(db, {
    newRoot: { kid: NEW_KID, key: NEW_MASTER },
    root: { kid: KID, key: MASTER },
    fileManaged: false,
  });
  expect(digest(RAW_LEGACY)).toBe(before);
});

// ─── YAN-365 (task 6.1): owner-only rotation routes ─────────────────────────
// Handlers run with the auth/session/rotation seams mocked (vi.doMock, scoped
// to this block): the contract under test is transport — switch-off 404,
// auth 401/403, empty-body strictness, env 409 guidance, locked 409, 503
// typed codes, kids/counts-only bodies — not crypto (covered above).
describe("rotation routes (task 6.1)", () => {
  const mocks = {};
  const SECRET_KEY_BYTES = "AAAA-never-in-a-response";

  async function loadRoutes({
    multiUser = true,
    principal = { userId: "owner-1", instanceRole: "owner", via: "session" },
    authorizeResult = null,
    rotateKek,
    rotateWorkspaceDek,
  } = {}) {
    vi.resetModules();
    mocks.requireMultiUser = vi.fn(async () =>
      multiUser ? null : { status: 404, body: { error: "Not found" } },
    );
    mocks.getPrincipal = vi.fn(async () => principal);
    mocks.authorize = vi.fn(async () => authorizeResult);
    mocks.audit = vi.fn();
    mocks.rotateKek =
      rotateKek ?? vi.fn(async () => ({ status: "ready", oldKid: KID, newKid: NEW_KID, deks: 2 }));
    mocks.rotateWorkspaceDek =
      rotateWorkspaceDek ??
      vi.fn(async (_d, id) => ({
        status: "ready",
        workspaceId: id,
        dekKid: "dk_new",
        oldDekKid: "dk_old",
        rotated: 3,
      }));
    vi.doMock("next/server", () => ({
      NextResponse: { json: (body, init) => ({ status: init?.status ?? 200, body }) },
    }));
    vi.doMock("@/lib/users/featureSwitch.js", () => ({ requireMultiUser: mocks.requireMultiUser }));
    vi.doMock("@/lib/users/session.js", () => ({
      getPrincipal: mocks.getPrincipal,
      authorize: mocks.authorize,
    }));
    vi.doMock("@/lib/users/audit.js", () => ({ audit: mocks.audit }));
    vi.doMock("@/lib/db/driver.js", () => ({ getAdapter: async () => ({ fake: true }) }));
    vi.doMock("@/lib/security/keyRotation.js", () => ({
      rotateKek: mocks.rotateKek,
      rotateWorkspaceDek: mocks.rotateWorkspaceDek,
    }));
    const kek = await import("@/app/api/settings/keys/rotate/route.js");
    const dek = await import("@/app/api/workspaces/[id]/keys/rotate/route.js");
    return { kek: kek.POST, dek: dek.POST };
  }

  const req = (body = {}, headers = {}) =>
    new Request("http://localhost/api/x", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  const dekCall = (post, id = "ws-other", r = req()) =>
    post(r, { params: Promise.resolve({ id }) });

  afterEach(() => {
    vi.doUnmock("next/server");
    vi.doUnmock("@/lib/users/featureSwitch.js");
    vi.doUnmock("@/lib/users/session.js");
    vi.doUnmock("@/lib/users/audit.js");
    vi.doUnmock("@/lib/db/driver.js");
    vi.doUnmock("@/lib/security/keyRotation.js");
    vi.resetModules();
  });

  it("owner POST with an empty object rotates and returns kids/counts only", async () => {
    const { kek, dek } = await loadRoutes();
    const res = await kek(req());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ oldKid: KID, newKid: NEW_KID, dekCount: 2 });
    expect(res.body.reminder).toMatch(/previous key/);
    expect(mocks.rotateKek).toHaveBeenCalledTimes(1);
    expect(mocks.rotateKek.mock.calls[0]).toHaveLength(1); // adapter only, no options
    expect(mocks.authorize).toHaveBeenCalledWith("instance.keys.rotate");
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toMatch(/wrapped|key"?:\s*"/i);
    const w = await dekCall(dek);
    expect(w.status).toBe(200);
    expect(w.body).toMatchObject({ workspaceId: "ws-other", dekKid: "dk_new", rotated: 3 });
    expect(mocks.rotateWorkspaceDek).toHaveBeenCalledWith({ fake: true }, "ws-other");
  });

  it("switch off answers 404 before any auth, even on established encryption", async () => {
    const { kek, dek } = await loadRoutes({ multiUser: false });
    expect((await kek(req())).status).toBe(404);
    expect((await dekCall(dek)).status).toBe(404);
    expect(mocks.getPrincipal).not.toHaveBeenCalled();
    expect(mocks.rotateKek).not.toHaveBeenCalled();
  });

  it("no principal 401 and non-owner 403 with zero rotation", async () => {
    const un = { status: 401, body: { error: "Unauthorized" } };
    const fo = { status: 403, body: { error: "Forbidden" } };
    for (const denied of [un, fo]) {
      const { kek, dek } = await loadRoutes({ authorizeResult: denied });
      expect((await kek(req())).status).toBe(denied.status);
      expect((await dekCall(dek)).status).toBe(denied.status);
      expect(mocks.rotateKek).not.toHaveBeenCalled();
      expect(mocks.rotateWorkspaceDek).not.toHaveBeenCalled();
    }
  });

  it("rejects non-empty/overriding/non-object bodies before auth work", async () => {
    const { kek, dek } = await loadRoutes();
    for (const body of [
      { root: "x" },
      { path: "/etc" },
      { env: "TOKENHOP_MASTER_KEY" },
      { newRoot: { kid: "a", key: SECRET_KEY_BYTES } },
      { workspaceId: "ws-x" },
      [],
      "[]",
      "not json",
    ]) {
      const r = await kek(req(body));
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect((await dekCall(dek, "ws-other", req(body))).status).toBe(400);
    }
    expect(mocks.rotateKek).not.toHaveBeenCalled();
    expect(mocks.rotateWorkspaceDek).not.toHaveBeenCalled();
    const big = await kek(req(JSON.stringify({ pad: "x".repeat(4096) })));
    expect(big.status).toBe(413);
    const media = await kek(req({}, { "content-type": "text/plain" }));
    expect(media.status).toBe(415);
  });

  it("env-managed KEK: 409 KEK_ENV_MANAGED with same-key guidance; workspace rotation still works", async () => {
    const { KEK_ENV_MANAGED_GUIDANCE } = await vi.importActual("@/lib/security/keyRotation.js");
    const err = Object.assign(
      new Error(`[key-rotation] Automatic KEK rotation refused. ${KEK_ENV_MANAGED_GUIDANCE}`),
      {
        code: "KEK_ENV_MANAGED",
      },
    );
    const { kek, dek } = await loadRoutes({
      rotateKek: vi.fn(async () => {
        throw err;
      }),
    });
    const res = await kek(req());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("KEK_ENV_MANAGED");
    expect(res.body.error).toMatch(/same current key/);
    expect((await dekCall(dek)).status).toBe(200);
  });

  it("locked 409, unavailable 503 typed, unknown 500 with no leaked detail", async () => {
    const cases = [
      ["CREDENTIAL_MAINTENANCE_POISONED", 409, "locked"],
      ["KEY_MISSING", 503, "key_missing"],
      ["ROTATION_NOT_ENCRYPTED", 503, "rotation_not_encrypted"],
      ["ROTATION_IN_FLIGHT", 503, "rotation_in_flight"],
    ];
    for (const [code, status, typed] of cases) {
      const boom = vi.fn(async () => {
        throw Object.assign(new Error(`secret ${SECRET_KEY_BYTES}`), { code });
      });
      const { kek, dek } = await loadRoutes({ rotateKek: boom, rotateWorkspaceDek: boom });
      for (const res of [await kek(req()), await dekCall(dek)]) {
        expect(res.status, code).toBe(status);
        expect(res.body.code).toBe(typed);
        expect(JSON.stringify(res.body)).not.toContain(SECRET_KEY_BYTES);
      }
    }
    const boom = vi.fn(async () => {
      throw new Error(`secret ${SECRET_KEY_BYTES}`);
    });
    const { kek } = await loadRoutes({ rotateKek: boom });
    const res = await kek(req());
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_KEY_BYTES);
  });

  it("missing workspace answers 404 not_found", async () => {
    const { dek } = await loadRoutes({
      rotateWorkspaceDek: vi.fn(async () => {
        throw Object.assign(new Error("x"), { code: "ROTATION_WORKSPACE_MISSING" });
      }),
    });
    const res = await dekCall(dek, "ghost");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not_found");
  });
});
