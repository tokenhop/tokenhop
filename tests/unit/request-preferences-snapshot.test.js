// Per-request settings snapshot: getEffectivePreferences memoizes stored layers
// on the minted principal's request scope only (no global cache, no write
// invalidation). Switch, membership, auth stay live; results are fresh clones.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqlJsAdapter } from "@/lib/db/adapters/sqljsAdapter.js";
import { runMigrationOnce } from "@/lib/db/migrate.js";
import { HASHED_API_KEYS_TABLE, buildCreateTableSql } from "@/lib/db/schema.js";
import { activateCredentialEncryption } from "@/lib/db/activateCredentialEncryption.js";
import { rotateKek } from "@/lib/security/keyRotation.js";
import { mintGatewayPrincipal, requestScopeOf } from "@/lib/security/requestCredentialScope.js";
import { poisonCredentialMaintenance } from "@/lib/db/credentialMaintenance.js";
import { getGatewayConnections, getGatewayNodes } from "@/lib/auth/gatewayResources.js";
import { comboStrategyFor } from "@/lib/comboKeys.js";
import { DEFAULT_SETTINGS, getEffectivePreferences } from "@/lib/db/repos/settingsRepo.js";

const sw = vi.hoisted(() => ({ on: true }));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: vi.fn() }));
vi.mock("@/lib/users/featureSwitch.js", () => ({
  isMultiUserEnabled: async () => sw.on,
}));
vi.mock("@/lib/security/masterKey.js", async (original) => ({
  ...(await original()),
  loadMasterKey: vi.fn(),
}));
import { getAdapter } from "@/lib/db/driver.js";
import { loadMasterKey, masterKeyId } from "@/lib/security/masterKey.js";

const MASTER = Buffer.alloc(32, 7);
const NEXT = Buffer.alloc(32, 23);
const root = { kid: masterKeyId(MASTER), key: MASTER };
const nextRoot = { kid: masterKeyId(NEXT), key: NEXT };
const BY_ID = Symbol.for("tokenhop.comboStrategiesById");
const WS = "w";
const FIELDS = {
  workspaceId: WS,
  userId: "u",
  apiKeyId: "key",
  scopes: { allowedModels: [], allowedCombos: [] },
  via: "apiKey",
};
const mint = (extra = FIELDS) => mintGatewayPrincipal({ ...extra }, db);

let db;
let sequence = 0;

const selects = (re) =>
  [...db.get.mock.calls, ...db.all.mock.calls].filter(([sql]) => re.test(sql)).length;
const instanceReads = () => selects(/FROM settings WHERE id = 1/);
const wsReads = () => selects(/FROM workspaceSettings/);
const userReads = () => selects(/FROM userPreferences/);
const setSettings = (raw) =>
  db.run(`INSERT OR REPLACE INTO settings(id,data) VALUES(1,?)`, [JSON.stringify(raw)]);
const setWs = (data) =>
  db.run(`INSERT OR REPLACE INTO workspaceSettings(workspaceId,data,updatedAt) VALUES(?,?,'n')`, [
    WS,
    JSON.stringify(data),
  ]);
const setUser = (data) =>
  db.run(`INSERT OR REPLACE INTO userPreferences(userId,data,updatedAt) VALUES('u',?,'n')`, [
    JSON.stringify(data),
  ]);
const activate = () =>
  activateCredentialEncryption(db, { enabled: true, beforeServing: true, root });

beforeEach(async () => {
  sw.on = true;
  db = await createSqlJsAdapter(path.join(process.env.DATA_DIR, `prefs-${sequence++}.sqlite`));
  await runMigrationOnce(db);
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
  db.run(
    `INSERT INTO apiKeys(id,workspaceId,userId,createdByUserId,keyHash,hashKid,prefix,name,legacy,isActive,allowedModels,allowedCombos,createdAt)
     VALUES('key','w','u','u','h',?, 'th_A','key',0,1,'[]','[]','n')`,
    [root.kid],
  );
  setSettings({
    requireApiKey: true,
    comboStrategy: "fallback",
    providerThinking: { claude: { mode: "high" } },
    oidcClientSecret: "oidc-secret",
  });
  db.run(`INSERT INTO providerConnections(id,provider,authType,name,priority,isActive,data,workspaceId,createdAt,updatedAt)
    VALUES('c','openai','apikey','c',1,1,'{"apiKey":"connection-secret"}','w','n','n')`);
  db.run(`INSERT INTO providerNodes(id,type,name,data,workspaceId,createdAt,updatedAt)
    VALUES('node','openai-compatible','node','{"apiKey":"node-secret"}','w','n','n')`);
  setWs({
    comboStrategy: "round-robin",
    providerStrategies: { x: { s: 1 } },
    comboStrategies: { cid: { fallbackStrategy: "weighted" } },
  });
  setUser({ startPage: "/mine" });
  getAdapter.mockResolvedValue(db);
  loadMasterKey.mockReset().mockResolvedValue(root);
  vi.spyOn(db, "get");
  vi.spyOn(db, "all");
  // Warm the repo's lazy featureSwitch import: concurrent first imports race the mock registry.
  await getEffectivePreferences(mint());
  db.get.mockClear();
  db.all.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe("per-request preferences snapshot", () => {
  it("one SELECT per layer per principal across repeated calls", async () => {
    const principal = mint();
    for (let i = 0; i < 4; i++) await getEffectivePreferences(principal);
    expect([instanceReads(), wsReads(), userReads()]).toEqual([1, 1, 1]);
    const eff = await getEffectivePreferences(principal);
    expect(eff).toMatchObject({ comboStrategy: "round-robin", startPage: "/mine" });
    expect(eff.providerThinking).toEqual({ claude: { mode: "high" } });
  });

  it("switch off: instance layer only, memoized; switching back on is live", async () => {
    const principal = mint();
    sw.on = false;
    const off = await getEffectivePreferences(principal);
    expect(off.comboStrategy).toBe("fallback");
    expect(off[BY_ID]).toBeUndefined();
    await getEffectivePreferences(principal);
    expect([instanceReads(), wsReads(), userReads()]).toEqual([1, 0, 0]);
    sw.on = true;
    expect((await getEffectivePreferences(principal)).comboStrategy).toBe("round-robin");
    expect([instanceReads(), wsReads(), userReads()]).toEqual([1, 1, 1]);
  });

  it("concurrent calls single-flight each layer", async () => {
    const principal = mint();
    await Promise.all(Array.from({ length: 6 }, () => getEffectivePreferences(principal)));
    expect([instanceReads(), wsReads(), userReads()]).toEqual([1, 1, 1]);
  });

  it("deep mutation of results never leaks into later results, layers or DEFAULT_SETTINGS", async () => {
    const principal = mint();
    const baseline = structuredClone(await getEffectivePreferences(principal));
    const defaults = structuredClone(DEFAULT_SETTINGS);
    const mutate = (eff) => {
      eff.retryPolicy[502].tries = 99;
      eff.cooldowns.longMs = 1;
      eff.capacityAdapter.vision.models.push("evil");
      eff.ssoAllowedGroups.push("evil");
      eff.providerThinking.claude.mode = "evil";
      eff.providerStrategies.injected = true;
      if (eff.comboStrategies.cid) eff.comboStrategies.cid.fallbackStrategy = "evil";
      eff.comboStrategies.added = 1;
      eff.startPage = "/evil";
    };
    mutate(await getEffectivePreferences(principal));
    mutate(await getEffectivePreferences(mint()));
    expect(await getEffectivePreferences(principal)).toEqual(baseline);
    expect(DEFAULT_SETTINGS).toEqual(defaults);
    sw.on = false;
    mutate(await getEffectivePreferences(principal));
    const off = await getEffectivePreferences(principal);
    expect(off.providerThinking).toEqual({ claude: { mode: "high" } });
    expect(DEFAULT_SETTINGS).toEqual(defaults);
  });

  it("same principal stays stable after updates; a new principal sees them", async () => {
    const principal = mint();
    const before = await getEffectivePreferences(principal);
    setSettings({ requireApiKey: true, comboStrategy: "fill-first" });
    setWs({ comboStrategy: "fusion" });
    setUser({ startPage: "/new" });
    const after = await getEffectivePreferences(principal);
    expect(after.comboStrategy).toBe(before.comboStrategy);
    expect(after.startPage).toBe("/mine");
    const fresh = await getEffectivePreferences(mint());
    expect(fresh.comboStrategy).toBe("fusion");
    expect(fresh.startPage).toBe("/new");
  });

  it("rejected memo loads are not cached: next call retries", async () => {
    const principal = mint();
    // First db.get on this path is the instance-layer read.
    db.get.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    await expect(getEffectivePreferences(principal)).rejects.toThrow("boom");
    const eff = await getEffectivePreferences(principal);
    expect(eff.comboStrategy).toBe("round-robin");
    expect(instanceReads()).toBe(2);
    await getEffectivePreferences(principal);
    expect(instanceReads()).toBe(2);
  });

  it("aged scope reads live every call", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const principal = mint();
    await getEffectivePreferences(principal);
    expect(instanceReads()).toBe(1);
    clock.mockReturnValue(now + 10 * 60 * 1000);
    setWs({ comboStrategy: "fusion" });
    expect((await getEffectivePreferences(principal)).comboStrategy).toBe("fusion");
    await getEffectivePreferences(principal);
    expect(instanceReads()).toBe(3);
    expect(wsReads()).toBe(3);
  });

  it("session membership is checked live on every call, outside the memo", async () => {
    const session = mint({
      userId: "u",
      activeWorkspaceId: WS,
      via: "session",
      scopes: { allowedModels: [], allowedCombos: [] },
    });
    expect((await getEffectivePreferences(session)).comboStrategy).toBe("round-robin");
    db.run(`DELETE FROM memberships WHERE workspaceId='w' AND userId='u'`);
    const out = await getEffectivePreferences(session);
    expect(out.comboStrategy).toBe("fallback");
    expect(out[BY_ID]).toBeUndefined();
    expect(instanceReads()).toBe(1); // instance layer stays memoized
    db.run(
      `INSERT INTO memberships(workspaceId,userId,role,createdAt) VALUES('w','u','owner','n')`,
    );
    expect((await getEffectivePreferences(session)).comboStrategy).toBe("round-robin");
  });

  it("non-minted (forged/plain) ctx reads live every call", async () => {
    const forged = Object.freeze({ ...FIELDS });
    await getEffectivePreferences(forged);
    await getEffectivePreferences(forged);
    expect(instanceReads()).toBe(2);
  });

  // Not reachable today: pickKeys(USER_KEYS) drops "__proto__" before the merge, and
  // assignOwnData (unit-tested in gateway-hot-path-memo) is the second line of defense.
  it("a stored own __proto__ key in user preferences is dropped end to end", async () => {
    db.run(`INSERT OR REPLACE INTO userPreferences(userId,data,updatedAt) VALUES('u',?,'n')`, [
      '{"__proto__":{"polluted":true},"startPage":"/mine"}',
    ]);
    const eff = await getEffectivePreferences(mint());
    expect(Object.getPrototypeOf(eff)).toBe(Object.prototype);
    expect(eff.polluted).toBeUndefined();
    expect(Object.hasOwn(eff, "__proto__")).toBe(false);
    expect(eff.startPage).toBe("/mine");
    expect({}.polluted).toBeUndefined();
  });

  it("keeps the non-enumerable comboStrategiesById symbol and id-keyed lookup", async () => {
    const principal = mint();
    for (let i = 0; i < 2; i++) {
      const eff = await getEffectivePreferences(principal);
      expect(Object.getOwnPropertyDescriptor(eff, BY_ID)).toEqual({
        value: true,
        enumerable: false,
        writable: false,
        configurable: false,
      });
      expect(Object.getOwnPropertySymbols({ ...eff })).toEqual([]);
      expect(comboStrategyFor(eff, principal, { id: "cid", name: "n" }).strategy).toBe("weighted");
    }
    setWs({});
    const empty = await getEffectivePreferences(mint());
    expect(empty.comboStrategies).toEqual({});
    expect(empty[BY_ID]).toBe(true);
  });
});

describe("encrypted settings secrets under a request scope", () => {
  it("decodes the Default secret and shares one root load with connection/node decrypts", async () => {
    await activate();
    expect(db.get(`SELECT data FROM settings WHERE id = 1`).data).not.toContain("oidc-secret");
    const principal = mint();
    loadMasterKey.mockClear();
    const eff = await getEffectivePreferences(principal);
    expect(eff.oidcClientSecret).toBe("oidc-secret");
    expect((await getGatewayConnections(principal))[0].apiKey).toBe("connection-secret");
    expect((await getGatewayNodes(principal))[0].apiKey).toBe("node-secret");
    expect((await getEffectivePreferences(principal)).oidcClientSecret).toBe("oidc-secret");
    expect(loadMasterKey).toHaveBeenCalledOnce();
  });

  it("empty secrets need no root", async () => {
    await activate();
    setSettings({ requireApiKey: true, oidcClientSecret: "", samlCert: "" });
    loadMasterKey.mockClear();
    const principal = mint();
    expect((await getEffectivePreferences(principal)).requireApiKey).toBe(true);
    expect(loadMasterKey).not.toHaveBeenCalled();
  });

  it("keeps strict encryption-state validation", async () => {
    await activate();
    setSettings({ requireApiKey: true });
    db.run(`INSERT OR REPLACE INTO _meta(key,value) VALUES('credentialsCleanupPending','bad')`);
    await expect(getEffectivePreferences(mint())).rejects.toMatchObject({
      code: "CREDENTIAL_STATE_INVALID",
    });
  });

  it("corrupt envelope fails typed, is not cached, and never falls back to plaintext", async () => {
    await activate();
    const blob = JSON.parse(db.get(`SELECT data FROM settings WHERE id = 1`).data);
    const ct = blob.oidcClientSecret.ct;
    blob.oidcClientSecret.ct = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
    setSettings(blob);
    const principal = mint();
    const base = instanceReads();
    for (let i = 0; i < 2; i++) {
      const err = await getEffectivePreferences(principal).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(typeof err.code).toBe("string");
      expect(err.code).not.toBe("KEY_MISMATCH");
    }
    expect(instanceReads() - base).toBe(2); // failed load retried, never cached
  });

  it("dead scope propagates KEY_MISMATCH and never falls back to live state", async () => {
    await activate();
    const principal = mint();
    await rotateKek(db, { root, newRoot: nextRoot, fileManaged: false });
    loadMasterKey.mockResolvedValue(nextRoot);
    loadMasterKey.mockClear();
    for (let i = 0; i < 2; i++) {
      await expect(getEffectivePreferences(principal)).rejects.toMatchObject({
        code: "KEY_MISMATCH",
      });
    }
    expect(loadMasterKey).not.toHaveBeenCalled();
    const fresh = await getEffectivePreferences(mint());
    expect(fresh.oidcClientSecret).toBe("oidc-secret");
  });
});

describe("warm memo revalidation (poison + markers on every access)", () => {
  const poisonCode = { code: "CREDENTIAL_MAINTENANCE_POISONED" };

  it("warm prefs then rotate: repeated calls KEY_MISMATCH, fresh principal succeeds", async () => {
    await activate();
    const principal = mint();
    expect((await getEffectivePreferences(principal)).oidcClientSecret).toBe("oidc-secret");
    await rotateKek(db, { root, newRoot: nextRoot, fileManaged: false });
    loadMasterKey.mockResolvedValue(nextRoot);
    for (let i = 0; i < 3; i++) {
      await expect(getEffectivePreferences(principal)).rejects.toMatchObject({
        code: "KEY_MISMATCH",
      });
      await expect(getEffectivePreferences(principal)).rejects.toMatchObject({
        code: "KEY_MISMATCH",
      });
      expect(() => requestScopeOf(principal, db)).toThrow(/retry/); // sticky dead handle lookup
    }
    const fresh = await getEffectivePreferences(mint());
    expect(fresh.oidcClientSecret).toBe("oidc-secret");
  });

  it("warm prefs then poison rejects every access", async () => {
    await activate();
    const principal = mint();
    await getEffectivePreferences(principal);
    poisonCredentialMaintenance(db, new Error("uncertain publication"));
    for (let i = 0; i < 2; i++) {
      await expect(getEffectivePreferences(principal)).rejects.toMatchObject(poisonCode);
    }
  });

  it("rotation during async loader rejects and the slot is never trusted", async () => {
    await activate();
    const principal = mint();
    const handle = requestScopeOf(principal, db);
    let calls = 0;
    const rotating = () =>
      handle.memo("k", async () => {
        calls++;
        await rotateKek(db, { root, newRoot: nextRoot, fileManaged: false });
        return "stale";
      });
    await expect(rotating()).rejects.toMatchObject({ code: "KEY_MISMATCH" });
    expect(() => requestScopeOf(principal, db)).toThrow(/retry/); // sticky dead
    await expect(handle.memo("k", async () => "fresh")).rejects.toMatchObject({
      code: "KEY_MISMATCH",
    });
    expect(calls).toBe(1);
  });

  it("poison during async loader rejects and a concurrent waiter does not get the value", async () => {
    await activate();
    const principal = mint();
    const handle = requestScopeOf(principal, db);
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const first = handle.memo("k", async () => {
      await gate;
      return "stale";
    });
    const waiter = handle.memo("k", async () => "never");
    poisonCredentialMaintenance(db, new Error("uncertain publication"));
    release();
    await expect(first).rejects.toMatchObject(poisonCode);
    await expect(waiter).rejects.toMatchObject(poisonCode);
    await expect(handle.memo("k", async () => "again")).rejects.toMatchObject(poisonCode);
  });

  it("warm memo hit after rotation is refused without calling the loader again", async () => {
    await activate();
    const principal = mint();
    const handle = requestScopeOf(principal, db);
    const loader = vi.fn(async () => "v");
    expect(await handle.memo("k", loader)).toBe("v");
    await rotateKek(db, { root, newRoot: nextRoot, fileManaged: false });
    await expect(handle.memo("k", loader)).rejects.toMatchObject({ code: "KEY_MISMATCH" });
    await expect(handle.memo("other", loader)).rejects.toMatchObject({ code: "KEY_MISMATCH" });
    expect(loader).toHaveBeenCalledOnce();
  });
});
