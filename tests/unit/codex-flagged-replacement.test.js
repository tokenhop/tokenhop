// YAN-1287: after a reconnect / re-import of the same account, no stale
// flagged row remains. Repo-level, real SQLite.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let reauth;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-flagged-replace-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  reauth = await import("../../open-sse/services/reauthState.js");
});

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

describe("YAN-1287: a flagged row is replaced by a fresh grant of the same account", () => {
  it("legacy flagged oauth row without chatgptAccountId + same-email reconnect → one row, unflagged, new tokens", async () => {
    const first = await db.createProviderConnectionUnscoped({
      provider: "codex",
      authType: "oauth",
      name: "legacy",
      email: "dev@example.com",
      accessToken: "at-1",
      refreshToken: "rt-1",
      providerSpecificData: {},
    });
    await flagRow(first.id);

    await db.createProviderConnectionUnscoped({
      provider: "codex",
      authType: "oauth",
      email: "dev@example.com",
      accessToken: "at-2",
      refreshToken: "rt-2",
      testStatus: "active",
      providerSpecificData: { chatgptAccountId: "acct-1" },
    });

    const rows = await rowsFor("dev@example.com");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe(first.id);
    expect(row.refreshToken).toBe("rt-2");
    expect(row.accessToken).toBe("at-2");
    expect(row.reauthRequired ?? null).toBeNull();
    expect(row.testStatus).toBe("active");
  });

  it("flagged access_token row + re-import with the same chatgptAccountId → one row, unflagged, fresh expiry", async () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const future = new Date(Date.now() + 3600_000).toISOString();
    const first = await db.createProviderConnectionUnscoped({
      provider: "codex",
      authType: "access_token",
      name: "imported",
      email: "dev3@example.com",
      accessToken: "old-token",
      expiresAt: past,
      providerSpecificData: { authMethod: "access_token", chatgptAccountId: "acct-9", jwtExp: 1 },
    });
    await flagRow(first.id);

    await db.createProviderConnectionUnscoped({
      provider: "codex",
      authType: "access_token",
      email: "dev3@example.com",
      accessToken: "new-token",
      expiresAt: future,
      testStatus: "active",
      providerSpecificData: { authMethod: "access_token", chatgptAccountId: "acct-9", jwtExp: 2 },
    });

    const rows = await rowsFor("dev3@example.com");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe(first.id);
    expect(row.accessToken).toBe("new-token");
    expect(row.reauthRequired ?? null).toBeNull();
    expect(row.expiresAt).toBe(future);
    expect(row.providerSpecificData.jwtExp).toBe(2);
    expect(row.providerSpecificData.chatgptAccountId).toBe("acct-9");
  });

  it("unflagged legacy row + same-email reconnect still creates a second row (YAN-1053)", async () => {
    await db.createProviderConnectionUnscoped({
      provider: "codex",
      authType: "oauth",
      name: "healthy",
      email: "dev2@example.com",
      accessToken: "at-1",
      refreshToken: "rt-1",
      providerSpecificData: {},
    });
    await db.createProviderConnectionUnscoped({
      provider: "codex",
      authType: "oauth",
      email: "dev2@example.com",
      accessToken: "at-2",
      refreshToken: "rt-2",
      testStatus: "active",
      providerSpecificData: { chatgptAccountId: "acct-2" },
    });

    expect(await rowsFor("dev2@example.com")).toHaveLength(2);
  });

  it("flagged row with a different email is not replaced", async () => {
    const first = await db.createProviderConnectionUnscoped({
      provider: "codex",
      authType: "oauth",
      name: "other-account",
      email: "a@example.com",
      accessToken: "at-1",
      refreshToken: "rt-1",
      providerSpecificData: {},
    });
    await flagRow(first.id);

    await db.createProviderConnectionUnscoped({
      provider: "codex",
      authType: "oauth",
      email: "b@example.com",
      accessToken: "at-2",
      refreshToken: "rt-2",
      testStatus: "active",
      providerSpecificData: {},
    });

    expect(await rowsFor("a@example.com")).toHaveLength(1);
    const rows = await rowsFor("b@example.com");
    expect(rows).toHaveLength(1);
    const flagged = await db.getProviderConnectionByIdUnscoped(first.id);
    expect(flagged.reauthRequired).toMatchObject({ reason: "refresh_token_rejected" });
  });

  it("merge keeps the existing id, name and priority", async () => {
    const first = await db.createProviderConnectionUnscoped({
      provider: "codex",
      authType: "oauth",
      name: "keep-me",
      email: "keep@example.com",
      accessToken: "at-1",
      refreshToken: "rt-1",
      priority: 1,
      providerSpecificData: {},
    });
    await flagRow(first.id);

    await db.createProviderConnectionUnscoped({
      provider: "codex",
      authType: "oauth",
      email: "keep@example.com",
      accessToken: "at-2",
      refreshToken: "rt-2",
      testStatus: "active",
      providerSpecificData: { chatgptAccountId: "acct-k" },
    });

    const row = (await rowsFor("keep@example.com"))[0];
    expect(row.id).toBe(first.id);
    expect(row.name).toBe("keep-me");
    expect(row.priority).toBe(1);
  });
});
