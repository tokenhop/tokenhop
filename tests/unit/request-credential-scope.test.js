import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqlJsAdapter } from "@/lib/db/adapters/sqljsAdapter.js";
import { runMigrationOnce } from "@/lib/db/migrate.js";
import { HASHED_API_KEYS_TABLE, buildCreateTableSql } from "@/lib/db/schema.js";
import { activateCredentialEncryption } from "@/lib/db/activateCredentialEncryption.js";
import { rotateKek } from "@/lib/security/keyRotation.js";
import { poisonCredentialMaintenance } from "@/lib/db/credentialMaintenance.js";
import { readApiKeyStorageState } from "@/lib/db/apiKeyState.js";
import { insertHashedApiKeySync } from "@/lib/db/repos/apiKeysRepo.js";
import {
  prepareCredentialCtx,
  assertCredentialCtxCurrent,
} from "@/lib/db/repos/connectionsRepo.js";
import * as scopeModule from "@/lib/security/requestCredentialScope.js";
import { resolveApiKey, clearApiKeyPrincipalCache } from "@/lib/auth/apiKeyPrincipal.js";
import { authorizeGatewayTarget, resolveGatewayAuth } from "@/lib/auth/gatewayAuth.js";
import { getGatewayConnections, getGatewayNodes } from "@/lib/auth/gatewayResources.js";
import { getApiKeyHashKey, resolveApiKeyHashKeyForAuth } from "@/lib/security/apiKeyHashKey.js";

vi.mock("@/lib/db/driver.js", () => ({ getAdapter: vi.fn() }));
vi.mock("@/lib/auth/cliTokenPolicy.js", () => ({ cliTokenAcceptedWith: vi.fn() }));
vi.mock("@/lib/security/masterKey.js", async (original) => ({
  ...(await original()),
  loadMasterKey: vi.fn(),
}));
import { getAdapter } from "@/lib/db/driver.js";
import { cliTokenAcceptedWith } from "@/lib/auth/cliTokenPolicy.js";
import {
  loadMasterKey,
  masterKeyId,
  deriveApiKeyHashKey,
  hashApiKey,
} from "@/lib/security/masterKey.js";

const MASTER = Buffer.alloc(32, 7);
const NEXT = Buffer.alloc(32, 23);
const root = { kid: masterKeyId(MASTER), key: MASTER };
const nextRoot = { kid: masterKeyId(NEXT), key: NEXT };
const token = `th_${"A".repeat(32)}`;
const request = () =>
  new Request("http://localhost/v1/chat/completions", {
    headers: { authorization: `Bearer ${token}` },
  });
const invalid = (code) => expect.objectContaining({ code });
let db;
let sequence = 0;

beforeEach(async () => {
  db = await createSqlJsAdapter(path.join(process.env.DATA_DIR, `scope-${sequence++}.sqlite`));
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
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

const rotate = () => rotateKek(db, { root, newRoot: nextRoot, fileManaged: false });

describe("request credential scope", () => {
  it("loads root once for handler auth plus repeated connection/node decrypts; edge separate", async () => {
    const edge = await resolveGatewayAuth(request());
    expect(edge.principal).toBeTruthy();
    expect(loadMasterKey).toHaveBeenCalledOnce();
    loadMasterKey.mockClear();
    const { principal } = await resolveGatewayAuth(request());
    expect(principal).not.toBe(edge.principal);
    expect((await getGatewayConnections(principal))[0].apiKey).toBe("connection-secret");
    expect((await getGatewayNodes(principal))[0].apiKey).toBe("node-secret");
    const rows = db.all("SELECT * FROM providerConnections");
    const one = await scopeModule.decodeRequestCredentialRows(db, principal, rows, {
      table: "providerConnections",
    });
    const two = await scopeModule.decodeRequestCredentialRows(db, principal, rows, {
      table: "providerConnections",
    });
    expect(one[0]).toEqual(two[0]);
    expect(one[0]).not.toBe(two[0]);
    expect(loadMasterKey).toHaveBeenCalledOnce();
  });

  it("threads API-key state through auth/hash without duplicate reads (eligibility stays live)", async () => {
    const spy = vi.spyOn(db, "all");
    const apiReads = () =>
      spy.mock.calls.filter(([, keys]) => keys?.includes("apiKeysHashedVersion")).length;
    await resolveGatewayAuth(request());
    // YAN-1106: gateway state is read once; the live eligibility SQL joins the
    // `_meta` markers itself, so revocation/kid checks stay live regardless.
    expect(apiReads()).toBe(1);
    spy.mockClear();
    await getApiKeyHashKey(db, { apiKeyState: readApiKeyStorageState(db) });
    expect(apiReads()).toBe(0); // no write since the last read: memo hit
  });

  it("rotation after auth kills scope, aborts write with typed retry, next request succeeds", async () => {
    const { principal } = await resolveGatewayAuth(request());
    const ctx = await prepareCredentialCtx(db);
    await rotate();
    const before = db.get(`SELECT data FROM providerConnections WHERE id='c'`).data;
    expect(() =>
      db.transaction(() => {
        assertCredentialCtxCurrent(db, ctx);
        db.run(`UPDATE providerConnections SET data='{}' WHERE id='c'`);
      }),
    ).toThrow(invalid("KEY_MISMATCH"));
    expect(db.get(`SELECT data FROM providerConnections WHERE id='c'`).data).toBe(before);
    await expect(getGatewayConnections(principal)).rejects.toMatchObject({
      code: "KEY_MISMATCH",
      message: "credential encryption state changed during the request; retry",
    });
    await expect(getGatewayConnections(principal)).rejects.toThrow(invalid("KEY_MISMATCH"));
    loadMasterKey.mockResolvedValue(nextRoot);
    const fresh = await resolveGatewayAuth(request());
    expect((await getGatewayConnections(fresh.principal))[0].apiKey).toBe("connection-secret");
  });

  it("marker signature rechecked after async lazy root load; scope remains dead", async () => {
    cliTokenAcceptedWith.mockResolvedValue(true);
    const { principal } = await resolveGatewayAuth(new Request("http://localhost/v1/models"));
    loadMasterKey.mockImplementationOnce(async () => {
      await rotate();
      return root;
    });
    await expect(getGatewayConnections(principal)).rejects.toThrow(invalid("KEY_MISMATCH"));
    loadMasterKey.mockResolvedValue(nextRoot);
    await expect(getGatewayConnections(principal)).rejects.toThrow(invalid("KEY_MISMATCH"));
  });

  it("owner scope loads root lazily and only once", async () => {
    cliTokenAcceptedWith.mockResolvedValue(true);
    const { principal } = await resolveGatewayAuth(new Request("http://localhost/v1/models"));
    expect(principal.via).toBe("cli");
    expect(loadMasterKey).not.toHaveBeenCalled();
    await Promise.all([getGatewayConnections(principal), getGatewayNodes(principal)]);
    expect(loadMasterKey).toHaveBeenCalledOnce();
  });

  it("poison checked on every decode, scoped and live fallback", async () => {
    const { principal } = await resolveGatewayAuth(request());
    expect((await getGatewayConnections(principal))[0].apiKey).toBe("connection-secret");
    poisonCredentialMaintenance(db, new Error("uncertain publication"));
    for (const p of [principal, Object.freeze({ ...principal })]) {
      await expect(getGatewayConnections(p)).rejects.toThrow(
        invalid("CREDENTIAL_MAINTENANCE_POISONED"),
      );
      await expect(getGatewayNodes(p)).rejects.toThrow(invalid("CREDENTIAL_MAINTENANCE_POISONED"));
    }
    await expect(prepareCredentialCtx(db)).rejects.toThrow(
      invalid("CREDENTIAL_MAINTENANCE_POISONED"),
    );
  });

  it("live fallback (forged/aged/other adapter/repo ctx) rechecks marker + poison after root load", async () => {
    const { principal } = await resolveGatewayAuth(request());
    const forged = Object.freeze({ ...principal });
    loadMasterKey.mockImplementationOnce(async () => {
      await rotate();
      return root;
    });
    await expect(getGatewayConnections(forged)).rejects.toThrow(invalid("KEY_MISMATCH"));
    loadMasterKey.mockResolvedValue(nextRoot);
    expect((await getGatewayConnections(forged))[0].apiKey).toBe("connection-secret");
    // poison landing during the load
    loadMasterKey.mockImplementationOnce(async () => {
      poisonCredentialMaintenance(db, new Error("p"));
      return nextRoot;
    });
    await expect(getGatewayNodes(forged)).rejects.toThrow(
      invalid("CREDENTIAL_MAINTENANCE_POISONED"),
    );
  });

  it("repository live path rechecks marker after async root load", async () => {
    loadMasterKey.mockImplementationOnce(async () => {
      await rotate();
      return root;
    });
    await expect(prepareCredentialCtx(db)).rejects.toThrow(invalid("KEY_MISMATCH"));
    loadMasterKey.mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "KEY_MISSING" }));
    await expect(prepareCredentialCtx(db)).rejects.toThrow(invalid("KEY_MISSING"));
  });

  it("aged and different-adapter scopes fall back to live path with the same rechecks", async () => {
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now);
    const { principal } = await resolveGatewayAuth(request());
    spy.mockReturnValue(now + 5 * 60 * 1000);
    loadMasterKey.mockImplementationOnce(async () => {
      await rotate();
      return root;
    });
    await expect(getGatewayConnections(principal)).rejects.toThrow(invalid("KEY_MISMATCH"));
    // A distinct adapter identity wrapping the same store must not reuse root.
    const other = { all: db.all.bind(db), get: db.get.bind(db) };
    expect(scopeModule.requestScopeOf(principal, other)).toBeNull();
    loadMasterKey.mockImplementationOnce(async () => {
      db.run("INSERT OR REPLACE INTO _meta(key,value) VALUES('credentialsCleanupPending','1')");
      return nextRoot;
    });
    await expect(
      scopeModule.decodeRequestCredentialRows(other, principal, [], {
        table: "providerConnections",
      }),
    ).rejects.toThrow(invalid("KEY_MISMATCH"));
    loadMasterKey.mockImplementationOnce(async () => {
      poisonCredentialMaintenance(other, new Error("uncertain publication"));
      throw new Error("load failed");
    });
    await expect(
      scopeModule.decodeRequestCredentialRows(other, principal, [], {
        table: "providerConnections",
      }),
    ).rejects.toThrow(invalid("CREDENTIAL_MAINTENANCE_POISONED"));
  });

  it("forged frozen principal has no scope and always takes live root path", async () => {
    const real = await resolveApiKey(token);
    const forged = Object.freeze({ ...real });
    expect(scopeModule.requestScopeOf(forged)).toBeNull();
    expect(() => scopeModule.mintGatewayPrincipal(real, db)).toThrow(/not a frozen principal/);
    loadMasterKey.mockClear();
    await getGatewayConnections(forged);
    await getGatewayNodes(forged);
    expect(loadMasterKey).toHaveBeenCalledTimes(2);
    loadMasterKey.mockRejectedValue(
      Object.assign(new Error("removed root"), { code: "KEY_MISSING" }),
    );
    await expect(getGatewayConnections(forged)).rejects.toThrow(invalid("KEY_MISSING"));
    expect((await getGatewayConnections(real))[0].apiKey).toBe("connection-secret");
    const next = await resolveGatewayAuth(request());
    expect(next.status).toBe(503);
  });

  it("revoked key rejected next request even with warm digest/scope", async () => {
    const { principal } = await resolveGatewayAuth(request());
    await getGatewayConnections(principal);
    db.run(`UPDATE apiKeys SET revokedAt=? WHERE id='key'`, [new Date().toISOString()]);
    const denied = await resolveGatewayAuth(request());
    expect(denied.status).toBe(401);
  });

  it("five-minute hard age falls back to live state and drops the retained root", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const principal = await resolveApiKey(token);
    const held = scopeModule.requestScopeOf(principal);
    loadMasterKey.mockClear();
    Date.now.mockReturnValue(now + 5 * 60 * 1000 - 1);
    expect(held.expired).toBe(false);
    await getGatewayConnections(principal);
    expect(loadMasterKey).not.toHaveBeenCalled(); // seeded by auth
    await rotate();
    Date.now.mockReturnValue(now + 5 * 60 * 1000);
    expect(held.expired).toBe(true);
    expect(scopeModule.requestScopeOf(principal)).toBeNull();
    loadMasterKey.mockResolvedValue(nextRoot);
    expect((await getGatewayConnections(principal))[0].apiKey).toBe("connection-secret");
    expect(loadMasterKey).toHaveBeenCalledOnce();
  });

  it("scope boundary: no root/ctx/kek exported, one-shot seeded mint, no secret in returns", async () => {
    expect(Object.keys(scopeModule).sort()).toEqual([
      "decodeRequestCredentialRows",
      "mintGatewayPrincipal",
      "requestScopeOf",
    ]);
    const auth = await resolveApiKeyHashKeyForAuth(db);
    expect(Object.keys(auth).sort()).toEqual(["hashKey", "hashKid", "mint", "release"]);
    const fields = {
      workspaceId: "w",
      userId: "u",
      apiKeyId: "key",
      scopes: { allowedModels: [], allowedCombos: [] },
      via: "apiKey",
    };
    const seeded = auth.mint(fields);
    expect(() => auth.mint(fields)).toThrow(/already released/); // reused closure
    const auth2 = await resolveApiKeyHashKeyForAuth(db);
    auth2.release();
    expect(() => auth2.mint(fields)).toThrow(/already released/);
    expect(() => auth.mint(Object.freeze(fields))).toThrow(); // forged frozen principal as fields
    expect(() => auth2.mint(seeded)).toThrow(); // frozen real principal never rebinds
    // Returned handle: memo + expired only.
    const handle = scopeModule.requestScopeOf(seeded);
    expect(Object.keys(handle).sort()).toEqual(["expired", "memo"]);
    // Decoded rows carry data but no kek/ctx fields; principal/handle neither.
    const rows = await scopeModule.decodeRequestCredentialRows(
      db,
      seeded,
      db.all("SELECT * FROM providerConnections"),
      { table: "providerConnections" },
    );
    for (const value of [seeded, handle, rows]) {
      const text = JSON.stringify(value);
      expect(text).not.toMatch(/"kek"|"kekKid"|"allowCreate"|"root"/);
      expect(JSON.stringify(value, (_k, v) => (Buffer.isBuffer(v) ? "buf" : v))).not.toContain(
        MASTER.toString("base64"),
      );
    }
  });

  it("owner principals cannot be minted from a frozen copy and stay lazy/unseeded", async () => {
    cliTokenAcceptedWith.mockResolvedValue(true);
    const { principal } = await resolveGatewayAuth(new Request("http://localhost/v1/models"));
    expect(() => scopeModule.mintGatewayPrincipal(principal, db)).toThrow();
    expect(loadMasterKey).not.toHaveBeenCalled();
  });

  // YAN-1106: edge admission proves the key without building a request scope.
  describe("verifyOnly edge admission", () => {
    const edge = (headers) =>
      resolveGatewayAuth(new Request("http://localhost/v1/models", { headers }), {
        verifyOnly: true,
      });
    const bearer = { authorization: `Bearer ${token}` };

    it("admits a live key as a verdict only: no principal, no scope, no root copy", async () => {
      loadMasterKey.mockClear();
      const out = await edge(bearer);
      expect(out).toEqual({ principal: null, legacy: false, admitted: true, apiKeyId: "key" });
      expect(Object.isFrozen(out)).toBe(true);
      expect(JSON.stringify(out)).not.toContain(MASTER.toString("base64"));
      expect(JSON.stringify(out)).not.toMatch(/workspaceId|scopes|keyHash/);
    });

    it("the admission verdict can never act as a principal", async () => {
      const out = await edge(bearer);
      // Every shape an edge result could be mistaken for is refused.
      for (const shape of [
        out,
        { verified: true, apiKeyId: "key" },
        Object.freeze({ verified: true, apiKeyId: "key" }),
      ]) {
        const denied = authorizeGatewayTarget(shape, { modelId: "any/model" });
        expect(denied).toBeInstanceOf(Response);
        expect(denied.status).toBe(403);
      }
      // A principal-shaped object with no workspace is refused too.
      expect(
        authorizeGatewayTarget(
          { scopes: { allowedModels: [], allowedCombos: [] } },
          { modelId: "m" },
        )?.status,
      ).toBe(403);
      // Resource resolution rejects it (assertGatewayPrincipal) and no scope exists.
      expect(scopeModule.requestScopeOf(out)).toBeNull();
      await expect(getGatewayConnections(out)).rejects.toThrow();
      await expect(getGatewayNodes(out)).rejects.toThrow();
      // A real principal and the legacy null path are unchanged.
      const real = (await resolveGatewayAuth(request())).principal;
      expect(authorizeGatewayTarget(real, { modelId: "any/model" })).toBeNull();
      expect(authorizeGatewayTarget(null, { modelId: "any/model" })).toBeNull();
    });

    it.each([
      ["wrong key", { authorization: `Bearer th_${"B".repeat(32)}` }],
      ["empty bearer", { authorization: "Bearer" }],
      ["malformed whitespace", { authorization: `Bearer ${token} x` }],
    ])("denies %s exactly like the full resolver", async (_n, headers) => {
      const full = await resolveGatewayAuth(new Request("http://localhost/v1/models", { headers }));
      const out = await edge(headers);
      expect(out).toBeInstanceOf(Response);
      expect(out.status).toBe(full.status);
    });

    it.each([
      ["revoked", "UPDATE apiKeys SET revokedAt = '2026-01-01T00:00:00.000Z'"],
      ["paused", "UPDATE apiKeys SET isActive = 0"],
      ["expired", "UPDATE apiKeys SET expiresAt = '2000-01-01T00:00:00.000Z'"],
      ["owner left workspace", "DELETE FROM memberships"],
      ["owner disabled", "UPDATE users SET status = 'disabled'"],
    ])(
      "a %s key is denied on the very next edge check (even after a cached admit)",
      async (_n, sql) => {
        expect((await edge(bearer)).admitted).toBe(true); // warms the digest cache
        db.run(sql);
        const out = await edge(bearer);
        expect(out).toBeInstanceOf(Response);
        expect(out.status).toBe(401);
      },
    );

    it("a root rotated mid-flight fails closed at the edge too (no admit on stale root)", async () => {
      expect((await edge(bearer)).admitted).toBe(true);
      await rotate();
      loadMasterKey.mockResolvedValue(root); // stale root: kid no longer matches the marker
      loadMasterKey.mockImplementation(async ({ expectedKid } = {}) => {
        if (expectedKid && expectedKid !== root.kid)
          throw Object.assign(new Error("master key id mismatch"), { code: "MASTER_KEY_INVALID" });
        return root;
      });
      const out = await edge(bearer);
      expect(out).toBeInstanceOf(Response);
      expect(out.status).toBe(503);
    });

    it("a poisoned adapter denies the edge", async () => {
      poisonCredentialMaintenance(db, new Error("uncertain commit"));
      const out = await edge(bearer);
      expect(out).toBeInstanceOf(Response);
      expect(out.status).toBe(503);
    });
  });
});

// YAN-1106 round 2: the unwrapped API-key hash key is memoized per
// (credential markers, hash kid, default workspace, root kid) and must never
// outlive a marker change, a root change, its TTL, or a poisoned adapter.
describe("hash key memo", () => {
  const unwrapSpy = () => vi.spyOn(db, "get");
  const wrapReads = () =>
    db.get.mock.calls.filter(([sql]) => String(sql).includes("apiKeyHashKeyWrapped")).length;

  it("hits while nothing changes and returns private copies", async () => {
    const a = await getApiKeyHashKey(db);
    const b = await getApiKeyHashKey(db);
    expect(a.hashKey.equals(b.hashKey)).toBe(true);
    expect(a.hashKey).not.toBe(b.hashKey);
    a.hashKey.fill(0);
    const c = await getApiKeyHashKey(db);
    expect(c.hashKey.equals(b.hashKey)).toBe(true);
    expect(c.hashKey.some((x) => x !== 0)).toBe(true);
  });

  it("a KEK rotation misses the memo and the old root is refused afterwards", async () => {
    const before = await getApiKeyHashKey(db);
    await rotate();
    // Stale root (old kid) can no longer unwrap: markers moved, so nothing is served from memory.
    loadMasterKey.mockImplementation(async ({ expectedKid } = {}) => {
      if (expectedKid && expectedKid !== root.kid) {
        throw Object.assign(new Error("master key id mismatch"), { code: "MASTER_KEY_INVALID" });
      }
      return root;
    });
    await expect(getApiKeyHashKey(db)).rejects.toMatchObject({ code: "MASTER_KEY_INVALID" });
    loadMasterKey.mockResolvedValue(nextRoot);
    const after = await getApiKeyHashKey(db);
    expect(after.hashKey.equals(before.hashKey)).toBe(true); // frozen identity, same derived key
  });

  it("a wrapped-key marker change re-runs the authenticated unwrap", async () => {
    await getApiKeyHashKey(db);
    const wrapped = db.get(`SELECT value FROM _meta WHERE key='apiKeyHashKeyWrapped'`).value;
    const forged = JSON.parse(wrapped);
    forged.ct = Buffer.from("tampered-bytes-tampered-bytes-12").toString("base64");
    db.run(`UPDATE _meta SET value = ? WHERE key='apiKeyHashKeyWrapped'`, [JSON.stringify(forged)]);
    await expect(getApiKeyHashKey(db)).rejects.toBeTruthy(); // authentication fails, memo not served
  });

  it("a root whose kid differs from the memoized one is never satisfied from memory", async () => {
    await getApiKeyHashKey(db);
    loadMasterKey.mockResolvedValue({ kid: "ffffffffffffffff", key: Buffer.alloc(32, 9) });
    await expect(getApiKeyHashKey(db)).rejects.toBeTruthy();
  });

  it("a caller-supplied root always runs the full authenticated unwrap", async () => {
    await getApiKeyHashKey(db);
    const bad = { kid: root.kid, key: Buffer.alloc(32, 5) };
    await expect(getApiKeyHashKey(db, { root: bad })).rejects.toBeTruthy();
    expect((await getApiKeyHashKey(db, { root })).hashKey.length).toBe(32);
  });

  it("a poisoned adapter blocks even a warm memo", async () => {
    await getApiKeyHashKey(db);
    poisonCredentialMaintenance(db, new Error("uncertain commit"));
    await expect(getApiKeyHashKey(db)).rejects.toMatchObject({
      code: "CREDENTIAL_MAINTENANCE_POISONED",
    });
  });

  it("clearApiKeyHashKeyStateCache and a root-change notification drop (and zero) the memo", async () => {
    const { clearApiKeyHashKeyStateCache } = await import("@/lib/security/apiKeyHashKey.js");
    const { clearMasterKeyCache, onMasterKeyChange } = await import("@/lib/security/masterKey.js");
    const realFill = Buffer.prototype.fill;
    const zeroed = [];
    vi.spyOn(Buffer.prototype, "fill").mockImplementation(function (...args) {
      if (this.length === 32 && args[0] === 0) zeroed.push(this);
      return realFill.apply(this, args);
    });
    const heard = vi.fn();
    const off = onMasterKeyChange(heard);
    for (const drop of [() => clearApiKeyHashKeyStateCache(db), () => clearMasterKeyCache()]) {
      await getApiKeyHashKey(db);
      const before = zeroed.length;
      drop();
      expect(zeroed.length).toBeGreaterThan(before); // retained copy wiped
    }
    expect(heard).toHaveBeenCalled(); // root-change listeners fire on explicit changes
    off();
  });

  it("the memoized key is zeroed at TTL with no further calls", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const realFill = Buffer.prototype.fill;
      const zeroed = [];
      vi.spyOn(Buffer.prototype, "fill").mockImplementation(function (...args) {
        if (this.length === 32 && args[0] === 0) zeroed.push(this);
        return realFill.apply(this, args);
      });
      await getApiKeyHashKey(db);
      const before = zeroed.length;
      await vi.advanceTimersByTimeAsync(31_000);
      expect(zeroed.length).toBeGreaterThan(before);
      expect(zeroed.at(-1).equals(Buffer.alloc(32))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("hash key memo and a marker change during the root load", () => {
  const entryCount = () => {
    const slot = globalThis[Symbol.for("tokenhop.apiKeyHashKeyCache")];
    return slot.entry ? 1 : 0;
  };

  it("a rotation committed while the root loads is never remembered", async () => {
    const { clearApiKeyHashKeyStateCache } = await import("@/lib/security/apiKeyHashKey.js");
    clearApiKeyHashKeyStateCache(db);
    loadMasterKey.mockImplementationOnce(async () => {
      await rotate(); // markers move between the first read and the end of the load
      return root;
    });
    await getApiKeyHashKey(db).catch(() => {});
    expect(entryCount()).toBe(0);
  });

  it("a plain marker write during the load is not remembered either", async () => {
    const { clearApiKeyHashKeyStateCache } = await import("@/lib/security/apiKeyHashKey.js");
    clearApiKeyHashKeyStateCache(db);
    loadMasterKey.mockImplementationOnce(async () => {
      db.run(`UPDATE _meta SET value = '0' WHERE key = 'credentialsCleanupPending'`);
      db.run(`INSERT OR REPLACE INTO _meta(key,value) VALUES('credentialsCleanupPending','1')`);
      return root;
    });
    await getApiKeyHashKey(db);
    expect(entryCount()).toBe(0);
    // a quiet follow-up call remembers again
    await getApiKeyHashKey(db);
    expect(entryCount()).toBe(1);
  });

  it("a request that raced the rotation fails closed and the next one succeeds", async () => {
    loadMasterKey.mockImplementationOnce(async () => {
      await rotate();
      return root;
    });
    const raced = await resolveGatewayAuth(request()).catch((e) => e);
    // The old-root auth must not hand back a usable, stale-keyed principal.
    if (!(raced instanceof Response) && !(raced instanceof Error)) {
      await expect(getGatewayConnections(raced.principal)).rejects.toMatchObject({
        code: "KEY_MISMATCH",
      });
    }
    loadMasterKey.mockResolvedValue(nextRoot);
    const fresh = await resolveGatewayAuth(request());
    expect((await getGatewayConnections(fresh.principal))[0].apiKey).toBe("connection-secret");
  });

  it("the verify-only path wipes its copy of the derived key", async () => {
    const realFill = Buffer.prototype.fill;
    const zeroed = [];
    vi.spyOn(Buffer.prototype, "fill").mockImplementation(function (...args) {
      if (this.length === 32 && args[0] === 0) zeroed.push(this);
      return realFill.apply(this, args);
    });
    const out = await resolveGatewayAuth(request(), { verifyOnly: true });
    expect(out.admitted).toBe(true);
    expect(zeroed.length).toBeGreaterThan(0);
  });
});
