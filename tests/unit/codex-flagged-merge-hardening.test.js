// YAN-1287 review follow-ups: flagged-replacement merge hygiene and ownership.
// Repo-level, real SQLite, same harness as credential-store.test.js.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let reauth;
let adapter;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-flagged-merge-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  reauth = await import("../../open-sse/services/reauthState.js");
  adapter = (await import("../../src/lib/db/driver.js")).getAdapterSync();
}, 60000);

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const flag = () =>
  reauth.buildReauthRequired({ reason: "refresh_token_rejected", code: "refresh_token_reused" });

const flagRow = async (id) => {
  await db.updateProviderConnectionUnscoped(id, {
    reauthRequired: flag(),
    testStatus: "error",
    lastError: "Token expired and refresh failed",
  });
};

const rowsFor = (email) =>
  db
    .getProviderConnectionsUnscoped({ provider: "codex" })
    .then((all) => all.filter((c) => c.email === email));

async function freshOauthFlagged(email, accountId = null) {
  const conn = await db.createProviderConnectionUnscoped({
    provider: "codex",
    authType: "oauth",
    name: `row-${email}`,
    email,
    accessToken: "at-1",
    refreshToken: "rt-1",
    providerSpecificData: accountId ? { chatgptAccountId: accountId } : {},
  });
  await flagRow(conn.id);
  return conn;
}

describe("F1: flagged access_token merge recomputes expiresAt from the new token", () => {
  it("re-import without expiresAt no longer looks expired (needsReauthentication false)", async () => {
    const first = await db.createProviderConnectionUnscoped({
      provider: "codex",
      authType: "access_token",
      name: "f1-import",
      email: "f1@example.com",
      accessToken: "expired-old-token",
      expiresAt: new Date(Date.now() - 3600_000).toISOString(),
      providerSpecificData: { authMethod: "access_token", chatgptAccountId: "acct-f1" },
    });
    await flagRow(first.id);

    // Re-import with a live JWT but NO explicit expiresAt: the merge must derive
    // it from the token, not keep the dead row's past expiry.
    const payload = { exp: Math.floor((Date.now() + 3600_000) / 1000) };
    const liveJwt = `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
    await db.createProviderConnectionUnscoped({
      provider: "codex",
      authType: "access_token",
      email: "f1@example.com",
      accessToken: liveJwt,
      testStatus: "active",
      providerSpecificData: { authMethod: "access_token", chatgptAccountId: "acct-f1" },
    });

    const row = (await rowsFor("f1@example.com"))[0];
    expect(row.id).toBe(first.id);
    expect(row.reauthRequired ?? null).toBeNull();
    expect(Date.parse(row.expiresAt)).toBeGreaterThan(Date.now());
    expect(row.tokenExpiresAt ?? null).toBeNull();
    expect(reauth.needsReauthentication("codex", row)).toBe(false);
  });
});

describe("F2: flagged-replacement respects the creator (security)", () => {
  it("user B's import of the same account does not replace user A's flagged row", async () => {
    // A real shared workspace with two members. A owns a flagged access_token
    // row; B re-imports the same ChatGPT account. The primary identity match
    // never dedups access_token rows, so only the flagged fallback could merge
    // — and it must not cross creators.
    const now = new Date().toISOString();
    for (const u of ["user-a", "user-b"]) {
      adapter.run(
        `INSERT INTO users(id, instanceRole, status, createdAt, updatedAt) VALUES (?,'user','active',?,?)`,
        [u, now, now],
      );
    }
    const wsId = "ws-f2";
    adapter.run(
      `INSERT INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES (?, 'f2', 'shared', ?, ?)`,
      [wsId, now, now],
    );
    for (const u of ["user-a", "user-b"]) {
      adapter.run(
        `INSERT INTO memberships(workspaceId,userId,role,createdAt) VALUES (?,?,'owner',?)`,
        [wsId, u, now],
      );
    }
    const ctxA = { userId: "user-a", workspaceIds: [wsId], role: "owner" };
    const ctxB = { userId: "user-b", workspaceIds: [wsId], role: "owner" };
    const token = (n) =>
      `h.${Buffer.from(JSON.stringify({ exp: Math.floor((Date.now() + n * 3600_000) / 1000) })).toString("base64url")}.s`;

    const a = await db.createConnection(ctxA, wsId, {
      provider: "codex",
      authType: "access_token",
      name: "a-import",
      email: "f2@example.com",
      accessToken: token(1),
      providerSpecificData: { authMethod: "access_token", chatgptAccountId: "acct-f2" },
    });
    await flagRow(a.id);

    // B re-imports the same account id and email.
    await db.createConnection(ctxB, wsId, {
      provider: "codex",
      authType: "access_token",
      name: "b-import",
      email: "f2@example.com",
      accessToken: token(2),
      testStatus: "active",
      providerSpecificData: { authMethod: "access_token", chatgptAccountId: "acct-f2" },
    });

    // A's row is untouched: still flagged, still the old token.
    const aAfter = await db.getProviderConnectionByIdUnscoped(a.id);
    expect(aAfter.reauthRequired).toMatchObject({ reason: "refresh_token_rejected" });
    expect(aAfter.accessToken).toBe(token(1));
    // B's import landed as its own live row.
    const bRows = (await db.getProviderConnectionsUnscoped({ provider: "codex" })).filter(
      (r) => r.workspaceId === wsId && r.id !== a.id,
    );
    expect(bRows).toHaveLength(1);
    expect(bRows[0].createdByUserId).toBe("user-b");
    expect(bRows[0].accessToken).toBe(token(2));
    expect(bRows[0].reauthRequired ?? null).toBeNull();
  });
});

describe("flagged merge keeps the existing name and email", () => {
  it("a reconnect without a name does not rename the row or touch its email", async () => {
    const first = await freshOauthFlagged("f4@example.com", "acct-f4");

    // Reconnect with new tokens, same email, no name.
    await db.createProviderConnectionUnscoped({
      provider: "codex",
      authType: "oauth",
      email: "f4@example.com",
      accessToken: "at-2",
      refreshToken: "rt-2",
      testStatus: "active",
      providerSpecificData: { chatgptAccountId: "acct-f4" },
    });

    const row = (await rowsFor("f4@example.com"))[0];
    expect(row.id).toBe(first.id);
    expect(row.name).toBe("row-f4@example.com");
    expect(row.email).toBe("f4@example.com");
    expect(row.reauthRequired ?? null).toBeNull();
  });
});

describe("expired but unflagged access_token rows are replaced by a re-import", () => {
  const jwt = (expOffsetMs) =>
    `h.${Buffer.from(JSON.stringify({ exp: Math.floor((Date.now() + expOffsetMs) / 1000) })).toString("base64url")}.s`;

  it("an expired unflagged row + re-import of the same account → one live row", async () => {
    const first = await db.createProviderConnectionUnscoped({
      provider: "codex",
      authType: "access_token",
      name: "stale",
      email: "exp@example.com",
      accessToken: jwt(-3600_000),
      providerSpecificData: { authMethod: "access_token", chatgptAccountId: "acct-exp" },
    });
    expect(first.reauthRequired ?? null).toBeNull();

    await db.createProviderConnectionUnscoped({
      provider: "codex",
      authType: "access_token",
      email: "exp@example.com",
      accessToken: jwt(3600_000),
      testStatus: "active",
      providerSpecificData: { authMethod: "access_token", chatgptAccountId: "acct-exp" },
    });

    const rows = await rowsFor("exp@example.com");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
    expect(reauth.needsReauthentication("codex", rows[0])).toBe(false);
  });

  it("a still-valid unflagged row is NOT replaced (two imports stay two rows)", async () => {
    await db.createProviderConnectionUnscoped({
      provider: "codex",
      authType: "access_token",
      name: "live-1",
      email: "live@example.com",
      accessToken: jwt(3600_000),
      providerSpecificData: { authMethod: "access_token", chatgptAccountId: "acct-live" },
    });
    await db.createProviderConnectionUnscoped({
      provider: "codex",
      authType: "access_token",
      email: "live@example.com",
      accessToken: jwt(7200_000),
      providerSpecificData: { authMethod: "access_token", chatgptAccountId: "acct-live" },
    });
    expect(await rowsFor("live@example.com")).toHaveLength(2);
  });
});

describe("default names for new access_token rows", () => {
  it("falls back to the email, then to 'ChatGPT Access token' when the caller gives no name", async () => {
    const withEmail = await db.createProviderConnectionUnscoped({
      provider: "codex",
      authType: "access_token",
      email: "name1@example.com",
      accessToken: "opaque-1",
      providerSpecificData: { authMethod: "access_token", chatgptAccountId: "acct-n1" },
    });
    expect(withEmail.name).toBe("name1@example.com");

    const noEmail = await db.createProviderConnectionUnscoped({
      provider: "codex",
      authType: "access_token",
      accessToken: "opaque-2",
      providerSpecificData: { authMethod: "access_token", chatgptAccountId: "acct-n2" },
    });
    expect(noEmail.name).toBe("ChatGPT Access token");
  });
});
