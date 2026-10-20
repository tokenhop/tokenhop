// YAN-1106: shared encrypted/hashed single-key fixture for the request-scope and
// hash-key-memo suites. vi.mock is file-scoped, so each test file mocks the driver,
// cliTokenPolicy and masterKey loader itself and hands those mocks in here.
import path from "node:path";
import { createSqlJsAdapter } from "@/lib/db/adapters/sqljsAdapter.js";
import { runMigrationOnce } from "@/lib/db/migrate.js";
import { HASHED_API_KEYS_TABLE, buildCreateTableSql } from "@/lib/db/schema.js";
import { activateCredentialEncryption } from "@/lib/db/activateCredentialEncryption.js";
import { insertHashedApiKeySync } from "@/lib/db/repos/apiKeysRepo.js";
import { clearApiKeyPrincipalCache } from "@/lib/auth/apiKeyPrincipal.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";

export const MASTER = Buffer.alloc(32, 7);
export const NEXT = Buffer.alloc(32, 23);
export const root = { kid: masterKeyId(MASTER), key: MASTER };
export const nextRoot = { kid: masterKeyId(NEXT), key: NEXT };
export const token = `th_${"A".repeat(32)}`;
export const request = () =>
  new Request("http://localhost/v1/chat/completions", {
    headers: { authorization: `Bearer ${token}` },
  });

let sequence = 0;

/** Seed an encrypted, hashed-key database for workspace `w` and wire the mocks. */
export async function seedScopeDb({ getAdapter, loadMasterKey, cliTokenAcceptedWith }) {
  const db = await createSqlJsAdapter(
    path.join(process.env.DATA_DIR, `scope-${sequence++}.sqlite`),
  );
  await runMigrationOnce(db);
  getAdapter.mockResolvedValue(db);
  loadMasterKey.mockReset().mockResolvedValue(root);
  cliTokenAcceptedWith.mockReset().mockResolvedValue(false);
  clearApiKeyPrincipalCache();
  db.exec(`DROP TABLE apiKeys; ${buildCreateTableSql("apiKeys", HASHED_API_KEYS_TABLE)}`);
  db.run(
    `INSERT INTO users(id,instanceRole,status,createdAt,updatedAt) VALUES('u','owner','active','n','n')`,
  );
  db.run(
    `INSERT INTO workspaces(id,name,kind,createdAt,updatedAt) VALUES('w','Default','shared','n','n')`,
  );
  db.run(`INSERT INTO memberships(workspaceId,userId,role,createdAt) VALUES('w','u','owner','n')`);
  db.run(
    `INSERT INTO _meta(key,value) VALUES('defaultWorkspaceId','w'),('apiKeysHashedVersion','1'),('apiKeysHashKid',?)`,
    [root.kid],
  );
  insertHashedApiKeySync(db, {
    id: "key",
    workspaceId: "w",
    userId: "u",
    createdByUserId: "u",
    keyHash: hashApiKey(token, deriveApiKeyHashKey(MASTER)),
    hashKid: root.kid,
    prefix: "th_AAAA…AAAA",
    name: "key",
    legacy: 0,
    isActive: 1,
    allowedModels: [],
    allowedCombos: [],
    createdAt: new Date().toISOString(),
  });
  db.run(`INSERT OR REPLACE INTO settings(id,data) VALUES(1,'{"requireApiKey":true}')`);
  db.run(`INSERT INTO providerConnections(id,provider,authType,name,priority,isActive,data,workspaceId,createdAt,updatedAt)
    VALUES('c','openai','apikey','c',1,1,'{"apiKey":"connection-secret"}','w','n','n')`);
  db.run(`INSERT INTO providerNodes(id,type,name,data,workspaceId,createdAt,updatedAt)
    VALUES('node','openai-compatible','node','{"apiKey":"node-secret"}','w','n','n')`);
  await activateCredentialEncryption(db, { enabled: true, beforeServing: true, root });
  loadMasterKey.mockClear();
  return db;
}
