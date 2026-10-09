// YAN-376: usage scope view/user/key filters + scopeSql apiKeyId clause.
// Switch on: member defaults to own rows, workspace view is a manager view
// (403), user/key targets resolve live (membership + key state) with 404 for
// unknown/foreign; scopeSql adds an optional apiKeyId condition. Switch off:
// usageScope stays null and every filter is ignored.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];

// Same cookie-jar mirror as usage-scoped-readers.test.js: getPrincipal reads
// cookies() from next/headers.
const jar = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n) => {
      const m = jar.cookie.match(new RegExp(`(?:^|; )${n}=([^;]*)`));
      return m ? { name: n, value: m[1] } : undefined;
    },
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(jar.cookie ? { cookie: jar.cookie } : {}),
}));

let db;
let t;
let usageScope;

async function load(state) {
  vi.resetModules();
  process.env[ENV] = state;
  db = await import("@/lib/db/index.js");
  ({ usageScope } = await import("@/lib/usage/scope.js"));
}

async function as(seeded, path) {
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  const token = await createDashboardAuthToken({
    sub: seeded.user.id,
    sv: seeded.user.sessionVersion,
    wid: seeded.ctx.activeWorkspaceId,
  });
  jar.cookie = `auth_token=${token}`;
  try {
    return await usageScope(new Request(new URL(path, "http://localhost")));
  } finally {
    jar.cookie = "";
  }
}

const adapter = () => import("@/lib/db/driver.js").then((m) => m.getAdapter());

const NOW = "2026-10-09T00:00:00.000Z";
// Minimal live key row; keyHash/hashKid/prefix are NOT NULL in the hashed schema.
const seedKey = (a, { id, workspaceId, userId = null, revokedAt = null }) =>
  a.run(
    `INSERT INTO apiKeys(id, workspaceId, userId, keyHash, hashKid, prefix, revokedAt, createdAt)
     VALUES (?, ?, ?, ?, 'kid', 'sk-', ?, ?)`,
    [id, workspaceId, userId, `hash-${id}`, revokedAt, NOW],
  );

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("switch on: view/userId/apiKeyId filters", () => {
  beforeEach(async () => {
    await load("on");
    const a = await adapter();
    // Hashed key schema fixture, same as gateway-key-routes.test.js.
    a.exec("DROP TABLE IF EXISTS apiKeys");
    a.exec(`CREATE TABLE apiKeys (
      id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      userId TEXT REFERENCES users(id) ON DELETE CASCADE,
      createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
      keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
      machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
      revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
      expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
    t = await seedTenancy();
    seedKey(a, { id: "k-service", workspaceId: t.shared.id });
    seedKey(a, { id: "k-b", workspaceId: t.shared.id, userId: t.b.user.id });
    seedKey(a, { id: "k-a", workspaceId: t.shared.id, userId: t.a.user.id });
  });

  it("member defaults to own rows (view=me semantics), manager to the workspace", async () => {
    const { a, b, shared } = t;
    const ws = `?workspaceId=${shared.id}`;

    const member = await as(b, `/api/usage/stats${ws}`);
    expect(member).toMatchObject({
      workspaceId: shared.id,
      userId: b.user.id,
      apiKeyId: null,
      bodies: false,
    });

    const manager = await as(a, `/api/usage/stats${ws}`);
    expect(manager).toMatchObject({ workspaceId: shared.id, userId: null, apiKeyId: null });
    expect(manager.bodies).toBe(true);

    const me = await as(a, `/api/usage/stats${ws}&view=me`);
    expect(me.userId).toBe(a.user.id);
  });

  it("member asking for view=workspace gets 403; invalid view gets 400", async () => {
    const { b, shared } = t;
    expect((await as(b, `/api/usage/stats?workspaceId=${shared.id}&view=workspace`)).status).toBe(
      403,
    );
    expect((await as(b, `/api/usage/stats?workspaceId=${shared.id}&view=bogus`)).status).toBe(400);
  });

  it("manager filters by a live member's userId; foreign/unknown users 404", async () => {
    const { a, b, shared } = t;
    const ws = `?workspaceId=${shared.id}`;

    const scoped = await as(a, `/api/usage/stats${ws}&userId=${b.user.id}`);
    expect(scoped.userId).toBe(b.user.id);

    expect((await as(a, `/api/usage/stats${ws}&userId=u-nope`)).status).toBe(404);
    // A's personal-workspace peer is unknown inside Shared: B is not a member
    // of A's personal workspace, and a stranger id never resolves either.
    expect(
      (await as(b, `/api/usage/stats?workspaceId=${shared.id}&userId=${a.user.id}`)).status,
    ).toBe(404);
    // Members may always name themselves.
    expect((await as(b, `/api/usage/stats${ws}&userId=${b.user.id}`)).userId).toBe(b.user.id);
  });

  it("live membership is re-checked: a removed member's userId stops resolving (404)", async () => {
    const { a, b, shared } = t;
    await db.removeMembership(a.ctx, shared.id, b.user.id);
    expect(
      (await as(a, `/api/usage/stats?workspaceId=${shared.id}&userId=${b.user.id}`)).status,
    ).toBe(404);
  });

  it("apiKeyId: member gets own user key only; service keys and other users' keys 404", async () => {
    const { a, b, shared } = t;
    const ws = `?workspaceId=${shared.id}`;

    expect((await as(b, `/api/usage/stats${ws}&apiKeyId=k-b`)).apiKeyId).toBe("k-b");
    expect((await as(b, `/api/usage/stats${ws}&apiKeyId=k-a`)).status).toBe(404);
    expect((await as(b, `/api/usage/stats${ws}&apiKeyId=k-service`)).status).toBe(404);
    expect((await as(b, `/api/usage/stats${ws}&apiKeyId=k-nope`)).status).toBe(404);

    // Managers may filter by any live key of the workspace, service included.
    expect((await as(a, `/api/usage/stats${ws}&apiKeyId=k-service`)).apiKeyId).toBe("k-service");
    expect((await as(a, `/api/usage/stats${ws}&apiKeyId=k-b`)).apiKeyId).toBe("k-b");
    expect((await as(a, `/api/usage/stats${ws}&apiKeyId=k-nope`)).status).toBe(404);
  });

  it("a revoked key remains filterable for historical attribution", async () => {
    const { a, shared } = t;
    const path = `/api/usage/stats?workspaceId=${shared.id}&apiKeyId=k-service`;
    expect((await as(a, path)).apiKeyId).toBe("k-service");
    (await adapter()).run(`UPDATE apiKeys SET revokedAt = ? WHERE id = 'k-service'`, [NOW]);
    expect((await as(a, path)).apiKeyId).toBe("k-service");
  });

  it("view=me combines with an own-key filter", async () => {
    const { b, shared } = t;
    const scoped = await as(b, `/api/usage/stats?workspaceId=${shared.id}&view=me&apiKeyId=k-b`);
    expect(scoped).toMatchObject({ userId: b.user.id, apiKeyId: "k-b" });
  });
});

describe("scopeSql", () => {
  it("adds an optional apiKeyId clause on top of workspace/userId", async () => {
    const { scopeSql } = await import("@/lib/db/repos/usageRollupRepo.js");
    expect(scopeSql(null)).toEqual({ sql: "", params: [] });
    expect(scopeSql({ workspaceId: "w" })).toEqual({
      sql: "workspaceId = ?",
      params: ["w"],
    });
    expect(scopeSql({ workspaceId: "w", userId: "u" })).toEqual({
      sql: "workspaceId = ? AND userId = ?",
      params: ["w", "u"],
    });
    expect(scopeSql({ workspaceId: "w", apiKeyId: "k" })).toEqual({
      sql: "workspaceId = ? AND apiKeyId = ?",
      params: ["w", "k"],
    });
    expect(scopeSql({ workspaceId: "w", userId: "u", apiKeyId: "k" }, "u.")).toEqual({
      sql: "u.workspaceId = ? AND u.userId = ? AND u.apiKeyId = ?",
      params: ["w", "u", "k"],
    });
    expect(() => scopeSql({})).toThrow();
  });
});

describe("switch off: usageScope stays unscoped", () => {
  it("returns null no matter the filters", async () => {
    await load("off");
    await seedTenancy();
    const scoped = await usageScope(
      new Request("http://localhost/api/usage/stats?view=workspace&userId=x&apiKeyId=y"),
    );
    expect(scoped).toBeNull();
  });
});
