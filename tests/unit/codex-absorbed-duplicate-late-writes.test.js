// YAN-1941: a request still in flight on a flagged codex duplicate that a
// reconnect absorbed (YAN-1623) writes its usage and request details after the
// absorb. Those late writes must land on the kept connection id, not the
// deleted one. Repo-level, real SQLite.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const originalRequestLogs = process.env.ENABLE_REQUEST_LOGS;
let tempDir;
let db;
let reauth;
let adapter;
let absorbed;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-absorbed-late-"));
  process.env.DATA_DIR = tempDir;
  process.env.ENABLE_REQUEST_LOGS = "true";
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  reauth = await import("../../open-sse/services/reauthState.js");
  adapter = (await import("../../src/lib/db/driver.js")).getAdapterSync();
  absorbed = await import("../../src/lib/db/helpers/absorbedConnections.js");
}, 60000);

afterAll(() => {
  absorbed?.clearAbsorbedConnections();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalRequestLogs === undefined) delete process.env.ENABLE_REQUEST_LOGS;
  else process.env.ENABLE_REQUEST_LOGS = originalRequestLogs;
});

const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const oauth = (email, accountId, extra = {}) => ({
  provider: "codex",
  authType: "oauth",
  email,
  accessToken: `at-${email}-${accountId ?? "legacy"}`,
  refreshToken: `rt-${email}-${accountId ?? "legacy"}`,
  providerSpecificData: accountId ? { chatgptAccountId: accountId } : {},
  ...extra,
});
const legacyRow = (email, accountId) =>
  oauth(email, null, {
    idToken: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  });
const flagRow = (id) =>
  db.updateProviderConnectionUnscoped(id, {
    reauthRequired: reauth.buildReauthRequired({
      reason: "refresh_token_rejected",
      code: "refresh_token_reused",
    }),
    testStatus: "error",
  });

async function absorbScenario(email, accountId) {
  const live = await db.createProviderConnectionUnscoped(oauth(email, accountId));
  const legacy = await db.createProviderConnectionUnscoped(legacyRow(email, accountId));
  await flagRow(legacy.id);
  await db.createProviderConnectionUnscoped({
    ...oauth(email, accountId),
    accessToken: `at-fresh-${email}`,
    refreshToken: `rt-fresh-${email}`,
    testStatus: "active",
  });
  expect(await db.getProviderConnectionByIdUnscoped(legacy.id)).toBeNull();
  return { K: live.id, L: legacy.id };
}

const flushDetails = () => globalThis.__requestDetailsFlushSync?.();

describe("YAN-1941: late writes for an absorbed codex duplicate", () => {
  it("usage saved after the absorb lands on the kept connection id", async () => {
    const { K, L } = await absorbScenario("late-usage@example.com", "acct-late-u");

    await db.saveRequestUsageUnscoped({
      provider: "codex",
      model: "gpt-5",
      connectionId: L,
      endpoint: "chat",
      tokens: { prompt_tokens: 7, completion_tokens: 3 },
      cost: 0,
    });

    const count = (sql, id) => adapter.get(sql, [id]).n;
    const hist = `SELECT COUNT(*) AS n FROM usageHistory WHERE connectionId = ?`;
    const roll = `SELECT COUNT(*) AS n FROM usageRollup WHERE connectionId = ?`;
    expect(count(hist, L)).toBe(0);
    expect(count(roll, L)).toBe(0);
    expect(count(hist, K)).toBe(1);
    expect(count(roll, K)).toBe(1);
  });

  it("request details buffered for the removed row flush onto the kept row", async () => {
    const { K, L } = await absorbScenario("late-details@example.com", "acct-late-d");

    await db.saveRequestDetailUnscoped({
      id: "rd-late",
      provider: "codex",
      model: "gpt-5",
      connectionId: L,
      status: "ok",
    });
    flushDetails();

    const row = adapter.get(`SELECT connectionId, data FROM requestDetails WHERE id = 'rd-late'`);
    expect(row.connectionId).toBe(K);
    expect(JSON.parse(row.data).connectionId).toBe(K);
  });

  it("scoped createConnection absorb also redirects late usage", async () => {
    const userId = "late-scoped-user";
    const wsId = "late-scoped-ws";
    const now = new Date().toISOString();
    adapter.run(
      `INSERT INTO users(id, instanceRole, status, createdAt, updatedAt) VALUES (?,'user','active',?,?)`,
      [userId, now, now],
    );
    adapter.run(
      `INSERT INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES (?, ?, 'shared', ?, ?)`,
      [wsId, wsId, now, now],
    );
    adapter.run(
      `INSERT INTO memberships(workspaceId,userId,role,createdAt) VALUES (?,?,'owner',?)`,
      [wsId, userId, now],
    );
    const ctx = { userId, workspaceIds: [wsId], role: "owner" };
    const email = "late-scoped@example.com";
    const live = await db.createConnection(ctx, wsId, oauth(email, "acct-late-s"));
    const legacy = await db.createConnection(ctx, wsId, legacyRow(email, "acct-late-s"));
    await flagRow(legacy.id);
    await db.createConnection(ctx, wsId, {
      ...oauth(email, "acct-late-s"),
      accessToken: "at-fresh-scoped",
      refreshToken: "rt-fresh-scoped",
    });
    expect(await db.getProviderConnectionByIdUnscoped(legacy.id)).toBeNull();

    await db.saveRequestUsageUnscoped({
      provider: "codex",
      model: "gpt-5",
      connectionId: legacy.id,
      endpoint: "chat",
      tokens: { prompt_tokens: 1 },
      cost: 0,
    });
    const ids = adapter
      .all(`SELECT connectionId FROM usageHistory WHERE connectionId IN (?, ?)`, [
        live.id,
        legacy.id,
      ])
      .map((r) => r.connectionId);
    expect(ids).toEqual([live.id]);
  });

  it("a video job recorded for the removed row is stored on the kept row", async () => {
    const { K, L } = await absorbScenario("late-video@example.com", "acct-late-v");
    const videoJobs = await import("../../src/lib/db/repos/gatewayVideoJobsRepo.js");
    const wsId = "late-video-ws";
    const now = new Date().toISOString();
    adapter.run(
      `INSERT INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES (?, ?, 'shared', ?, ?)`,
      [wsId, wsId, now, now],
    );
    videoJobs.initGatewayVideoJobsSync(adapter);
    videoJobs.recordGatewayVideoJobSync(adapter, {
      workspaceId: wsId,
      jobId: "job-late",
      provider: "codex",
      connectionId: L,
      modelId: "codex/sora",
    });
    const row = adapter.get(`SELECT connectionId FROM gatewayVideoJobs WHERE jobId = 'job-late'`);
    expect(row.connectionId).toBe(K);
  });

  it("an unrelated connection id passes through unchanged", () => {
    expect(absorbed.resolveAbsorbedConnectionId("never-absorbed")).toBe("never-absorbed");
    expect(absorbed.resolveAbsorbedConnectionId(null)).toBeNull();
  });

  it("follows a chain and drops an expired mapping", () => {
    const now = 1_000_000;
    absorbed.recordAbsorbedConnection("a", "b", now);
    absorbed.recordAbsorbedConnection("b", "c", now);
    expect(absorbed.resolveAbsorbedConnectionId("a", now + 1)).toBe("c");
    expect(absorbed.resolveAbsorbedConnectionId("a", now + absorbed.ABSORBED_TTL_MS)).toBe("a");
  });
});
