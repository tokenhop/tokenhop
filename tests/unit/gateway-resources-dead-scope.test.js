// YAN-1106 round 2 review: plain config reads memoized on the request scope fall
// back to a live read when the scope is dead (rotation mid-request), connection
// (credential) reads keep the typed KEY_MISMATCH, isModelDisabled never turns a
// credential/key-state error into "enabled", and the nodes memo key keeps
// `types: undefined` and `types: []` apart.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqlJsAdapter } from "@/lib/db/adapters/sqljsAdapter.js";
import { runMigrationOnce } from "@/lib/db/migrate.js";
import { activateCredentialEncryption } from "@/lib/db/activateCredentialEncryption.js";
import { rotateKek } from "@/lib/security/keyRotation.js";
import { mintGatewayPrincipal } from "@/lib/security/requestCredentialScope.js";
import { HASHED_API_KEYS_TABLE, buildCreateTableSql } from "@/lib/db/schema.js";

vi.mock("@/lib/db/driver.js", () => ({ getAdapter: vi.fn() }));
vi.mock("@/lib/security/masterKey.js", async (original) => ({
  ...(await original()),
  loadMasterKey: vi.fn(),
}));
import { getAdapter } from "@/lib/db/driver.js";
import { loadMasterKey, masterKeyId } from "@/lib/security/masterKey.js";
import {
  getGatewayCombos,
  getGatewayConnections,
  getGatewayDisabled,
  getGatewayNodesMetadata,
} from "@/lib/auth/gatewayResources.js";
import { isModelDisabled, isModelDisabledCached } from "@/sse/services/modelDisabled.js";

const MASTER = Buffer.alloc(32, 7);
const NEXT = Buffer.alloc(32, 23);
const root = { kid: masterKeyId(MASTER), key: MASTER };
const nextRoot = { kid: masterKeyId(NEXT), key: NEXT };
const FIELDS = {
  workspaceId: "w",
  userId: null,
  apiKeyId: "key",
  scopes: { allowedModels: [], allowedCombos: [] },
  via: "apiKey",
};

let db;
let sequence = 0;
const mint = () => mintGatewayPrincipal({ ...FIELDS }, db);
const NOW = "2026-10-13T00:00:00.000Z";

beforeEach(async () => {
  db = await createSqlJsAdapter(path.join(process.env.DATA_DIR, `dead-scope-${sequence++}.sqlite`));
  await runMigrationOnce(db);
  db.exec(`DROP TABLE apiKeys; ${buildCreateTableSql("apiKeys", HASHED_API_KEYS_TABLE)}`);
  db.run(
    `INSERT INTO workspaces(id,name,kind,createdAt,updatedAt) VALUES('w','Default','shared','n','n')`,
  );
  db.run(
    `INSERT INTO _meta(key,value) VALUES('defaultWorkspaceId','w'),('apiKeysHashedVersion','1'),('apiKeysHashKid',?)`,
    [root.kid],
  );
  db.run(
    "INSERT INTO combos(id,name,kind,models,workspaceId,createdAt,updatedAt) VALUES ('c1','mine','llm','[\"openai/gpt-4o\"]','w',?,?)",
    [NOW, NOW],
  );
  db.run(
    `INSERT INTO providerNodes(id,type,name,data,workspaceId,createdAt,updatedAt)
     VALUES('n1','openai-compatible','n1','{"prefix":"p","baseUrl":"http://x"}','w','n','n')`,
  );
  db.run(`INSERT INTO kv(scope,key,value) VALUES('disabledModels','ws:w/openai','["gpt-4o"]')`);
  db.run(`INSERT INTO providerConnections(id,provider,authType,name,priority,isActive,data,workspaceId,createdAt,updatedAt)
    VALUES('c','openai','apikey','c',1,1,'{"apiKey":"connection-secret"}','w','n','n')`);
  getAdapter.mockResolvedValue(db);
  loadMasterKey.mockReset().mockResolvedValue(root);
  await activateCredentialEncryption(db, { enabled: true, beforeServing: true, root });
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

const rotate = async () => {
  await rotateKek(db, { root, newRoot: nextRoot, fileManaged: false });
  loadMasterKey.mockResolvedValue(nextRoot);
};

describe("dead request scope (rotation mid-request)", () => {
  it("plain config reads degrade to live reads; none throws KEY_MISMATCH", async () => {
    const principal = mint();
    expect((await getGatewayCombos(principal)).map((c) => c.name)).toEqual(["mine"]); // warm
    await rotate();
    for (let i = 0; i < 2; i++) {
      expect((await getGatewayCombos(principal)).map((c) => c.name)).toEqual(["mine"]);
      expect(await getGatewayDisabled(principal)).toEqual({ openai: ["gpt-4o"] });
      const nodes = await getGatewayNodesMetadata(principal, { types: ["openai-compatible"] });
      expect(nodes.map((n) => n.id)).toEqual(["n1"]);
    }
  });

  it("a cold read on an already-dead scope also falls back", async () => {
    const principal = mint();
    await rotate();
    expect((await getGatewayCombos(principal)).map((c) => c.name)).toEqual(["mine"]);
  });

  it("credential reads on the same dead scope still fail with KEY_MISMATCH", async () => {
    const principal = mint();
    await getGatewayConnections(principal);
    await rotate();
    await expect(getGatewayConnections(principal)).rejects.toMatchObject({ code: "KEY_MISMATCH" });
  });

  it("loader errors that are not scope death still propagate", async () => {
    const principal = mint();
    const all = vi.spyOn(db, "all").mockImplementation(() => {
      throw Object.assign(new Error("disk"), { code: "SQLITE_IOERR" });
    });
    await expect(getGatewayCombos(principal)).rejects.toMatchObject({ code: "SQLITE_IOERR" });
    all.mockRestore();
  });
});

describe("isModelDisabled error handling", () => {
  it("rethrows credential/key-state errors instead of treating the model as enabled", async () => {
    for (const code of [
      "KEY_MISMATCH",
      "CREDENTIAL_STATE_INVALID",
      "CREDENTIAL_MAINTENANCE_POISONED",
      "API_KEY_STATE_INVALID",
    ]) {
      // Mint first: constructing a scope reads markers through db.all itself.
      const [live, memoized] = [mint(), mint()];
      const all = vi.spyOn(db, "all").mockImplementation(() => {
        throw Object.assign(new Error(code), { code });
      });
      await expect(isModelDisabled("openai", "gpt-4o", live)).rejects.toMatchObject({ code });
      await expect(isModelDisabledCached("openai", "gpt-4o", memoized)).rejects.toMatchObject({
        code,
      });
      all.mockRestore();
    }
  });

  it("a plain DB read error is still fail-open", async () => {
    const principal = mint();
    const all = vi.spyOn(db, "all").mockImplementation(() => {
      throw new Error("db down");
    });
    expect(await isModelDisabled("openai", "gpt-4o", principal)).toBe(false);
    all.mockRestore();
  });

  it("a rotation mid-request does not turn into 'enabled' or a spurious error", async () => {
    const principal = mint();
    expect(await isModelDisabledCached("openai", "gpt-4o", principal)).toBe(true);
    await rotate();
    // Dead scope: the plain disabled-map read stays correct via the live fallback.
    expect(await isModelDisabledCached("openai", "gpt-4o", principal)).toBe(true);
    expect(await isModelDisabled("openai", "gpt-4o", principal)).toBe(true);
  });
});

describe("nodes memo key", () => {
  it("types undefined (all) and [] (none) are different reads", async () => {
    const principal = mint();
    const all = await getGatewayNodesMetadata(principal, {});
    const none = await getGatewayNodesMetadata(principal, { types: [] });
    expect(all.map((n) => n.id)).toEqual(["n1"]);
    expect(none).toEqual([]);
    // Order of the first reads must not matter either.
    const second = mint();
    expect(await getGatewayNodesMetadata(second, { types: [] })).toEqual([]);
    expect((await getGatewayNodesMetadata(second, {})).map((n) => n.id)).toEqual(["n1"]);
  });

  it("type order does not change the read", async () => {
    const principal = mint();
    const a = await getGatewayNodesMetadata(principal, {
      types: ["openai-compatible", "anthropic-compatible"],
    });
    const b = await getGatewayNodesMetadata(principal, {
      types: ["anthropic-compatible", "openai-compatible"],
    });
    expect(b).toBe(a); // same memo slot
  });
});
