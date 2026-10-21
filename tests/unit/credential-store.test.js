// YAN-1037/1038: src-side credential store + repo clear rule, real SQLite.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let store;
let storeMod;
let reauth;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-credstore-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  const installer = await import("../../src/sse/services/credentialStore.js");
  storeMod = await import("../../open-sse/services/credentialStore.js");
  reauth = await import("../../open-sse/services/reauthState.js");
  installer.installCredentialStore();
  store = storeMod.getCredentialStore();
});

afterEach(() => {
  // globalThis slots survive vi.resetModules(); re-install for the next case.
});

afterAll(() => {
  storeMod?.setCredentialStore(null);
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

let seq = 0;
const mk = (extra = {}) => {
  seq += 1;
  return db.createProviderConnectionUnscoped({
    provider: "codex",
    authType: "oauth",
    name: `cs-${seq}`,
    email: `cs${seq}@example.com`,
    accessToken: "at-1",
    refreshToken: "rt-1",
    providerSpecificData: { chatgptAccountId: `acct-${seq}`, keep: "sibling" },
    ...extra,
  });
};
const flag = (code = "refresh_token_reused") =>
  reauth.buildReauthRequired({ reason: "refresh_token_rejected", code });
const get = (id) => db.getProviderConnectionByIdUnscoped(id);

describe("installCredentialStore", () => {
  it("installs a store with load / persistRefresh / markReauthRequired", () => {
    expect(store).toBeTruthy();
    for (const fn of ["load", "persistRefresh", "markReauthRequired"]) {
      expect(typeof store[fn]).toBe("function");
    }
  });

  it("L4: load exposes only the lifetime-cap providerSpecificData keys", async () => {
    const conn = await mk({
      providerSpecificData: {
        chatgptAccountId: "acct-l4",
        proxyUrl: "http://secret-proxy",
        observedLifetimeMs: 1000,
        observedLifetimeAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const loaded = await store.load(conn.id);
    expect(loaded.providerSpecificData).toEqual({
      observedLifetimeMs: 1000,
      observedLifetimeAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("load returns the stored tokens, flag and active state", async () => {
    const conn = await mk();
    const loaded = await store.load(conn.id);
    expect(loaded).toMatchObject({
      accessToken: "at-1",
      refreshToken: "rt-1",
      reauthRequired: null,
      isActive: true,
    });
    expect(await store.load("missing")).toBeNull();
  });
});

describe("persistRefresh", () => {
  it("applies on a matching RT, rotates it and keeps providerSpecificData siblings", async () => {
    const conn = await mk();
    const r = await store.persistRefresh(conn.id, {
      expectedRefreshToken: "rt-1",
      credentials: {
        accessToken: "at-2",
        refreshToken: "rt-2",
        providerSpecificData: { evil: "ignored" },
      },
    });
    expect(r).toEqual({ applied: true });
    const after = await get(conn.id);
    expect(after).toMatchObject({ accessToken: "at-2", refreshToken: "rt-2" });
    expect(after.providerSpecificData.keep).toBe("sibling");
    expect(after.providerSpecificData.evil).toBeUndefined();
  });

  it("is not applied when the live RT changed in the meantime", async () => {
    const conn = await mk();
    await db.updateProviderConnectionUnscoped(conn.id, {
      accessToken: "at-fresh",
      refreshToken: "rt-fresh",
    });
    const r = await store.persistRefresh(conn.id, {
      expectedRefreshToken: "rt-1",
      credentials: { accessToken: "at-stale", refreshToken: "rt-stale" },
    });
    expect(r).toEqual({ applied: false });
    expect(await get(conn.id)).toMatchObject({ accessToken: "at-fresh", refreshToken: "rt-fresh" });
  });
});

describe("markReauthRequired", () => {
  it("applies only when the RT matches, sets the exact lastError, and is idempotent", async () => {
    const conn = await mk();
    const wrong = await store.markReauthRequired(conn.id, {
      expectedRefreshToken: "rt-other",
      reauthRequired: flag(),
    });
    expect(wrong).toEqual({ applied: false });
    expect((await get(conn.id)).reauthRequired ?? null).toBeNull();

    const ok = await store.markReauthRequired(conn.id, {
      expectedRefreshToken: "rt-1",
      reauthRequired: flag(),
    });
    expect(ok).toEqual({ applied: true });
    const after = await get(conn.id);
    expect(after.reauthRequired).toMatchObject({
      reason: "refresh_token_rejected",
      code: "refresh_token_reused",
    });
    expect(after).toMatchObject({
      testStatus: "error",
      lastError: "Token expired and refresh failed",
      lastErrorType: "token_refresh_failed",
    });

    const again = await store.markReauthRequired(conn.id, {
      expectedRefreshToken: "rt-1",
      reauthRequired: flag(),
    });
    expect(again).toEqual({ applied: false });
  });
});

describe("clearing the flag (D9)", () => {
  async function flagged() {
    const conn = await mk();
    await store.markReauthRequired(conn.id, {
      expectedRefreshToken: "rt-1",
      reauthRequired: flag(),
    });
    return conn;
  }

  it("keeps the flag on a bare testStatus:'active' patch", async () => {
    const conn = await flagged();
    await db.updateProviderConnectionUnscoped(conn.id, { testStatus: "active" });
    const after = await get(conn.id);
    expect(after.reauthRequired).toMatchObject({ reason: "refresh_token_rejected" });
  });

  it("M3: a passing Test / successful request cannot turn a flagged row active", async () => {
    const conn = await flagged();
    await db.updateProviderConnectionUnscoped(conn.id, {
      testStatus: "active",
      lastError: null,
      lastErrorAt: null,
      lastErrorType: null,
      errorCode: null,
    });
    const after = await get(conn.id);
    expect(after).toMatchObject({
      testStatus: "error",
      lastError: "Token expired and refresh failed",
      lastErrorType: "token_refresh_failed",
      errorCode: 401,
    });
    expect(after.reauthRequired).toBeTruthy();
  });

  it("M3: unrelated fields in the same patch still apply", async () => {
    const conn = await flagged();
    await db.updateProviderConnectionUnscoped(conn.id, { testStatus: "active", defaultModel: "m" });
    const after = await get(conn.id);
    expect(after.defaultModel).toBe("m");
    expect(after.testStatus).toBe("error");
  });

  it("keeps the flag when the patch re-sends the same tokens", async () => {
    const conn = await flagged();
    await db.updateProviderConnectionUnscoped(conn.id, {
      accessToken: "at-1",
      refreshToken: "rt-1",
      testStatus: "active",
    });
    expect((await get(conn.id)).reauthRequired).toBeTruthy();
  });

  it("clears on a re-login upsert with a new RT (same account) and goes active", async () => {
    const conn = await flagged();
    const live = await get(conn.id);
    await db.createProviderConnectionUnscoped({
      provider: "codex",
      authType: "oauth",
      email: live.email,
      accessToken: "at-new",
      refreshToken: "rt-new",
      testStatus: "active",
      providerSpecificData: { chatgptAccountId: live.providerSpecificData.chatgptAccountId },
    });
    const after = await get(conn.id);
    expect(after.refreshToken).toBe("rt-new");
    expect(after.reauthRequired ?? null).toBeNull();
    expect(after).toMatchObject({ testStatus: "active" });
    expect(after.lastError ?? null).toBeNull();
    expect(after.lastErrorType ?? null).toBeNull();
    expect(after.errorCode ?? null).toBeNull();
  });

  it("clears on a refresh persist with a new RT", async () => {
    const conn = await flagged();
    await db.updateProviderConnectionUnscoped(conn.id, {
      accessToken: "at-2",
      refreshToken: "rt-2",
    });
    const after = await get(conn.id);
    expect(after.reauthRequired ?? null).toBeNull();
    expect(after.testStatus).toBe("active");
    expect(after.lastError ?? null).toBeNull();
  });
});

describe("mutateBillingLockUnscoped", () => {
  it("keeps its return shape", async () => {
    const conn = await mk();
    const r = await db.mutateBillingLockUnscoped(conn.id, () => ({ billingLock: null }));
    expect(r).toMatchObject({ applied: true, missing: false, billingLock: null });
  });
});
