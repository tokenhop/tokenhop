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
  { sv = as.user.sessionVersion, signal } = {},
) {
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  const token = await createDashboardAuthToken({ sub: as.user.id, sv, wid: as.personal });
  jar.cookie = token;
  try {
    const url = new URL(`/api/usage/stream?workspaceId=${workspaceId}${query}`, "http://localhost");
    const request = new NextRequest(url, { headers: { cookie: `auth_token=${token}` }, signal });
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
