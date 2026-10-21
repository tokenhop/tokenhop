// YAN-1037/1038 e2e: real SQLite + installed credential store + real
// refreshProviderCredentials + real account selection; only fetch is mocked.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const HOUR = 3600 * 1000;
const fakeJwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
const jwtIn = (ms, tag) => fakeJwt({ exp: Math.floor((Date.now() + ms) / 1000), tag });

// The token endpoint is reached through proxyAwareFetch; stub it with one stable
// mock that each test re-programs. Everything else (SQLite, store, lock, selection) is real.
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

let install;
let tempDir;
let db;
let refreshProviderCredentials;
let storeMod;
let getProviderCredentials;
let selectConnectionsNeedingRefresh;
let needsReauthentication;
let seq = 0;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-refresh-e2e-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  storeMod = await import("../../open-sse/services/credentialStore.js");
  ({ installCredentialStore: install } = await import("../../src/sse/services/credentialStore.js"));
  install();
  ({ refreshProviderCredentials } = await import(
    "../../open-sse/services/oauthCredentialManager.js"
  ));
  ({ getProviderCredentials } = await import("../../src/sse/services/auth.js"));
  ({ selectConnectionsNeedingRefresh } = await import(
    "../../src/sse/services/backgroundTokenRefresh.js"
  ));
  ({ needsReauthentication } = await import("../../open-sse/services/reauthState.js"));
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  storeMod?.setCredentialStore(null);
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function makeConn(rt) {
  seq += 1;
  return db.createProviderConnectionUnscoped({
    provider: "codex",
    authType: "oauth",
    name: `e2e-${seq}`,
    email: `e2e${seq}@example.com`,
    accessToken: jwtIn(-HOUR, `old${seq}`),
    refreshToken: rt,
    expiresAt: new Date(Date.now() - HOUR).toISOString(),
    lastRefreshAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    providerSpecificData: { chatgptAccountId: `acct-e2e-${seq}` },
  });
}
const snapshotOf = (conn) => ({
  connectionId: conn.id,
  accessToken: conn.accessToken,
  refreshToken: conn.refreshToken,
  expiresAt: conn.expiresAt,
  lastRefreshAt: conn.lastRefreshAt,
});
const get = (id) => db.getProviderConnectionByIdUnscoped(id);
const sentRefreshTokens = () =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).refresh_token);

describe("rotating refresh token across requests", () => {
  it("two requests with the same stale snapshot, 11s apart: one token call, rt rotated in the DB", async () => {
    const conn = await makeConn("rt-e2e-a0");
    const newAt = jwtIn(HOUR, "fresh-a");
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: newAt, refresh_token: "rt-e2e-a1", expires_in: 3600 }),
    });

    const first = await refreshProviderCredentials("codex", snapshotOf(conn), null);
    expect(first.accessToken).toBe(newAt);
    // The rotated RT is durable before the first caller even resumes.
    expect((await get(conn.id)).refreshToken).toBe("rt-e2e-a1");

    vi.setSystemTime(Date.now() + 11_000); // past the 10s dedup TTL
    const second = await refreshProviderCredentials("codex", snapshotOf(conn), null);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentRefreshTokens()).toEqual(["rt-e2e-a0"]);
    expect(second.accessToken).toBe(newAt);
    expect(second.error).toBeUndefined();
    const stored = await get(conn.id);
    expect(stored).toMatchObject({ accessToken: newAt, refreshToken: "rt-e2e-a1" });
    expect(stored.reauthRequired ?? null).toBeNull();
  });

  it("concurrent requests with the same snapshot share one token call", async () => {
    const conn = await makeConn("rt-e2e-b0");
    const newAt = jwtIn(HOUR, "fresh-b");
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: newAt, refresh_token: "rt-e2e-b1", expires_in: 3600 }),
    });
    const [a, b] = await Promise.all([
      refreshProviderCredentials("codex", snapshotOf(conn), null),
      refreshProviderCredentials("codex", snapshotOf(conn), null),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.accessToken).toBe(newAt);
    expect(b.accessToken).toBe(newAt);
  });
});

describe("dead refresh token", () => {
  it("one fetch flags the row; later calls make no fetch; selection and the tick skip it", async () => {
    const dead = await makeConn("rt-e2e-dead");
    const healthy = await makeConn("rt-e2e-ok");
    await db.updateProviderConnectionUnscoped(healthy.id, {
      accessToken: jwtIn(HOUR, "ok"),
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
      priority: 2,
    });
    await db.updateProviderConnectionUnscoped(dead.id, { priority: 1 });

    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: "refresh_token_reused" }),
    });

    const first = await refreshProviderCredentials("codex", snapshotOf(dead), null);
    expect(first).toMatchObject({ error: "unrecoverable_refresh_error" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const row = await get(dead.id);
    expect(row.reauthRequired).toMatchObject({
      reason: "refresh_token_rejected",
      code: "refresh_token_reused",
    });
    expect(row).toMatchObject({
      testStatus: "error",
      lastError: "Token expired and refresh failed",
    });

    vi.setSystemTime(Date.now() + 11_000);
    const again = await refreshProviderCredentials("codex", snapshotOf(dead), null);
    expect(again).toMatchObject({ error: "unrecoverable_refresh_error" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(needsReauthentication("codex", row)).toBe(true);
    expect(selectConnectionsNeedingRefresh([row], Date.now())).toEqual([]);
    // The flagged row is never handed out, however many times selection runs.
    for (let i = 0; i < 4; i++) {
      const picked = await getProviderCredentials("codex", null, "gpt-5");
      expect(picked?.connectionId ?? picked?.id).not.toBe(dead.id);
    }
  });

  it("a re-login upsert clears the flag and the next refresh redeems the new token", async () => {
    const conn = await makeConn("rt-e2e-relogin0");
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: "refresh_token_reused" }),
    });
    await refreshProviderCredentials("codex", snapshotOf(conn), null);
    const flagged = await get(conn.id);
    expect(flagged.reauthRequired).toBeTruthy();

    await db.createProviderConnectionUnscoped({
      provider: "codex",
      authType: "oauth",
      email: flagged.email,
      accessToken: jwtIn(-HOUR, "relogin-old"),
      refreshToken: "rt-e2e-relogin1",
      expiresAt: new Date(Date.now() - HOUR).toISOString(),
      testStatus: "active",
      providerSpecificData: { chatgptAccountId: flagged.providerSpecificData.chatgptAccountId },
    });
    const relogged = await get(conn.id);
    expect(relogged.reauthRequired ?? null).toBeNull();
    expect(relogged.refreshToken).toBe("rt-e2e-relogin1");

    fetchMock.mockReset();
    const newAt = jwtIn(HOUR, "fresh-relogin");
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: newAt,
        refresh_token: "rt-e2e-relogin2",
        expires_in: 3600,
      }),
    });
    const result = await refreshProviderCredentials("codex", snapshotOf(relogged), null);
    expect(sentRefreshTokens()).toEqual(["rt-e2e-relogin1"]);
    expect(result.accessToken).toBe(newAt);
    expect((await get(conn.id)).refreshToken).toBe("rt-e2e-relogin2");
  });
});

describe("H1: expired raw-JWT access-token import with no stored expiry", () => {
  it("selection persists the flag and the dashboard health reports reauth_required", async () => {
    seq += 1;
    const row = await db.createProviderConnectionUnscoped({
      provider: "codex",
      authType: "access_token",
      name: `e2e-jwt-${seq}`,
      accessToken: jwtIn(-HOUR, "raw"),
    });
    expect((await get(row.id)).expiresAt ?? null).toBeNull();

    await getProviderCredentials("codex", null, "gpt-5");
    await vi.waitFor(async () => {
      expect((await get(row.id)).reauthRequired).toMatchObject({ reason: "access_token_expired" });
    });
    const after = await get(row.id);
    expect(after).toMatchObject({ testStatus: "error", lastError: "Token expired" });

    const { connectionHealth } = await import("../../src/shared/utils/providerHealth.js");
    expect(connectionHealth(after)).toMatchObject({ status: "err", state: "reauth_required" });
  });

  it("the background tick persists the flag with no network", async () => {
    seq += 1;
    const row = await db.createProviderConnectionUnscoped({
      provider: "codex",
      authType: "access_token",
      name: `e2e-tick-${seq}`,
      accessToken: jwtIn(-HOUR, "tick"),
    });
    const { runBackgroundTokenRefreshTick } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    await runBackgroundTokenRefreshTick({
      loadConnections: async () => [await get(row.id)],
      refreshConnection: vi.fn(),
    });
    expect((await get(row.id)).reauthRequired).toMatchObject({ reason: "access_token_expired" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
