// YAN-365 (task 2.4, T lane): C1/C3/C4/C10 activation integration tests.
// Authored red in B2 against the B1 fixed contracts; O turns them green in
// B3 (activation) / B4 (rotation) / B5 (transfer). Expected-red failures must
// point only at intentionally unimplemented behavior, never at harness bugs.
//
// Real sql.js adapter on an isolated temp file + isolated DATA_DIR/HOME via
// tests/vitest.config.js. Destructive fixtures assert assertIsolatedHome first.
// B3+ module imports are lazy (inside `it`) so this file always collects and
// every red failure names the missing contract, not a module-resolution error.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqlJsAdapter } from "@/lib/db/adapters/sqljsAdapter.js";
import { runMigrationOnce } from "@/lib/db/migrate.js";
import { readCredentialEncryptionState } from "@/lib/db/credentialEncryptionState.js";
import {
  clearCredentialCache,
  decodeCredentialRowSync,
  prepareCredentialContext,
} from "@/lib/db/helpers/credentialStorage.js";
import { CREDENTIAL_FIELD_ALLOWLIST } from "@/lib/security/envelope.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { BACKUPS_DIR } from "@/lib/db/paths.js";
import { assertIsolatedHome } from "../helpers/isolatedHome.js";

// Lazy B3+/unimplemented imports — failures must be contract failures.
const loadActivate = () => import("../../src/lib/db/activateCredentialEncryption.js");
const loadMaintenance = () => import("../../src/lib/db/credentialMaintenance.js");

const NOW = "2026-10-06T00:00:00.000Z";
const MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));
const WRONG_MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 11 + 5) % 256));
const KID = masterKeyId(MASTER);
const HASH_KEY = deriveApiKeyHashKey(MASTER);
const RAW = "th_HASHEDGATEWAYTOKENxxxxxxxxxxxxxxx";
const digest = (raw) => hashApiKey(raw, HASH_KEY);
const DEFAULT_WS = "ws-default";
const SHARED_WS = "ws-shared";
const PERSONAL_WS = "ws-personal";
const code = (c) => expect.objectContaining({ code: c });

let tempDir;
let db;

// One fake unique sentinel per D10-covered leaf.
function sentinels() {
  return {
    accessToken: "sk-sent-accessToken-3501",
    refreshToken: "sk-sent-refreshToken-3502",
    idToken: "sk-sent-idToken-3503",
    apiKey: "sk-sent-apiKey-3504",
    "providerSpecificData.clientSecret": "sk-sent-psd-clientSecret-3505",
    "providerSpecificData.copilotToken": "sk-sent-psd-copilotToken-3506",
    "providerSpecificData.idToken": "sk-sent-psd-idToken-3507",
    "providerSpecificData.firebaseIdToken": "sk-sent-psd-firebaseIdToken-3508",
    "providerSpecificData.mimoPassToken": "sk-sent-psd-mimoPassToken-3509",
    "providerSpecificData.cookie": "sk-sent-psd-cookie-3510",
    "providerSpecificData.apiKey": "sk-sent-psd-apiKey-3511",
    "providerSpecificData.secretAccessKey": "sk-sent-psd-secretAccessKey-3512",
    oidcClientSecret: "sk-sent-oidcClientSecret-3522",
    samlPrivateKey: "sk-sent-samlPrivateKey-3523",
    samlDecryptionKey: "sk-sent-samlDecryptionKey-3524",
    samlSigningKey: "sk-sent-samlSigningKey-3525",
    mitmSudoEncrypted: "sk-sent-mitmSudoEncrypted-3526",
  };
}

function connData(sent) {
  const data = {
    accessToken: sent.accessToken,
    refreshToken: sent.refreshToken,
    idToken: sent.idToken,
    apiKey: sent.apiKey,
    note: "not-a-secret",
    providerSpecificData: {
      clientSecret: sent["providerSpecificData.clientSecret"],
      copilotToken: sent["providerSpecificData.copilotToken"],
      idToken: sent["providerSpecificData.idToken"],
      firebaseIdToken: sent["providerSpecificData.firebaseIdToken"],
      mimoPassToken: sent["providerSpecificData.mimoPassToken"],
      cookie: sent["providerSpecificData.cookie"],
      apiKey: sent["providerSpecificData.apiKey"],
      secretAccessKey: sent["providerSpecificData.secretAccessKey"],
      model: "gpt-4o", // PSD non-secret must survive untouched
    },
  };
  return data;
}

// Legacy (plaintext) D10 coverage fixture: Default holds the five instance
// settings secrets (D5); a shared workspace and a personal workspace hold
// connection/node sentinels; one ownerless (workspaceId NULL) connection row
// plus one ownerless node row must be adopted by Default on activation (D1).
function seedLegacyMixed() {
  db.exec(`DROP TABLE IF EXISTS apiKeys`);
  db.exec(`DELETE FROM memberships; DELETE FROM identities; DELETE FROM providerNodes;
    DELETE FROM providerConnections; DELETE FROM workspaces; DELETE FROM users;
    DELETE FROM _meta WHERE key IN ('defaultWorkspaceId','apiKeysHashedVersion','apiKeysHashKid')`);
  const users = [
    ["owner-1", "owner@x.test", "owner"],
    ["user-1", "user@x.test", "user"],
  ];
  for (const [id, email, role] of users) {
    db.run(
      `INSERT INTO users(id, email, username, displayName, instanceRole, status, sessionVersion, createdAt, updatedAt)
       VALUES(?,?,?,?,?,'active',1,?,?)`,
      [id, email, id, id, role, NOW, NOW],
    );
  }
  const wss = [
    [DEFAULT_WS, "Default", "shared", "owner-1"],
    [SHARED_WS, "Shared", "shared", "owner-1"],
    [PERSONAL_WS, "Personal", "personal", "user-1"],
  ];
  for (const [id, name, kind, createdBy] of wss) {
    db.run(
      `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES(?,?,?,?,?,?)`,
      [id, name, kind, createdBy, NOW, NOW],
    );
  }
  db.run(
    `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?,?,?,?,?)`,
    [DEFAULT_WS, "owner-1", "owner", "manual", NOW],
  );
  db.run(
    `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?,?,?,?,?)`,
    [SHARED_WS, "owner-1", "owner", "manual", NOW],
  );
  db.run(
    `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?,?,?,?,?)`,
    [PERSONAL_WS, "user-1", "owner", "manual", NOW],
  );
  db.run(`INSERT INTO _meta(key, value) VALUES('defaultWorkspaceId', ?)`, [DEFAULT_WS]);

  // Legacy plaintext settings row (id=1) with all five D10 instance secrets.
  db.run(`DELETE FROM settings`);
  const sent = sentinels();
  db.run(`INSERT INTO settings(id, data) VALUES(1, ?)`, [
    JSON.stringify({
      oidcClientSecret: sent.oidcClientSecret,
      samlPrivateKey: sent.samlPrivateKey,
      samlDecryptionKey: sent.samlDecryptionKey,
      samlSigningKey: sent.samlSigningKey,
      mitmSudoEncrypted: sent.mitmSudoEncrypted,
      displayName: "instance",
    }),
  ]);

  // Ownerless NULL-row connections + nodes (adopted by Default on activation).
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, workspaceId, createdByUserId, createdAt, updatedAt)
     VALUES('conn-null','openai','api_key','Ownerless',NULL,1,1,?,NULL,NULL,?,?)`,
    [JSON.stringify({ accessToken: "sk-sent-nullrow-adopt-3513" }), NOW, NOW],
  );
  db.run(
    `INSERT INTO providerNodes(id, type, name, data, workspaceId, createdAt, updatedAt)
     VALUES('node-null','endpoint','Ownerless node',?,NULL,?,?)`,
    [JSON.stringify({ apiKey: "sk-sent-node-null-3514" }), NOW, NOW],
  );

  // Shared + personal connections carrying every connection sentinel.
  for (const [id, ws] of [
    ["conn-shared", SHARED_WS],
    ["conn-personal", PERSONAL_WS],
  ]) {
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, workspaceId, createdByUserId, createdAt, updatedAt)
       VALUES(?, 'openai','api_key',?,NULL,1,1,?,?,'owner-1',?,?)`,
      [id, id, JSON.stringify(connData(sentinels())), ws, NOW, NOW],
    );
  }
  // Node with covered leaves (D10 node allow-list).
  db.run(
    `INSERT INTO providerNodes(id, type, name, data, workspaceId, createdAt, updatedAt)
     VALUES('node-shared','endpoint','Shared node',?, ?, ?, ?)`,
    [
      JSON.stringify({
        apiKey: "sk-sent-node-apiKey-3515",
        accessToken: "sk-sent-node-accessToken-3516",
        refreshToken: "sk-sent-node-refreshToken-3517",
        idToken: "sk-sent-node-idToken-3518",
        authHeader: "sk-sent-node-authHeader-3519",
        endpoint: "https://node.example", // non-secret leaf stays plaintext
      }),
      SHARED_WS,
      NOW,
      NOW,
    ],
  );

  // Hashed gateway keys (pre-existing YAN-363) stay hash-identical across
  // activation: same hashKid, same keyHash bytes. Rebuild the hashed shape
  // explicitly: the sqlite reopen used here starts from the legacy raw-key
  // table until the app migration runs.
  db.exec(`DROP TABLE IF EXISTS apiKeys`);
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
    [SHARED_WS, digest(RAW), KID, "th_HA", NOW],
  );
  db.run(`INSERT INTO _meta(key, value) VALUES('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)`, [
    KID,
  ]);
}

function encryptedMarker(kekKid = KID) {
  db.run(
    `INSERT INTO _meta(key, value) VALUES('credentialsEncryptedVersion','1'), ('credentialsKekKid',?), ('apiKeyHashKeyWrapped','x')`,
    [kekKid],
  );
}

function allCredentialText() {
  return [
    ...db.all(`SELECT data FROM providerConnections`).map((r) => r.data),
    ...db.all(`SELECT data FROM providerNodes`).map((r) => r.data),
    ...db.all(`SELECT data FROM settings`).map((r) => r.data),
    JSON.stringify(db.all(`SELECT * FROM workspaceKeys`)),
    JSON.stringify(db.all(`SELECT * FROM _meta`)),
  ].join("\n");
}

function scanWalFor(text) {
  const wal = `${path.join(tempDir, "act.sqlite")}-wal`;
  if (!fs.existsSync(wal)) return false;
  return fs.readFileSync(wal).toString("latin1").includes(text);
}

function activationBackups() {
  assertIsolatedHome();
  return fs.existsSync(BACKUPS_DIR)
    ? fs.readdirSync(BACKUPS_DIR).filter((n) => n.startsWith("credential-encryption-activation"))
    : [];
}

beforeEach(async () => {
  assertIsolatedHome();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-cred-activation-"));
  db = await createSqlJsAdapter(path.join(tempDir, "act.sqlite"));
  await runMigrationOnce(db);
  seedLegacyMixed();
});

afterEach(() => {
  clearCredentialCache(db);
  db?.close();
  db = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("never-enabled install (D4: pristine off stays pristine)", () => {
  it("activation with enabled:false performs zero mutation: no root file, no backup, no DEKs, no marker", async () => {
    const before = Buffer.from(db.snapshot());
    const { activateCredentialEncryption } = await loadActivate();
    const result = await activateCredentialEncryption(db, {
      enabled: false,
      beforeServing: true,
      root: { kid: KID, key: MASTER },
    });
    expect(result).toMatchObject({ status: "skipped-off" });
    expect(Buffer.from(db.snapshot()).equals(before)).toBe(true);
    expect(readCredentialEncryptionState(db).storage).toBe("legacy");
    expect(activationBackups()).toEqual([]);
    expect(db.get(`SELECT COUNT(*) AS c FROM workspaceKeys`).c).toBe(0);
    const keysDir = path.join(process.env.DATA_DIR, "keys");
    expect(fs.existsSync(path.join(keysDir, "master"))).toBe(false);
  });

  it("legacy plaintext reads through runtime context unchanged; writes do not create key rows", () => {
    const ctx = prepareCredentialContext(db, null);
    expect(ctx.encrypted).toBe(false);
    const row = db.get(`SELECT * FROM providerConnections WHERE id = 'conn-shared'`);
    const decoded = decodeCredentialRowSync(db, row, ctx, {
      table: "providerConnections",
      mode: "runtime",
    });
    // Legacy off: bytes pass through untouched (D4).
    expect(decoded.accessToken).toBe(sentinels().accessToken);
    expect(db.get(`SELECT COUNT(*) AS c FROM workspaceKeys`).c).toBe(0);
  });
});

describe("first activation (C1/C3)", () => {
  it("encrypts every D10 leaf, adopts ownerless rows into Default, latches marker, creates verified backup", async () => {
    const { activateCredentialEncryption } = await loadActivate();
    const result = await activateCredentialEncryption(db, {
      enabled: true,
      beforeServing: true,
      root: { kid: KID, key: MASTER },
    });
    expect(result).toMatchObject({ status: "ready" });

    // D4 strict marker pair.
    const state = readCredentialEncryptionState(db);
    expect(state).toMatchObject({ storage: "encrypted", version: 1, kekKid: KID });

    // Ownerless rows adopted by Default before encryption (D1).
    expect(
      db.get(`SELECT workspaceId AS ws FROM providerConnections WHERE id = 'conn-null'`).ws,
    ).toBe(DEFAULT_WS);
    expect(db.get(`SELECT workspaceId AS ws FROM providerNodes WHERE id = 'node-null'`).ws).toBe(
      DEFAULT_WS,
    );

    // DEK per owning workspace (Default, shared, personal) — ownerless rows do
    // not mint a fourth key.
    const dekWorkspaces = db
      .all(`SELECT workspaceId FROM workspaceKeys ORDER BY workspaceId`)
      .map((r) => r.workspaceId);
    expect(dekWorkspaces.sort()).toEqual([DEFAULT_WS, PERSONAL_WS, SHARED_WS].sort());

    // C1: no sentinel plaintext in DB, WAL, or post-activation backup.
    const text = allCredentialText();
    for (const value of Object.values(sentinels())) {
      expect(text).not.toContain(value);
    }
    expect(scanWalFor(sentinels().accessToken)).toBe(false);
    expect(scanWalFor(sentinels()["providerSpecificData.cookie"])).toBe(false);

    // Non-secret leaves stay readable plaintext.
    const sharedRow = db.get(`SELECT data FROM providerConnections WHERE id = 'conn-shared'`);
    const parsed = JSON.parse(sharedRow.data);
    expect(parsed.note).toBe("not-a-secret");
    expect(parsed.providerSpecificData.model).toBe("gpt-4o");

    // Gateway hash identity untouched: same keyHash bytes, same hashKid.
    expect(db.get(`SELECT keyHash, hashKid FROM apiKeys WHERE id = 'hk-1'`)).toEqual({
      keyHash: digest(RAW),
      hashKid: KID,
    });

    // Verified private pre-activation backup exists (D7: intentionally still
    // plaintext — it is a pre-existing copy, not live state).
    const backups = activationBackups();
    expect(backups.length).toBeGreaterThan(0);

    // Runtime decode round-trips every sentinel after activation.
    const ctx = prepareCredentialContext(db, { kid: KID, key: MASTER });
    const decoded = decodeCredentialRowSync(
      db,
      db.get(`SELECT * FROM providerConnections WHERE id = 'conn-shared'`),
      ctx,
      { table: "providerConnections", mode: "runtime" },
    );
    expect(decoded).toMatchObject(connData(sentinels()));
    const settingsDecoded = decodeCredentialRowSync(
      db,
      db.get(`SELECT * FROM settings WHERE id = 1`),
      ctx,
      // Settings carry no workspaceId column: the Default coordinate comes
      // from _meta, exactly as settingsRepo.decryptSecrets supplies it.
      { table: "settings", mode: "runtime", workspaceId: DEFAULT_WS },
    );
    expect(settingsDecoded.oidcClientSecret).toBe(sentinels().oidcClientSecret);
  });

  it("metadata mode never decrypts and reports configured presence only", async () => {
    const { activateCredentialEncryption } = await loadActivate();
    await activateCredentialEncryption(db, {
      enabled: true,
      beforeServing: true,
      root: { kid: KID, key: MASTER },
    });
    const ctx = prepareCredentialContext(db, { kid: KID, key: MASTER });
    const { data, configured } = decodeCredentialRowSync(
      db,
      db.get(`SELECT * FROM providerConnections WHERE id = 'conn-shared'`),
      ctx,
      { table: "providerConnections", mode: "metadata" },
    );
    expect(configured.sort()).toEqual([...CREDENTIAL_FIELD_ALLOWLIST.providerConnections].sort());
    expect(JSON.stringify(data)).not.toContain("sk-sent-");
  });

  it("a corrupt envelope does not break metadata listing but fails runtime use with a typed error", async () => {
    const { activateCredentialEncryption } = await loadActivate();
    await activateCredentialEncryption(db, {
      enabled: true,
      beforeServing: true,
      root: { kid: KID, key: MASTER },
    });
    const raw = JSON.parse(
      db.get(`SELECT data FROM providerConnections WHERE id = 'conn-shared'`).data,
    );
    raw.accessToken = { ...raw.accessToken, ct: `${raw.accessToken.ct.slice(0, -4)}AAAA` };
    db.run(`UPDATE providerConnections SET data = ? WHERE id = 'conn-shared'`, [
      JSON.stringify(raw),
    ]);

    const ctx = prepareCredentialContext(db, { kid: KID, key: MASTER });
    // Metadata list survives (D3 per-row integrity).
    const meta = decodeCredentialRowSync(
      db,
      db.get(`SELECT * FROM providerConnections WHERE id = 'conn-shared'`),
      ctx,
      { table: "providerConnections", mode: "metadata" },
    );
    expect(meta.configured).toContain("accessToken");
    // Actual use throws the shared typed error.
    expect(() =>
      decodeCredentialRowSync(
        db,
        db.get(`SELECT * FROM providerConnections WHERE id = 'conn-shared'`),
        ctx,
        { table: "providerConnections", mode: "runtime" },
      ),
    ).toThrow(code("DECRYPT_FAILED"));
  });
});

describe("first activation never creates a replacement root (B3 critical)", () => {
  it("root missing between gateway-key activation and credential activation fails and creates no key file", async () => {
    const { activateCredentialEncryption } = await loadActivate();
    const keysDir = path.join(process.env.DATA_DIR, "keys");
    assertIsolatedHome();
    fs.rmSync(keysDir, { recursive: true, force: true });
    const before = Buffer.from(db.snapshot());
    const backupsBefore = activationBackups();
    // No `root` passed: production path loads the root by the frozen hash kid
    // with create:false. The root file/env is absent (vanished between steps).
    await expect(
      activateCredentialEncryption(db, { enabled: true, beforeServing: true }),
    ).rejects.toThrow(/master key missing/);
    expect(fs.existsSync(keysDir)).toBe(false); // no replacement root of any kind
    expect(fs.existsSync(path.join(keysDir, "master"))).toBe(false);
    expect(readCredentialEncryptionState(db).storage).toBe("legacy");
    expect(Buffer.from(db.snapshot()).equals(before)).toBe(true); // zero DB mutation
    expect(activationBackups()).toEqual(backupsBefore); // fails before the backup
  });
});

describe("established encryption stays established (C10/D3/D4)", () => {
  async function activate() {
    const { activateCredentialEncryption } = await loadActivate();
    return activateCredentialEncryption(db, {
      enabled: true,
      beforeServing: true,
      root: { kid: KID, key: MASTER },
    });
  }

  it("switch off after activation keeps writes encrypted (on→off established)", async () => {
    await activate();
    const { encodeCredentialRowSync } = await import(
      "../../src/lib/db/helpers/credentialStorage.js"
    );
    // TOKENHOP_MULTI_USER=off semantics: marker still latches encryption.
    const ctx = prepareCredentialContext(db, { kid: KID, key: MASTER });
    expect(ctx.encrypted).toBe(true);
    const row = db.get(`SELECT * FROM providerConnections WHERE id = 'conn-personal'`);
    // Runtime codec usage: decode first (caller envelope objects are rejected
    // on encode), then patch the plaintext and re-encode.
    const decoded = decodeCredentialRowSync(db, row, ctx, {
      table: "providerConnections",
      mode: "runtime",
    });
    const next = encodeCredentialRowSync(
      db,
      { ...row, data: { ...decoded, accessToken: "sk-new-plaintext-3520" } },
      ctx,
      { table: "providerConnections", mode: "runtime" },
    );
    expect(JSON.parse(next).accessToken).toMatchObject({ v: 1 });
    expect(next).not.toContain("sk-new-plaintext-3520");
  });

  it("missing root key fails closed: no regeneration, no plaintext fallback, raw writes denied", async () => {
    await activate();
    const { activateCredentialEncryption } = await loadActivate();
    const { assertCredentialOperationAllowed } = await loadMaintenance();
    // Established storage without a usable root at startup: sticky failure
    // plus admission poison — raw writes and credential use are fenced (D3).
    await expect(
      activateCredentialEncryption(db, { enabled: true, beforeServing: true, root: null }),
    ).rejects.toMatchObject({ code: "KEY_MISSING" });
    expect(() => assertCredentialOperationAllowed(db)).toThrow();
    // Runtime decode without a root never substitutes empty credentials.
    expect(() =>
      decodeCredentialRowSync(
        db,
        db.get(`SELECT * FROM providerConnections WHERE id = 'conn-shared'`),
        prepareCredentialContext(db, null),
        { table: "providerConnections", mode: "runtime" },
      ),
    ).toThrow(code("KEY_MISSING"));
    // A wrong root never authenticates the existing envelopes.
    clearCredentialCache(db);
    expect(() =>
      decodeCredentialRowSync(
        db,
        db.get(`SELECT * FROM providerConnections WHERE id = 'conn-shared'`),
        prepareCredentialContext(db, { kid: KID, key: WRONG_MASTER }),
        { table: "providerConnections", mode: "runtime" },
      ),
    ).toThrow(code("DECRYPT_FAILED"));
    // No replacement root was ever generated.
    const keysDir = path.join(process.env.DATA_DIR, "keys");
    expect(fs.existsSync(path.join(keysDir, "master"))).toBe(false);
  });

  it("half marker (version without kid) throws CREDENTIAL_STATE_INVALID and never reads as legacy", () => {
    db.run(`INSERT INTO _meta(key, value) VALUES('credentialsEncryptedVersion','1')`);
    expect(() => readCredentialEncryptionState(db)).toThrow(code("CREDENTIAL_STATE_INVALID"));
  });

  it("stored envelopes without a marker never read as legacy (fail closed)", () => {
    encryptedMarker(KID);
    db.run(`DELETE FROM _meta WHERE key = 'credentialsEncryptedVersion'`);
    expect(() => readCredentialEncryptionState(db)).toThrow(code("CREDENTIAL_STATE_INVALID"));
  });

  it("workspace key rows without a marker never read as legacy", () => {
    db.run(`INSERT INTO workspaceKeys(workspaceId, kid, wrappedDek, createdAt) VALUES(?,?,?,?)`, [
      SHARED_WS,
      "dk_0123456789abcdef",
      "{}",
      NOW,
    ]);
    expect(() => readCredentialEncryptionState(db)).toThrow(code("CREDENTIAL_STATE_INVALID"));
  });

  it("plaintext covered secret in encrypted storage is rejected on runtime read (no silent trust)", async () => {
    const { activateCredentialEncryption } = await loadActivate();
    await activateCredentialEncryption(db, {
      enabled: true,
      beforeServing: true,
      root: { kid: KID, key: MASTER },
    });
    const raw = JSON.parse(
      db.get(`SELECT data FROM providerConnections WHERE id = 'conn-shared'`).data,
    );
    raw.accessToken = "sk-injected-plaintext-3521";
    db.run(`UPDATE providerConnections SET data = ? WHERE id = 'conn-shared'`, [
      JSON.stringify(raw),
    ]);
    const ctx = prepareCredentialContext(db, { kid: KID, key: MASTER });
    expect(() =>
      decodeCredentialRowSync(
        db,
        db.get(`SELECT * FROM providerConnections WHERE id = 'conn-shared'`),
        ctx,
        { table: "providerConnections", mode: "runtime" },
      ),
    ).toThrow(code("PLAINTEXT_REJECTED"));
  });
});

describe("crash after commit before cleanup (C4/D7)", () => {
  it("restart finishes pending cleanup before readiness; cleanup marker is durable", async () => {
    const { activateCredentialEncryption } = await loadActivate();
    // Simulate the crash window: activation transaction committed, durable
    // cleanup-pending marker present, VACUUM/checkpoint not yet run.
    const result = await activateCredentialEncryption(db, {
      enabled: true,
      beforeServing: true,
      root: { kid: KID, key: MASTER },
      crashAfter: "commit-before-cleanup", // test-only fixture boundary
    });
    expect(result).toMatchObject({ status: "crash-pending-cleanup" });
    expect(readCredentialEncryptionState(db).cleanupPending).toBe(true);

    // Fresh adapter from the persisted file (independent disk reopen, not
    // module reuse): recovery must complete cleanup before readiness.
    const reopened = await createSqlJsAdapter(path.join(tempDir, "act.sqlite"));
    try {
      const recovered = await activateCredentialEncryption(reopened, {
        enabled: true,
        beforeServing: true,
        root: { kid: KID, key: MASTER },
      });
      expect(recovered).toMatchObject({ status: "ready" });
      expect(readCredentialEncryptionState(reopened).cleanupPending).toBe(false);
      const ctx = prepareCredentialContext(reopened, { kid: KID, key: MASTER });
      const decoded = decodeCredentialRowSync(
        reopened,
        reopened.get(`SELECT * FROM providerConnections WHERE id = 'conn-shared'`),
        ctx,
        { table: "providerConnections", mode: "runtime" },
      );
      expect(decoded.accessToken).toBe(sentinels().accessToken);
    } finally {
      clearCredentialCache(reopened);
      reopened.close();
    }
  });
});
