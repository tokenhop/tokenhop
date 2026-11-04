// YAN-378: exercise real SSE GET, real session scope and real workspace feed.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { seedTenancy } from "../setup/tenancyHarness.js";

const savedEnv = process.env.TOKENHOP_MULTI_USER;
const jar = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name) => (name === "auth_token" && jar.cookie ? { value: jar.cookie } : undefined),
  }),
  headers: async () => new Headers(jar.cookie ? { cookie: `auth_token=${jar.cookie}` } : {}),
}));

let db;
let adapter;
let t;
let feed;
let GET;
const readers = [];

const counts = () => ({
  update: feed.statsEmitter.listenerCount("update"),
  pending: feed.statsEmitter.listenerCount("pending"),
});

/** Seeded-shaped wrapper for a user created mid-test (admin oversight cases). */
function seeded(user) {
  return {
    user,
    personal: user.personalWorkspaceId,
    ctx: {
      userId: user.id,
      instanceRole: user.instanceRole,
      workspaceIds: [user.personalWorkspaceId],
      activeWorkspaceId: user.personalWorkspaceId,
      via: "session",
    },
  };
}

/** GET as `as`; the jar cookie carries the session for next/headers, bound to `sv`. */
async function open(
  as,
  workspaceId = as.personal,
  query = "",
  { sv = as.user.sessionVersion, signal, headers = {} } = {},
) {
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  const token = await createDashboardAuthToken({ sub: as.user.id, sv, wid: as.personal });
  jar.cookie = token;
  try {
    const url = new URL(`/api/usage/stream?workspaceId=${workspaceId}${query}`, "http://localhost");
    const request = new NextRequest(url, {
      headers: { cookie: `auth_token=${token}`, ...headers },
      signal,
    });
    const response = await GET(request, { params: Promise.resolve({}) });
    if (response.status !== 200) return { response };
    const reader = response.body.getReader();
    readers.push(reader);
    return { response, reader };
  } finally {
    jar.cookie = "";
  }
}

async function frame(reader) {
  const { value, done } = await reader.read();
  expect(done).toBe(false);
  const text = new TextDecoder().decode(value);
  expect(text).toMatch(/^data: .*\n\n$/);
  return JSON.parse(text.slice(6));
}

function sentinel(as, workspaceId, provider, apiKeyId = null) {
  feed.trackPendingRequest(
    "sentinel-model",
    provider,
    provider,
    true,
    false,
    workspaceId,
    as.user.id,
    apiKeyId,
  );
  feed.pushToRing({
    provider,
    workspaceId,
    userId: as.user.id,
    apiKeyId,
    tokens: { prompt_tokens: 1 },
  });
  // Tests emit each event explicitly. Do not let the live feed's debounced
  // pending timer add an extra frame behind the one being asserted.
  clearTimeout(global._statsEmitTimers.pending);
  global._statsEmitTimers.pending = null;
}

/**
 * The stream really closed: the next read is done with no data frame, and the
 * feed holds exactly `expected` subscribers per event. A timeout is a failure.
 */
async function expectClosed(reader, expected) {
  let timer;
  const outcome = await Promise.race([
    reader.read().then((next) => ({ type: "read", next })),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ type: "timeout" }), 2000);
    }),
  ]);
  clearTimeout(timer);
  expect(outcome.type, "stream still open: no closure within 2s").toBe("read");
  expect(outcome.next).toEqual({ done: true, value: undefined });
  expect(counts()).toEqual({ update: expected, pending: expected });
}

beforeEach(async () => {
  vi.resetModules();
  process.env.TOKENHOP_MULTI_USER = "on";
  global._pendingByWorkspace = {};
  global._pendingByIdentity = {};
  global._pendingTimers = {};
  global._recentRing = { items: [], initialized: true };
  db = await import("@/lib/db/index.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  adapter.run("DELETE FROM usageHistory");
  // Hashed apiKeys fixture (same shape as usage-scope-filter.test.js) so the
  // key-filter stream tests exercise the real key liveness columns.
  adapter.exec("DROP TABLE IF EXISTS apiKeys");
  adapter.exec(`CREATE TABLE apiKeys (
      id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      userId TEXT REFERENCES users(id) ON DELETE CASCADE,
      keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
      machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
      revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
      expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
  t = await seedTenancy();
  adapter.run(
    `INSERT INTO apiKeys(id, workspaceId, userId, keyHash, hashKid, prefix, createdAt)
     VALUES ('k-b', ?, ?, 'hash-k-b', 'kid', 'sk-', ?)`,
    [t.shared.id, t.b.user.id, new Date().toISOString()],
  );
  await db.updateSettings({ requireLogin: true, multiUserEnabled: false });
  feed = await import("@/lib/db/repos/usageLiveFeed.js");
  ({ GET } = await import("@/app/api/usage/stream/route.js"));
});

afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.cancel();
  for (const timer of Object.values(global._pendingTimers ?? {})) clearTimeout(timer);
  // Every test ends with the feed free of subscribers.
  expect(counts()).toEqual({ update: 0, pending: 0 });
});
afterAll(() => {
  if (savedEnv === undefined) delete process.env.TOKENHOP_MULTI_USER;
  else process.env.TOKENHOP_MULTI_USER = savedEnv;
});

describe("workspace SSE isolation", () => {
  it("initial, update and pending frames retain only subscriber workspace sentinels", async () => {
    sentinel(t.a, t.a.personal, "a-private-sentinel");
    sentinel(t.b, t.b.personal, "b-private-sentinel");
    const a = await open(t.a);
    const b = await open(t.b);
    expect(a.response.headers.get("content-type")).toBe("text/event-stream");
    for (const event of [null, "update", "pending"]) {
      if (event) feed.statsEmitter.emit(event);
      expect(await frame(a.reader)).toEqual({
        activeRequests: [{ provider: "a-private-sentinel", count: 1 }],
        lastProvider: "a-private-sentinel",
        errorProvider: "",
      });
      expect(await frame(b.reader)).toEqual({
        activeRequests: [{ provider: "b-private-sentinel", count: 1 }],
        lastProvider: "b-private-sentinel",
        errorProvider: "",
      });
    }
  });
});

describe("open stream revocation closes the stream and detaches the subscriber", () => {
  // Fresh GET with the same stale session is denied: revocation really took effect.
  for (const kind of ["membership", "session"])
    it(`after ${kind} change`, async () => {
      const workspaceId = kind === "membership" ? t.shared.id : t.b.personal;
      sentinel(t.a, t.a.personal, "a-private-sentinel");
      sentinel(t.b, workspaceId, "b-before-change");
      const a = await open(t.a);
      const b = await open(t.b, workspaceId);
      expect((await frame(a.reader)).lastProvider).toBe("a-private-sentinel");
      expect((await frame(b.reader)).lastProvider).toBe("b-before-change");
      expect(counts()).toEqual({ update: 2, pending: 2 });

      if (kind === "membership") await db.removeMembership(t.a.ctx, workspaceId, t.b.user.id);
      else await db.bumpSessionVersion(t.b.user.id);
      const fresh = await open(t.b, workspaceId);
      expect([401, 404]).toContain(fresh.response.status);

      sentinel(t.b, workspaceId, "b-after-change");
      sentinel(t.a, t.a.personal, "a-after-change");
      feed.statsEmitter.emit("update");
      expect((await frame(a.reader)).lastProvider).toBe("a-after-change");
      await expectClosed(b.reader, 1); // only A remains
    });

  it("after a manager is downgraded to member (workspace-wide view)", async () => {
    await db.updateMembershipRole(t.a.ctx, t.shared.id, t.b.user.id, "manager");
    sentinel(t.a, t.a.personal, "a-private-sentinel");
    sentinel(t.b, t.shared.id, "b-manager-view");
    const a = await open(t.a);
    const b = await open(t.b, t.shared.id, "&view=workspace");
    expect(b.response.status).toBe(200);
    expect((await frame(a.reader)).lastProvider).toBe("a-private-sentinel");
    expect((await frame(b.reader)).lastProvider).toBe("b-manager-view");

    await db.updateMembershipRole(t.a.ctx, t.shared.id, t.b.user.id, "member");
    const fresh = await open(t.b, t.shared.id, "&view=workspace");
    expect(fresh.response.status).toBe(403);

    sentinel(t.b, t.shared.id, "b-after-downgrade");
    sentinel(t.a, t.a.personal, "a-after-change");
    feed.statsEmitter.emit("update");
    expect((await frame(a.reader)).lastProvider).toBe("a-after-change");
    await expectClosed(b.reader, 1);
  });

  it("after an instance admin is demoted to user (oversight view)", async () => {
    const admin = seeded(
      await db.createUserUnscoped({ email: "c@tenancy.test", instanceRole: "admin" }),
    );
    sentinel(t.a, t.a.personal, "a-private-sentinel");
    const a = await open(t.a);
    const c = await open(admin, t.a.personal);
    expect(c.response.status).toBe(200);
    expect((await frame(a.reader)).lastProvider).toBe("a-private-sentinel");
    expect((await frame(c.reader)).lastProvider).toBe("a-private-sentinel");

    await db.updateUserUnscoped(admin.user.id, { instanceRole: "user" });
    const { sessionVersion } = await db.getUserUnscoped(admin.user.id);
    const fresh = await open(admin, t.a.personal, "", { sv: sessionVersion });
    expect(fresh.response.status).toBe(404);

    sentinel(t.a, t.a.personal, "a-after-change");
    feed.statsEmitter.emit("update");
    expect((await frame(a.reader)).lastProvider).toBe("a-after-change");
    await expectClosed(c.reader, 1);
  });

  it("after the filtered target user is removed (manager userId filter)", async () => {
    sentinel(t.a, t.a.personal, "a-private-sentinel");
    sentinel(t.b, t.shared.id, "b-before-change");
    const a = await open(t.a); // unfiltered control
    const b = await open(t.a, t.shared.id, `&userId=${t.b.user.id}`);
    expect(b.response.status).toBe(200);
    expect((await frame(a.reader)).lastProvider).toBe("a-private-sentinel");
    expect((await frame(b.reader)).lastProvider).toBe("b-before-change");

    await db.removeMembership(t.a.ctx, t.shared.id, t.b.user.id);
    // Parity: a reconnect resolves the removed target as 404, never data.
    const fresh = await open(t.a, t.shared.id, `&userId=${t.b.user.id}`);
    expect(fresh.response.status).toBe(404);

    sentinel(t.a, t.a.personal, "a-after-change");
    feed.statsEmitter.emit("update");
    expect((await frame(a.reader)).lastProvider).toBe("a-after-change");
    await expectClosed(b.reader, 1); // control A keeps streaming
  });

  // A non-manager member holds an own-key filter (key userId = self) but no
  // widen privilege, so ownership churn must close their stream.
  it.each([
    ["moved to another user", "other"],
    ["became a service key", "service"],
  ])("member own-key stream closes after the key %s", async (_kind, variant) => {
    sentinel(t.a, t.a.personal, "a-private-sentinel");
    const a = await open(t.a); // unfiltered control
    const k = await open(t.b, t.shared.id, "&apiKeyId=k-b");
    expect(k.response.status).toBe(200);
    expect((await frame(a.reader)).lastProvider).toBe("a-private-sentinel");
    expect(await frame(k.reader)).toEqual({
      activeRequests: [],
      lastProvider: "",
      errorProvider: "",
    });

    adapter.run(`UPDATE apiKeys SET userId = ? WHERE id = 'k-b'`, [
      variant === "other" ? t.a.user.id : null,
    ]);
    const fresh = await open(t.b, t.shared.id, "&apiKeyId=k-b");
    expect(fresh.response.status).toBe(404);

    sentinel(t.a, t.a.personal, "a-after-change");
    feed.statsEmitter.emit("update");
    expect((await frame(a.reader)).lastProvider).toBe("a-after-change");
    await expectClosed(k.reader, 1); // control A keeps streaming
  });

  it.each([
    ["revoked", "revokedAt", "2026-01-01T00:00:00.000Z"],
    ["paused", "isActive", 0],
    ["expired", "expiresAt", "2026-01-01T00:00:00.000Z"],
  ])("a %s key preserves historical filter access", async (_kind, column, value) => {
    expect((await open(t.a, t.shared.id, "&apiKeyId=k-nope")).response.status).toBe(404);
    sentinel(t.a, t.a.personal, "a-private-sentinel");
    const a = await open(t.a); // unfiltered control
    const k = await open(t.a, t.shared.id, "&apiKeyId=k-b");
    const empty = { activeRequests: [], lastProvider: "", errorProvider: "" };
    expect(k.response.status).toBe(200);
    expect((await frame(a.reader)).lastProvider).toBe("a-private-sentinel");
    expect(await frame(k.reader)).toEqual(empty);

    // Only test-owned, allowlisted column names are interpolated.
    adapter.run(`UPDATE apiKeys SET ${column} = ? WHERE id = 'k-b'`, [value]);
    const fresh = await open(t.a, t.shared.id, "&apiKeyId=k-b");
    expect(fresh.response.status).toBe(200);
    expect(await frame(fresh.reader)).toEqual(empty);

    // Other workspace activity even with the same key id stays off the wire.
    sentinel(t.a, t.a.personal, "a-after-change", "k-b");
    sentinel(t.b, t.shared.id, "b-other-key", "k-other");
    for (const event of ["update", "pending"]) {
      feed.statsEmitter.emit(event);
      expect((await frame(a.reader)).lastProvider).toBe("a-after-change");
      expect(await frame(k.reader)).toEqual(empty);
      expect(await frame(fresh.reader)).toEqual(empty);
      expect(counts()).toEqual({ update: 3, pending: 3 });
    }
  });

  it.each(["moved", "deleted"])("after the filtered API key is %s", async (kind) => {
    sentinel(t.a, t.a.personal, "a-private-sentinel");
    const a = await open(t.a);
    const k = await open(t.a, t.shared.id, "&apiKeyId=k-b");
    expect(k.response.status).toBe(200);
    expect((await frame(a.reader)).lastProvider).toBe("a-private-sentinel");
    expect((await frame(k.reader)).lastProvider).toBe("");

    adapter.run(
      kind === "moved"
        ? `UPDATE apiKeys SET workspaceId = ? WHERE id = 'k-b'`
        : `DELETE FROM apiKeys WHERE id = 'k-b'`,
      kind === "moved" ? [t.a.personal] : [],
    );
    // The same-workspace filter no longer resolves ownership: reconnect 404.
    const fresh = await open(t.a, t.shared.id, "&apiKeyId=k-b");
    expect(fresh.response.status).toBe(404);

    sentinel(t.a, t.a.personal, "a-after-change");
    feed.statsEmitter.emit("update");
    expect((await frame(a.reader)).lastProvider).toBe("a-after-change");
    await expectClosed(k.reader, 1); // only control A remains
  });
});

describe("stream lifecycle", () => {
  it("an unscoped stream closes once multi-user scoping turns on", async () => {
    // Switch off: two users exist but the route is unscoped (today's view).
    delete process.env.TOKENHOP_MULTI_USER;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    feed = await import("@/lib/db/repos/usageLiveFeed.js");
    ({ GET } = await import("@/app/api/usage/stream/route.js"));
    sentinel(t.a, t.a.personal, "a-private-sentinel");
    const open0 = await open(t.a);
    expect((await frame(open0.reader)).lastProvider).toBe("a-private-sentinel");
    expect(counts()).toEqual({ update: 1, pending: 1 });

    await db.updateSettings({ multiUserEnabled: true });
    feed.statsEmitter.emit("update");
    await expectClosed(open0.reader, 0);
  });

  it("a request aborted before start never subscribes or emits", async () => {
    const ac = new AbortController();
    ac.abort();
    const { reader } = await open(t.a, t.a.personal, "", { signal: ac.signal });
    expect(counts()).toEqual({ update: 0, pending: 0 });
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  it("an abort while an update is in flight closes without a data frame", async () => {
    sentinel(t.a, t.a.personal, "a-private-sentinel");
    const ac = new AbortController();
    const { reader } = await open(t.a, t.a.personal, "", { signal: ac.signal });
    expect((await frame(reader)).lastProvider).toBe("a-private-sentinel");

    feed.statsEmitter.emit("update"); // send now awaits its snapshot and auth check
    ac.abort();
    await expectClosed(reader, 0); // done, never the racing data frame
  });

  it("a client cancel while an update is in flight emits nothing and detaches", async () => {
    sentinel(t.a, t.a.personal, "a-private-sentinel");
    sentinel(t.b, t.b.personal, "b-private-sentinel");
    const a = await open(t.a);
    const b = await open(t.b);
    expect((await frame(a.reader)).lastProvider).toBe("a-private-sentinel");
    expect((await frame(b.reader)).lastProvider).toBe("b-private-sentinel");

    feed.statsEmitter.emit("update");
    await b.reader.cancel();
    readers.splice(readers.indexOf(b.reader), 1);
    expect((await frame(a.reader)).lastProvider).toBe("a-private-sentinel");
    expect(counts()).toEqual({ update: 1, pending: 1 });
  });
});

// YAN-1830: budget notices ride the same stream as a named event, filtered
// per viewer, live only.
describe("budget notices on the usage stream", () => {
  const NOTICE_KEYS = [
    "at",
    "budgetId",
    "id",
    "kind",
    "limitRequests",
    "limitTokens",
    "limitUsd",
    "resetAt",
    "scopeId",
    "scopeType",
    "softLimitPct",
    "spent",
    "window",
    "windowStart",
  ];

  // Collect every chunk a reader yields until afterEach cancels it.
  function tap(reader) {
    const chunks = [];
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          chunks.push(new TextDecoder().decode(value));
        }
      } catch {}
    })();
    return () =>
      chunks
        .filter((c) => c.startsWith("event: budgetNotice\n"))
        .map((c) => JSON.parse(c.split("\ndata: ")[1]));
  }
  const settle = () => new Promise((r) => setTimeout(r, 300));

  // A soft-limit budget (100 tokens, 20%) whose window state the guard has
  // built; `spend` settles 30 tokens for B in Shared, `reject` is a 429.
  async function crossSoftLimit({ scopeType = "workspace", scopeId = t.shared.id } = {}) {
    const { bumpBudgetsGeneration } = await import("@/lib/users/budgets.js");
    const guard = await import("@/sse/services/budgetGuard.js");
    adapter.run("DELETE FROM budgets");
    adapter.run(
      `INSERT INTO budgets(id, workspaceId, scopeType, scopeId, window, limitUsd, limitTokens, limitRequests, softLimitPct, resetAt, createdByUserId, createdAt)
       VALUES('bn-1', ?, ?, ?, 'day', NULL, 100, NULL, 20, NULL, NULL, ?)`,
      [scopeType === "user" ? null : t.shared.id, scopeType, scopeId, new Date().toISOString()],
    );
    bumpBudgetsGeneration();
    const p = Object.freeze({
      via: "apiKey",
      workspaceId: t.shared.id,
      userId: t.b.user.id,
      apiKeyId: "k-b",
    });
    // The settle hook saveRequestUsageUnscoped fires after its commit (this
    // file's hashed-key fixture has no hashed marker, so rows can't be saved).
    const { emitUsageCommitted } = await import("@/lib/usage/usageCommitted.js");
    const spend = async () =>
      emitUsageCommitted({
        cost: 0,
        promptTokens: 20,
        completionTokens: 10,
        status: "success",
        workspaceId: t.shared.id,
        userId: t.b.user.id,
        apiKeyId: "k-b",
        grantId: null,
        timestamp: new Date().toISOString(),
      });
    const held = await guard.budgeted(p, { nonToken: true }, async () => new Response("ok"));
    await held.body.cancel();
    // A request that no longer fits: the first 429 of the window (hard notice).
    const reject = async () => {
      const r = await guard.budgeted(
        p,
        { provider: "openai", model: "gpt-x", body: { max_tokens: 1000 } },
        async () => new Response("ok"),
      );
      expect(r.status).toBe(429);
    };
    return { spend, reject };
  }

  it("a soft-limit crossing reaches permitted viewers once, other workspaces nothing", async () => {
    const outsider = seeded(
      await db.createUserUnscoped({ email: "c@tenancy.test", instanceRole: "user" }),
    );
    const { spend } = await crossSoftLimit();
    const owner = await open(t.a, t.shared.id); // workspace owner
    const member = await open(t.b, t.shared.id); // member: workspace.budgets.read
    const memberElsewhere = await open(t.b, t.b.personal); // same user, other workspace
    const other = await open(outsider, outsider.personal); // no access to Shared
    for (const s of [owner, member, memberElsewhere, other]) expect(s.response.status).toBe(200);
    // Subscribed once the connect frame arrived; then collect the rest.
    for (const s of [owner, member, memberElsewhere, other]) await frame(s.reader);
    const seen = [owner, member, memberElsewhere, other].map((s) => tap(s.reader));

    await spend(); // 30 of 100 tokens: crosses 20%
    await spend(); // still over: no second notice
    await settle();

    const [ownerSeen, memberSeen, elsewhereSeen, otherSeen] = seen.map((f) => f());
    expect(ownerSeen).toHaveLength(1);
    expect(memberSeen).toHaveLength(1);
    expect(elsewhereSeen).toEqual([]);
    expect(otherSeen).toEqual([]);
    const notice = memberSeen[0];
    expect(Object.keys(notice).sort()).toEqual(NOTICE_KEYS); // strict allow-list
    expect(Object.keys(notice.spent).sort()).toEqual(["requests", "tokens", "usd"]);
    expect(notice).toMatchObject({
      kind: "soft",
      budgetId: "bn-1",
      scopeType: "workspace",
      limitTokens: 100,
      softLimitPct: 20,
    });
    expect(notice.id).toBe(`bn-1:soft:${notice.windowStart}`);
    expect(JSON.stringify(notice)).not.toMatch(/hash-k-b|keyHash|workspaceId|sk-/);
  });

  it("a reconnect gets no replay: only live notices, and a claimed notice never repeats", async () => {
    const { spend, reject } = await crossSoftLimit();
    const first = await open(t.b, t.shared.id);
    await frame(first.reader);
    const firstSeen = tap(first.reader);
    await spend();
    await spend();
    await settle();
    expect(firstSeen()).toHaveLength(1);

    await first.reader.cancel();
    readers.splice(readers.indexOf(first.reader), 1);
    const again = await open(t.b, t.shared.id);
    await frame(again.reader);
    const againSeen = tap(again.reader);
    await spend(); // still over the soft limit in the same window
    await settle();
    expect(againSeen()).toEqual([]); // the soft notice is not replayed
    await reject(); // a new live notice still arrives on the reconnected stream
    await settle();
    expect(againSeen().map((n) => n.kind)).toEqual(["hard"]);
  });

  /** Open a stream, wait for its connect frame (subscribed), then collect notices. */
  async function listen(as, workspaceId, opts) {
    const s = await open(as, workspaceId, "", opts);
    expect(s.response.status).toBe(200);
    await frame(s.reader);
    return { ...s, seen: tap(s.reader) };
  }

  it("a request carrying gateway credentials never receives notices", async () => {
    const { spend } = await crossSoftLimit();
    const control = await listen(t.a, t.shared.id);
    const keyed = await listen(t.a, t.shared.id, { headers: { authorization: "Bearer sk-x" } });
    await spend();
    await settle();
    expect(control.seen()).toHaveLength(1);
    expect(keyed.seen()).toEqual([]);
  });

  it("user-level budget notices reach instance admins only", async () => {
    const { spend } = await crossSoftLimit({ scopeType: "user", scopeId: t.b.user.id });
    const admin = await listen(t.a, t.a.personal); // instance owner, any workspace
    const self = await listen(t.b, t.shared.id); // the budget's own user, not an admin
    await spend();
    await settle();
    expect(admin.seen().map((n) => [n.kind, n.scopeType])).toEqual([["soft", "user"]]);
    expect(self.seen()).toEqual([]);
  });

  for (const kind of ["membership removed", "session revoked"])
    it(`stops delivery once the viewer's ${kind} between notices`, async () => {
      const { spend, reject } = await crossSoftLimit();
      const control = await listen(t.a, t.shared.id);
      const b = await listen(t.b, t.shared.id);
      await spend();
      await settle();
      expect(b.seen().map((n) => n.kind)).toEqual(["soft"]);

      if (kind === "membership removed")
        await db.removeMembership(t.a.ctx, t.shared.id, t.b.user.id);
      else await db.bumpSessionVersion(t.b.user.id);
      await reject();
      await settle();
      expect(control.seen().map((n) => n.kind)).toEqual(["soft", "hard"]);
      expect(b.seen().map((n) => n.kind)).toEqual(["soft"]); // no hard notice
      expect(feed.statsEmitter.listenerCount("budgetNotice")).toBe(1); // B's stream closed
    });

  it("switch off: the dashboard admin receives Default notices, a non-admin nothing", async () => {
    process.env.TOKENHOP_MULTI_USER = "off";
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    adapter.run(`INSERT OR REPLACE INTO _meta(key, value) VALUES('defaultWorkspaceId', ?)`, [
      t.shared.id,
    ]);
    feed = await import("@/lib/db/repos/usageLiveFeed.js");
    ({ GET } = await import("@/app/api/usage/stream/route.js"));
    try {
      const { spend } = await crossSoftLimit();
      const admin = await listen(t.a, t.shared.id); // owner session
      const user = await listen(t.b, t.shared.id); // plain user session
      await spend();
      await settle();
      expect(admin.seen().map((n) => [n.kind, n.budgetId])).toEqual([["soft", "bn-1"]]);
      expect(user.seen()).toEqual([]);
    } finally {
      adapter.run(`DELETE FROM _meta WHERE key = 'defaultWorkspaceId'`);
    }
  });
});
