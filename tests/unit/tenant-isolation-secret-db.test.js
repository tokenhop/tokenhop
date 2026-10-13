import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqlJsAdapter } from "@/lib/db/adapters/sqljsAdapter.js";
import { runMigrationOnce } from "@/lib/db/migrate.js";
import {
  clearCredentialCache,
  decodeCredentialRowSync,
  encodeCredentialRowSync,
  prepareCredentialContext,
} from "@/lib/db/helpers/credentialStorage.js";
import { deriveApiKeyHashKey, hashApiKey } from "@/lib/security/masterKey.js";
import {
  SENT,
  SCAN,
  NO_LEAKS,
  NOW,
  MASTER,
  KID,
  HASHED_KEYS_TABLE,
} from "../helpers/tenantSecretFixture.js";
import { findSecretLeaks, leakSummary } from "../helpers/secretScan.js";

const savedMaster = process.env.TOKENHOP_MASTER_KEY;
process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
afterAll(() => {
  if (savedMaster === undefined) delete process.env.TOKENHOP_MASTER_KEY;
  else process.env.TOKENHOP_MASTER_KEY = savedMaster;
});

// ─── 4. Encrypted DB bytes ────────────────────────────────────────────────

describe("credential encryption at rest", () => {
  let tempDir;
  let db;
  const dbFile = () => path.join(tempDir, "iso.sqlite");

  function seedLegacy() {
    db.exec(`DELETE FROM memberships; DELETE FROM identities; DELETE FROM providerNodes;
      DELETE FROM providerConnections; DELETE FROM workspaces; DELETE FROM users;
      DELETE FROM _meta WHERE key IN ('defaultWorkspaceId','apiKeysHashedVersion','apiKeysHashKid','credentialsEncryptedVersion','credentialsKekKid','credentialsCleanupPending')`);
    db.run(
      `INSERT INTO users(id, email, username, displayName, instanceRole, status, sessionVersion, createdAt, updatedAt)
       VALUES('owner-1','owner@x.test','owner','owner','owner','active',1,?,?)`,
      [NOW, NOW],
    );
    db.run(
      `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES('ws-a','A','shared','owner-1',?,?)`,
      [NOW, NOW],
    );
    db.run(
      `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES('ws-a','owner-1','owner','manual',?)`,
      [NOW],
    );
    db.run(`INSERT INTO _meta(key, value) VALUES('defaultWorkspaceId','ws-a')`);
    db.run(`INSERT INTO settings(id, data) VALUES(1, ?)`, [
      JSON.stringify({
        oidcClientSecret: SENT.password,
        samlPrivateKey: SENT.hexHash,
        displayName: "Instance",
      }),
    ]);
    // Gateway keys already hashed (activation prerequisite).
    db.exec(`DROP TABLE IF EXISTS apiKeys`);
    db.exec(HASHED_KEYS_TABLE);
    db.run(
      `INSERT INTO apiKeys(id, workspaceId, userId, createdByUserId, keyHash, hashKid, prefix, name, legacy, isActive, allowedModels, createdAt)
       VALUES('hk-1','ws-a','owner-1','owner-1',?,?,'sk-se','Runner',1,1,'[]',?)`,
      [hashApiKey(SENT.gatewayKey, deriveApiKeyHashKey(MASTER)), KID, NOW],
    );
    db.run(
      `INSERT INTO _meta(key, value) VALUES('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)`,
      [KID],
    );
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, workspaceId, createdByUserId, createdAt, updatedAt)
       VALUES('conn-a','openai','api_key','A',NULL,1,1,?,'ws-a','owner-1',?,?)`,
      [
        JSON.stringify({
          accessToken: SENT.oauthAccessToken,
          refreshToken: SENT.oauthRefreshToken,
          apiKey: SENT.connectionApiKey,
          note: "not-a-secret",
        }),
        NOW,
        NOW,
      ],
    );
  }

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sent378-db-"));
    db = await createSqlJsAdapter(dbFile());
    await runMigrationOnce(db);
    seedLegacy();
  });

  afterEach(() => {
    clearCredentialCache(db);
    db?.close();
    db = null;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function activate() {
    const { activateCredentialEncryption } = await import(
      "../../src/lib/db/activateCredentialEncryption.js"
    );
    const result = await activateCredentialEncryption(db, {
      enabled: true,
      beforeServing: true,
      root: { kid: KID, key: MASTER },
    });
    expect(result).toMatchObject({ status: "ready" });
  }

  function dbBytes() {
    const parts = [];
    for (const suffix of ["", "-wal", "-shm"]) {
      const f = `${dbFile()}${suffix}`;
      if (fs.existsSync(f)) parts.push(fs.readFileSync(f));
    }
    return parts;
  }

  // Raw sqlite bytes: exact sentinels only (no shape heuristics on binary).
  // Sole exemption: the gateway key HASH, which apiKeys.keyHash stores at rest
  // by design (the raw key and every credential sentinel stay forbidden).
  const bytesLeaks = () =>
    dbBytes().flatMap((b) =>
      findSecretLeaks(b, { sentinels: SCAN, allow: (_v, _k, name) => name === "gatewayKeyHash" }),
    );

  it("database file contains no plaintext sentinel after activation", async () => {
    await activate();
    db.flushSync();
    expect(leakSummary(bytesLeaks()), `db bytes after activation: ${NO_LEAKS}`).toBe("");
  });

  it("database file contains no plaintext sentinel after a runtime credential write", async () => {
    await activate();
    const ctx = prepareCredentialContext(db, { kid: KID, key: MASTER });
    const data = encodeCredentialRowSync(
      db,
      {
        id: "conn-b",
        data: {
          accessToken: SENT.oauthAccessToken,
          refreshToken: SENT.oauthRefreshToken,
          apiKey: SENT.connectionApiKey,
          note: "keep",
        },
        workspaceId: "ws-a",
      },
      ctx,
      { table: "providerConnections", workspaceId: "ws-a" },
    );
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, workspaceId, createdByUserId, createdAt, updatedAt)
       VALUES('conn-b','openai','oauth','B',NULL,1,1,?,'ws-a','owner-1',?,?)`,
      [data, NOW, NOW],
    );
    db.flushSync();
    expect(leakSummary(bytesLeaks()), `db bytes after write: ${NO_LEAKS}`).toBe("");
    // Reopen the file: ciphertext must round-trip back to the sentinels.
    const reopened = await createSqlJsAdapter(dbFile());
    try {
      const rctx = prepareCredentialContext(reopened, { kid: KID, key: MASTER });
      const decoded = decodeCredentialRowSync(
        reopened,
        reopened.get(`SELECT * FROM providerConnections WHERE id='conn-b'`),
        rctx,
        { table: "providerConnections" },
      );
      expect(decoded.accessToken).toBe(SENT.oauthAccessToken);
      expect(decoded.apiKey).toBe(SENT.connectionApiKey);
    } finally {
      reopened.close();
    }
  });
});
