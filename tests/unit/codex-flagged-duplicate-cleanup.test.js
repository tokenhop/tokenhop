// YAN-1623: a codex reconnect that lands on one row also removes every other
// flagged row it could have replaced (pre-YAN-1287 duplicates), moving their
// grants, usage and request details onto the kept row. Repo-level, real SQLite.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let reauth;
let adapter;
let videoJobs;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-flagged-dup-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  reauth = await import("../../open-sse/services/reauthState.js");
  adapter = (await import("../../src/lib/db/driver.js")).getAdapterSync();
  videoJobs = await import("../../src/lib/db/repos/gatewayVideoJobsRepo.js");
}, 60000);

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const flagRow = (id) =>
  db.updateProviderConnectionUnscoped(id, {
    reauthRequired: reauth.buildReauthRequired({
      reason: "refresh_token_rejected",
      code: "refresh_token_reused",
    }),
    testStatus: "error",
    lastError: "Token expired and refresh failed",
  });

const rowsFor = (email) =>
  db
    .getProviderConnectionsUnscoped({ provider: "codex" })
    .then((all) => all.filter((c) => c.email === email));

const oauth = (email, accountId, extra = {}) => ({
  provider: "codex",
  authType: "oauth",
  email,
  accessToken: `at-${email}-${accountId ?? "legacy"}`,
  refreshToken: `rt-${email}-${accountId ?? "legacy"}`,
  providerSpecificData: accountId ? { chatgptAccountId: accountId } : {},
  ...extra,
});

// JWT whose auth claim carries the account id (legacy rows have no psd id).
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const idTokenFor = (accountId) =>
  jwt({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } });
const legacyRow = (email, accountId, extra = {}) =>
  oauth(email, null, { idToken: idTokenFor(accountId), ...extra });

const reconnect = (email, accountId) => ({
  ...oauth(email, accountId),
  accessToken: `at-fresh-${email}`,
  refreshToken: `rt-fresh-${email}`,
  testStatus: "active",
});

const ts = () => new Date().toISOString();

function seedUser(id) {
  adapter.run(
    `INSERT INTO users(id, instanceRole, status, createdAt, updatedAt) VALUES (?,'user','active',?,?)`,
    [id, ts(), ts()],
  );
}

function seedWorkspace(id, members = []) {
  adapter.run(
    `INSERT INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES (?, ?, 'shared', ?, ?)`,
    [id, id, ts(), ts()],
  );
  for (const u of members) {
    adapter.run(
      `INSERT INTO memberships(workspaceId,userId,role,createdAt) VALUES (?,?,'owner',?)`,
      [id, u, ts()],
    );
  }
}

const countRefs = (id) => ({
  grants: adapter.get(`SELECT COUNT(*) AS n FROM connectionGrants WHERE connectionId = ?`, [id]).n,
  history: adapter.get(`SELECT COUNT(*) AS n FROM usageHistory WHERE connectionId = ?`, [id]).n,
  rollup: adapter.get(`SELECT COUNT(*) AS n FROM usageRollup WHERE connectionId = ?`, [id]).n,
  details: adapter.get(
    `SELECT COUNT(*) AS n FROM requestDetails WHERE connectionId = ? OR data LIKE ?`,
    [id, `%${id}%`],
  ).n,
  videoJobs: adapter.get(`SELECT COUNT(*) AS n FROM gatewayVideoJobs WHERE connectionId = ?`, [id])
    .n,
});

const grantsRepo = () => import("../../src/lib/db/repos/connectionGrantsRepo.js");
const insertGrant = (
  id,
  connectionId,
  { workspaceId = null, userId = null, revokedAt = null } = {},
) =>
  adapter.run(
    `INSERT INTO connectionGrants(id, connectionId, workspaceId, userId, createdAt, revokedAt) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, connectionId, workspaceId, userId, Date.now(), revokedAt],
  );
const activeFor = async (workspaceId) =>
  (await grantsRepo()).listActiveGrantsForPrincipal(adapter, { workspaceId });

// Set a stored account id after creation (a create with it would dedup).
const setAccount = (id, chatgptAccountId) =>
  db.updateProviderConnectionUnscoped(id, { providerSpecificData: { chatgptAccountId } });

describe("YAN-1623: reconnect removes flagged duplicates of the same account", () => {
  it("flagged legacy row beside a live row → one healthy row, the live row's id", async () => {
    const email = "dup-basic@example.com";
    const live = await db.createProviderConnectionUnscoped(oauth(email, "acct-1"));
    const legacy = await db.createProviderConnectionUnscoped(
      legacyRow(email, "acct-1", { name: "legacy" }),
    );
    await flagRow(legacy.id);
    expect(await rowsFor(email)).toHaveLength(2);

    await db.createProviderConnectionUnscoped(reconnect(email, "acct-1"));

    const rows = await rowsFor(email);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(live.id);
    expect(rows[0].reauthRequired ?? null).toBeNull();
    expect(rows[0].refreshToken).toBe(`rt-fresh-${email}`);
    expect(await db.getProviderConnectionByIdUnscoped(legacy.id)).toBeNull();
  });

  it("moves grants, usage, rollups, request details and video jobs onto the kept row", async () => {
    const email = "dup-refs@example.com";
    seedUser("dup-grantee");
    seedWorkspace("dup-ws");
    const live = await db.createProviderConnectionUnscoped(oauth(email, "acct-r"));
    const legacy = await db.createProviderConnectionUnscoped(legacyRow(email, "acct-r"));
    await flagRow(legacy.id);
    const L = legacy.id;
    const K = live.id;

    // Grants: the workspace grantee holds an active grant on both rows; the
    // user grantee only on the loser.
    const now = Date.now();
    adapter.run(
      `INSERT INTO connectionGrants(id, connectionId, workspaceId, userId, createdAt) VALUES ('g-keep-ws', ?, 'dup-ws', NULL, ?)`,
      [K, now],
    );
    adapter.run(
      `INSERT INTO connectionGrants(id, connectionId, workspaceId, userId, createdAt) VALUES ('g-lose-ws', ?, 'dup-ws', NULL, ?)`,
      [L, now],
    );
    adapter.run(
      `INSERT INTO connectionGrants(id, connectionId, workspaceId, userId, createdAt) VALUES ('g-lose-user', ?, NULL, 'dup-grantee', ?)`,
      [L, now],
    );

    adapter.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, promptTokens) VALUES (?, 'codex', 'gpt-5', ?, 11)`,
      [ts(), L],
    );

    const rollup = (connectionId, endpoint, requests, tokensIn, cost, lastUsedAt) =>
      adapter.run(
        `INSERT INTO usageRollup(dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint, requests, tokensIn, cost, lastUsedAt)
         VALUES ('2026-11-01', '', '', 'local-no-key', 'codex', 'gpt-5', ?, ?, ?, ?, ?, ?)`,
        [connectionId, endpoint, requests, tokensIn, cost, lastUsedAt],
      );
    // Same PK apart from connectionId → must sum into the keeper's row.
    rollup(K, "chat", 2, 20, 0.5, "2026-11-01T01:00:00.000Z");
    rollup(L, "chat", 3, 30, 0.25, "2026-11-01T05:00:00.000Z");
    // No keeper counterpart → moves as is.
    rollup(L, "responses", 4, 40, 1, "2026-11-01T02:00:00.000Z");

    adapter.run(
      `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES ('rd-json', ?, 'codex', 'gpt-5', ?, 'ok', ?)`,
      [ts(), L, JSON.stringify({ connectionId: L, keep: 1 })],
    );
    adapter.run(
      `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES ('rd-raw', ?, 'codex', 'gpt-5', ?, 'ok', 'not-json')`,
      [ts(), L],
    );

    videoJobs.initGatewayVideoJobsSync(adapter);
    adapter.run(
      `INSERT INTO gatewayVideoJobs(workspaceId, jobId, provider, connectionId, modelId, createdAt) VALUES ('dup-ws', 'job-dup', 'codex', ?, 'codex/sora', ?)`,
      [L, ts()],
    );

    await db.createProviderConnectionUnscoped(reconnect(email, "acct-r"));

    expect(await db.getProviderConnectionByIdUnscoped(L)).toBeNull();
    expect(countRefs(L)).toEqual({ grants: 0, history: 0, rollup: 0, details: 0, videoJobs: 0 });

    // Grant ids survive; the grantee now holds exactly one active grant.
    const grants = adapter.all(
      `SELECT id, connectionId, workspaceId, userId, revokedAt FROM connectionGrants WHERE id IN ('g-keep-ws','g-lose-ws','g-lose-user') ORDER BY id`,
    );
    expect(grants.map((g) => [g.id, g.connectionId])).toEqual([
      ["g-keep-ws", K],
      ["g-lose-user", K],
      ["g-lose-ws", K],
    ]);
    const byId = Object.fromEntries(grants.map((g) => [g.id, g]));
    expect(byId["g-keep-ws"].revokedAt).toBeNull();
    expect(byId["g-lose-user"].revokedAt).toBeNull();
    expect(Number.isInteger(byId["g-lose-ws"].revokedAt)).toBe(true);
    expect(
      adapter.get(
        `SELECT COUNT(*) AS n FROM connectionGrants WHERE connectionId = ? AND workspaceId = 'dup-ws' AND revokedAt IS NULL`,
        [K],
      ).n,
    ).toBe(1);

    expect(
      adapter.get(`SELECT promptTokens FROM usageHistory WHERE connectionId = ?`, [K]).promptTokens,
    ).toBe(11);

    const rolled = Object.fromEntries(
      adapter
        .all(
          `SELECT endpoint, requests, tokensIn, cost, lastUsedAt FROM usageRollup WHERE connectionId = ? ORDER BY endpoint`,
          [K],
        )
        .map((r) => [r.endpoint, r]),
    );
    expect(rolled.chat).toMatchObject({
      requests: 5,
      tokensIn: 50,
      lastUsedAt: "2026-11-01T05:00:00.000Z",
    });
    expect(rolled.chat.cost).toBeCloseTo(0.75);
    expect(rolled.responses).toMatchObject({ requests: 4, tokensIn: 40, cost: 1 });

    const rdJson = adapter.get(
      `SELECT connectionId, data FROM requestDetails WHERE id = 'rd-json'`,
    );
    expect(rdJson.connectionId).toBe(K);
    expect(JSON.parse(rdJson.data)).toEqual({ connectionId: K, keep: 1 });
    const rdRaw = adapter.get(`SELECT connectionId, data FROM requestDetails WHERE id = 'rd-raw'`);
    expect(rdRaw).toEqual({ connectionId: K, data: "not-json" });

    expect(
      adapter.get(`SELECT connectionId FROM gatewayVideoJobs WHERE jobId = 'job-dup'`).connectionId,
    ).toBe(K);
  });

  it("two flagged rows of the same account collapse into one healthy row", async () => {
    const email = "dup-two-flagged@example.com";
    const first = await db.createProviderConnectionUnscoped(
      legacyRow(email, "acct-2f", { name: "one" }),
    );
    const second = await db.createProviderConnectionUnscoped(
      legacyRow(email, "acct-2f", { name: "two" }),
    );
    await flagRow(first.id);
    await flagRow(second.id);

    await db.createProviderConnectionUnscoped(reconnect(email, "acct-2f"));

    const rows = await rowsFor(email);
    expect(rows).toHaveLength(1);
    expect([first.id, second.id]).toContain(rows[0].id);
    expect(rows[0].reauthRequired ?? null).toBeNull();
    expect(rows[0].refreshToken).toBe(`rt-fresh-${email}`);
  });

  it("keeps a live row of the same email with a different account id", async () => {
    const email = "dup-other-acct@example.com";
    const live = await db.createProviderConnectionUnscoped(oauth(email, "acct-a"));
    const other = await db.createProviderConnectionUnscoped(oauth(email, "acct-b"));
    const legacy = await db.createProviderConnectionUnscoped(legacyRow(email, "acct-a"));
    await flagRow(legacy.id);

    await db.createProviderConnectionUnscoped(reconnect(email, "acct-a"));

    const ids = (await rowsFor(email)).map((r) => r.id).sort();
    expect(ids).toEqual([live.id, other.id].sort());
    const otherAfter = await db.getProviderConnectionByIdUnscoped(other.id);
    expect(otherAfter.refreshToken).toBe(`rt-${email}-acct-b`);
  });

  it("scoped: removes only the caller's flagged row and audits connection.delete for it", async () => {
    const email = "dup-scoped@example.com";
    for (const u of ["dup-user-a", "dup-user-b"]) seedUser(u);
    const wsId = "dup-ws-scoped";
    seedWorkspace(wsId, ["dup-user-a", "dup-user-b"]);
    const ctxA = { userId: "dup-user-a", workspaceIds: [wsId], role: "owner" };
    const ctxB = { userId: "dup-user-b", workspaceIds: [wsId], role: "owner" };

    const aFlagged = await db.createConnection(
      ctxA,
      wsId,
      legacyRow(email, "acct-s", { name: "a-legacy" }),
    );
    const bLive = await db.createConnection(ctxB, wsId, oauth(email, "acct-s"));
    const bFlagged = await db.createConnection(
      ctxB,
      wsId,
      legacyRow(email, "acct-s", { name: "b-legacy" }),
    );
    await flagRow(aFlagged.id);
    await flagRow(bFlagged.id);

    await db.createConnection(ctxB, wsId, reconnect(email, "acct-s"));

    const ids = (await rowsFor(email)).map((r) => r.id).sort();
    expect(ids).toEqual([aFlagged.id, bLive.id].sort());
    const aAfter = await db.getProviderConnectionByIdUnscoped(aFlagged.id);
    expect(aAfter.reauthRequired).toMatchObject({ reason: "refresh_token_rejected" });

    const deletes = adapter.all(
      `SELECT actorUserId, workspaceId, targetType, targetId, before FROM auditEvents WHERE action = 'connection.delete' AND targetId IN (?, ?)`,
      [aFlagged.id, bFlagged.id],
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatchObject({
      actorUserId: "dup-user-b",
      workspaceId: wsId,
      targetType: "connection",
      targetId: bFlagged.id,
    });
    expect(JSON.parse(deletes[0].before)).toEqual({
      id: bFlagged.id,
      provider: "codex",
      name: "b-legacy",
      email,
      workspaceId: wsId,
    });
  });
  it("keeps a flagged legacy row with no derivable account id", async () => {
    const email = "dup-no-id@example.com";
    const live = await db.createProviderConnectionUnscoped(oauth(email, "acct-n"));
    const legacy = await db.createProviderConnectionUnscoped(oauth(email, null));
    await flagRow(legacy.id);

    await db.createProviderConnectionUnscoped(reconnect(email, "acct-n"));

    const ids = (await rowsFor(email)).map((r) => r.id).sort();
    expect(ids).toEqual([live.id, legacy.id].sort());
  });

  it("keeps a flagged row whose account id differs", async () => {
    const email = "dup-diff-id@example.com";
    const live = await db.createProviderConnectionUnscoped(oauth(email, "acct-x"));
    const other = await db.createProviderConnectionUnscoped(legacyRow(email, "acct-y"));
    await flagRow(other.id);

    await db.createProviderConnectionUnscoped(reconnect(email, "acct-x"));

    const ids = (await rowsFor(email)).map((r) => r.id).sort();
    expect(ids).toEqual([live.id, other.id].sort());
  });

  it("access-token re-import absorbs expired rows of the account, keeps an unexpired one", async () => {
    const email = "dup-at@example.com";
    const future = new Date(Date.now() + 3600_000).toISOString();
    const past = new Date(Date.now() - 3600_000).toISOString();
    const at = (name, expiresAt) => ({
      provider: "codex",
      authType: "access_token",
      name,
      email,
      accessToken: jwt({ n: name }),
      expiresAt,
      providerSpecificData: { authMethod: "access_token", chatgptAccountId: "acct-at" },
    });
    const live = await db.createProviderConnectionUnscoped(at("live", future));
    const e1 = await db.createProviderConnectionUnscoped(at("e1", future));
    const e2 = await db.createProviderConnectionUnscoped(at("e2", future));
    await db.updateProviderConnectionUnscoped(e1.id, { expiresAt: past });
    await db.updateProviderConnectionUnscoped(e2.id, { expiresAt: past });

    await db.createProviderConnectionUnscoped(at(undefined, future));

    const rows = await rowsFor(email);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toContain(live.id);
    const kept = rows.find((r) => r.id !== live.id);
    expect([e1.id, e2.id]).toContain(kept.id);
  });

  it("two losers with active grants for one grantee leave exactly one active grant", async () => {
    const email = "dup-two-grants@example.com";
    seedWorkspace("dup-ws-two");
    const live = await db.createProviderConnectionUnscoped(oauth(email, "acct-g2"));
    const l1 = await db.createProviderConnectionUnscoped(
      legacyRow(email, "acct-g2", { name: "l1" }),
    );
    const l2 = await db.createProviderConnectionUnscoped(
      legacyRow(email, "acct-g2", { name: "l2" }),
    );
    await flagRow(l1.id);
    await flagRow(l2.id);
    insertGrant("g2-l1", l1.id, { workspaceId: "dup-ws-two" });
    insertGrant("g2-l2", l2.id, { workspaceId: "dup-ws-two" });

    await db.createProviderConnectionUnscoped(reconnect(email, "acct-g2"));

    const active = await activeFor("dup-ws-two");
    expect(active).toHaveLength(1);
    expect(active[0].connectionId).toBe(live.id);
  });

  it("a keeper's revoked grant wins over a loser's active grant for the same grantee", async () => {
    const email = "dup-revoked-keeper@example.com";
    seedWorkspace("dup-ws-rev");
    const live = await db.createProviderConnectionUnscoped(oauth(email, "acct-rv"));
    const loser = await db.createProviderConnectionUnscoped(legacyRow(email, "acct-rv"));
    await flagRow(loser.id);
    insertGrant("rv-keep", live.id, { workspaceId: "dup-ws-rev", revokedAt: Date.now() - 1000 });
    insertGrant("rv-lose", loser.id, { workspaceId: "dup-ws-rev" });

    await db.createProviderConnectionUnscoped(reconnect(email, "acct-rv"));

    expect(await db.getProviderConnectionByIdUnscoped(loser.id)).toBeNull();
    expect(await activeFor("dup-ws-rev")).toHaveLength(0);
  });

  it("scoped: audits the revoked and moved grants of a removed duplicate", async () => {
    const email = "dup-grant-audit@example.com";
    seedUser("dup-audit-user");
    seedUser("dup-audit-grantee");
    const wsId = "dup-ws-audit";
    seedWorkspace(wsId, ["dup-audit-user"]);
    seedWorkspace("dup-ws-audit-g");
    const ctx = { userId: "dup-audit-user", workspaceIds: [wsId], role: "owner" };
    const live = await db.createConnection(ctx, wsId, oauth(email, "acct-au"));
    const loser = await db.createConnection(ctx, wsId, legacyRow(email, "acct-au", { name: "l" }));
    await flagRow(loser.id);
    insertGrant("au-keep", live.id, { workspaceId: "dup-ws-audit-g" });
    insertGrant("au-revoke", loser.id, { workspaceId: "dup-ws-audit-g" });
    insertGrant("au-move", loser.id, { userId: "dup-audit-grantee" });

    await db.createConnection(ctx, wsId, reconnect(email, "acct-au"));

    const events = adapter.all(
      `SELECT action, targetId, before, after FROM auditEvents WHERE targetType = 'connectionGrant' AND targetId IN ('au-revoke','au-move') ORDER BY action`,
    );
    const byKey = Object.fromEntries(events.map((e) => [`${e.action}:${e.targetId}`, e]));
    const revoke = byKey["connectionGrant.revoke:au-revoke"];
    expect(JSON.parse(revoke.before)).toEqual({ id: "au-revoke", connectionId: loser.id });
    expect(JSON.parse(revoke.after)).toMatchObject({ id: "au-revoke", connectionId: loser.id });
    const move = byKey["connectionGrant.update:au-move"];
    expect(JSON.parse(move.before)).toEqual({ id: "au-move", connectionId: loser.id });
    expect(JSON.parse(move.after)).toEqual({ id: "au-move", connectionId: live.id });
    expect(byKey["connectionGrant.update:au-revoke"]).toBeDefined();
    const grants = await (await grantsRepo()).listGrantsForConnection(ctx, live.id);
    expect(grants.map((g) => g.id).sort()).toEqual(["au-keep", "au-move", "au-revoke"]);
  });

  it("a flagged row whose stored id disagrees with its idToken claim is not removed", async () => {
    const email = "dup-mismatch@example.com";
    const bad = await db.createProviderConnectionUnscoped(
      oauth(email, "acct-tmp-mm", { idToken: idTokenFor("acct-mm-b"), name: "bad" }),
    );
    await setAccount(bad.id, "acct-mm-a");
    await flagRow(bad.id);
    const live = await db.createProviderConnectionUnscoped(oauth(email, "acct-tmp-mm2"));
    await setAccount(live.id, "acct-mm-a");

    await db.createProviderConnectionUnscoped(reconnect(email, "acct-mm-a"));

    const kept = await db.getProviderConnectionByIdUnscoped(bad.id);
    expect(kept).not.toBeNull();
    expect(kept.reauthRequired).toBeTruthy();
    expect((await rowsFor(email)).map((r) => r.id).sort()).toEqual([bad.id, live.id].sort());
  });

  it("never replaces a flagged legacy row proven to be another account", async () => {
    const email = "dup-other-acct-replace@example.com";
    const other = await db.createProviderConnectionUnscoped(legacyRow(email, "acct-oy"));
    await flagRow(other.id);
    const before = await db.getProviderConnectionByIdUnscoped(other.id);

    const created = await db.createProviderConnectionUnscoped(reconnect(email, "acct-ox"));

    expect(created.id).not.toBe(other.id);
    const after = await db.getProviderConnectionByIdUnscoped(other.id);
    expect(after.reauthRequired).toBeTruthy();
    expect(after.refreshToken).toBe(before.refreshToken);
    expect(after.accessToken).toBe(before.accessToken);
    expect(after.idToken).toBe(before.idToken);
    expect(await rowsFor(email)).toHaveLength(2);
  });

  it("prefers the live identity match over a flagged one of the same account", async () => {
    const email = "dup-prefer-live@example.com";
    const flagged = await db.createProviderConnectionUnscoped(oauth(email, "acct-pl"));
    await flagRow(flagged.id);
    const live = await db.createProviderConnectionUnscoped(oauth(email, "acct-tmp-pl"));
    await setAccount(live.id, "acct-pl");

    await db.createProviderConnectionUnscoped(reconnect(email, "acct-pl"));

    const rows = await rowsFor(email);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(live.id);
    expect(rows[0].reauthRequired ?? null).toBeNull();
  });

  for (const revokedFirst of [true, false]) {
    it(`a moved revoked loser grant never suppresses another loser's active grant (revoked ${revokedFirst ? "first" : "second"})`, async () => {
      const tag = revokedFirst ? "rf" : "rs";
      const email = `dup-order-${tag}@example.com`;
      const ws = `dup-ws-order-${tag}`;
      seedWorkspace(ws);
      const live = await db.createProviderConnectionUnscoped(oauth(email, `acct-${tag}`));
      const a = await db.createProviderConnectionUnscoped(
        legacyRow(email, `acct-${tag}`, { name: "a" }),
      );
      const b = await db.createProviderConnectionUnscoped(
        legacyRow(email, `acct-${tag}`, { name: "b" }),
      );
      await flagRow(a.id);
      await flagRow(b.id);
      const [revokedOn, activeOn] = revokedFirst ? [a, b] : [b, a];
      insertGrant(`${tag}-rev`, revokedOn.id, { workspaceId: ws, revokedAt: Date.now() - 1000 });
      insertGrant(`${tag}-act`, activeOn.id, { workspaceId: ws });

      await db.createProviderConnectionUnscoped(reconnect(email, `acct-${tag}`));

      const active = await activeFor(ws);
      expect(active).toHaveLength(1);
      expect(active[0].grantId).toBe(`${tag}-act`);
      expect(active[0].connectionId).toBe(live.id);
    });
  }
});
