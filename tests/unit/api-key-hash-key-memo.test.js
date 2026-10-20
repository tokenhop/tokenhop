// YAN-1106: the unwrapped API-key hash key is memoized per (credential markers,
// hash kid, default workspace, root kid) and must never outlive a marker change,
// a root change, its TTL, or a poisoned adapter. Shares the encrypted single-key
// fixture with request-credential-scope.test.js.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rotateKek } from "@/lib/security/keyRotation.js";
import { poisonCredentialMaintenance } from "@/lib/db/credentialMaintenance.js";
import { resolveGatewayAuth } from "@/lib/auth/gatewayAuth.js";
import { getGatewayConnections } from "@/lib/auth/gatewayResources.js";
import { getApiKeyHashKey } from "@/lib/security/apiKeyHashKey.js";
import { nextRoot, request, root, seedScopeDb } from "../helpers/scopeFixture.js";

vi.mock("@/lib/db/driver.js", () => ({ getAdapter: vi.fn() }));
vi.mock("@/lib/auth/cliTokenPolicy.js", () => ({ cliTokenAcceptedWith: vi.fn() }));
vi.mock("@/lib/security/masterKey.js", async (original) => ({
  ...(await original()),
  loadMasterKey: vi.fn(),
}));
import { getAdapter } from "@/lib/db/driver.js";
import { cliTokenAcceptedWith } from "@/lib/auth/cliTokenPolicy.js";
import { loadMasterKey } from "@/lib/security/masterKey.js";

let db;
beforeEach(async () => {
  db = await seedScopeDb({ getAdapter, loadMasterKey, cliTokenAcceptedWith });
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

const rotate = () => rotateKek(db, { root, newRoot: nextRoot, fileManaged: false });

describe("hash key memo", () => {
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
