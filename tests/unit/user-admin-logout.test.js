// YAN-373: POST /api/users/[id]/logout-all (admin "sign out everywhere") on the
// YAN-354 harness, real DB: hierarchy matrix incl. self, re-read race, target
// sessions die while the actor session and target API keys survive, origin and
// switch guards, exactly one audit row with ids only.
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const savedMasterKey = process.env.TOKENHOP_MASTER_KEY;

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
let adapter;
let session;
let route;
let jwt;
let t; // { a: owner, b: user, shared }
let admin;
let admin2;
let pending;

async function load(state) {
  vi.resetModules();
  process.env[ENV] = state;
  db = await import("@/lib/db/index.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  adapter.run("DELETE FROM auditEvents");
  adapter.run("DELETE FROM apiKeys");
  jwt = await import("@/lib/auth/dashboardSession.js");
  session = await import("@/lib/users/session");
  route = await import("@/app/api/users/[id]/logout-all/route.js");
  t = await seedTenancy();
  const mk = async (instanceRole, email) => {
    const user = await db.createUserUnscoped({ email, instanceRole });
    return {
      user,
      ctx: { ...t.b.ctx, userId: user.id, activeWorkspaceId: user.personalWorkspaceId },
    };
  };
  admin = await mk("admin", "admin@tenancy.test");
  admin2 = await mk("admin", "admin2@tenancy.test");
  pending = await mk("pending", "pending@tenancy.test");
}

const tokenFor = async (who) => {
  const fresh = await db.getUserUnscoped(who.user.id);
  return jwt.createDashboardAuthToken({
    sub: fresh.id,
    sv: fresh.sessionVersion,
    wid: fresh.personalWorkspaceId ?? who.user.personalWorkspaceId,
  });
};
const live = async (token) => session.isLiveSession(token);

// A real hashed user key owned by `who` (userId set, YAN-363 shape) in their
// personal workspace, minted by the production createApiKey path. Returns the
// raw bearer. Only meaningful once installHashedKeyStore has run.
async function issueUserKey(who) {
  const { createApiKey } = await import("@/lib/users/apiKeyManagement.js");
  const { key } = await createApiKey(
    { userId: who.user.id, instanceRole: who.user.instanceRole, via: "session" },
    who.user.personalWorkspaceId,
    { type: "user" },
  );
  return key;
}
const keyEligible = async (raw) => {
  const { resolveApiKey } = await import("@/lib/auth/apiKeyPrincipal.js");
  const { clearApiKeyPrincipalCache } = await import("@/lib/auth/apiKeyPrincipal.js");
  clearApiKeyPrincipalCache(); // never let the 5s digest cache mask a revoke
  return (await resolveApiKey(raw)) != null;
};

// Rebuild apiKeys in the hashed shape and stamp the durable marker + kid, the
// way the YAN-363 switch-on migration does (gateway-key-management fixture).
const MASTER = randomBytes(32);
let hashedStore = false;
async function installHashedKeyStore() {
  if (hashedStore) return;
  const { HASHED_API_KEYS_TABLE, buildCreateTableSql } = await import("@/lib/db/schema.js");
  const { masterKeyId } = await import("@/lib/security/masterKey.js");
  process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
  adapter.exec(`DROP TABLE apiKeys; ${buildCreateTableSql("apiKeys", HASHED_API_KEYS_TABLE)}`);
  for (const idx of HASHED_API_KEYS_TABLE.indexes) adapter.exec(idx);
  adapter.run(
    `INSERT INTO _meta(key, value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)`,
    [masterKeyId(MASTER)],
  );
  hashedStore = true;
}

async function post(actor, targetId, headers = {}) {
  jar.cookie = actor ? `auth_token=${await tokenFor(actor)}` : "";
  const req = new NextRequest(new URL(`/api/users/${targetId}/logout-all`, "http://localhost"), {
    method: "POST",
    headers: new Headers(headers),
  });
  try {
    return await route.POST(req, { params: Promise.resolve({ id: targetId }) });
  } finally {
    jar.cookie = "";
  }
}
const sv = (who) =>
  adapter.get("SELECT sessionVersion AS v FROM users WHERE id = ?", [who.user.id]).v;
const rows = () =>
  adapter.all("SELECT * FROM auditEvents WHERE action = 'instance.users.logoutAll'");

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  if (savedMasterKey === undefined) delete process.env.TOKENHOP_MASTER_KEY;
  else process.env.TOKENHOP_MASTER_KEY = savedMasterKey;
});

describe("admin logout-all hierarchy", () => {
  it("owner may sign out an admin and a user; admin may sign out a user", async () => {
    await load("on");
    for (const [actor, target] of [
      [t.a, admin],
      [t.a, t.b],
      [admin, t.b],
    ]) {
      const old = await tokenFor(target);
      const before = sv(target);
      const res = await post(actor, target.user.id);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      expect(res.headers.get("cache-control")).toMatch(/no-store/);
      expect(sv(target)).toBe(before + 1);
      expect(await live(old)).toBe(false);
    }
  });

  it("refuses self, owner, admin->admin, non-admin, pending and anonymous; nothing is bumped", async () => {
    await load("on");
    const all = [t.a, t.b, admin, admin2, pending];
    const snap = all.map(sv);
    const cases = [
      [t.a, t.a.user.id, 403], // owner self
      [admin, admin.user.id, 403], // admin self
      [admin, t.a.user.id, 403], // owner immutable
      [admin, admin2.user.id, 403], // admin cannot target admin
      [t.b, admin.user.id, 403], // plain user lacks the capability
      [pending, t.b.user.id, 401], // pending has no live session
      [null, t.b.user.id, 401], // anonymous
      [t.a, "missing-id", 404],
    ];
    for (const [actor, target, status] of cases) {
      expect((await post(actor, target)).status, `${actor?.user?.email} -> ${target}`).toBe(status);
    }
    expect(all.map(sv)).toEqual(snap);
    expect(rows()).toEqual([]);
  });

  it("race: actor demoted or target promoted before the write -> repo refuses, no bump", async () => {
    await load("on");
    const repo = await import("@/lib/db/repos/usersRepo.js");
    // Actor demoted (stale session still routes in; the repo re-reads live).
    const before = sv(t.b);
    await db.updateUserUnscoped(admin.user.id, { instanceRole: "user" });
    await expect(
      repo.revokeUserSessionsUnscoped(t.b.user.id, { actorUserId: admin.user.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Actor disabled.
    await db.updateUserUnscoped(admin2.user.id, { status: "disabled" });
    await expect(
      repo.revokeUserSessionsUnscoped(t.b.user.id, { actorUserId: admin2.user.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(sv(t.b)).toBe(before);

    // Target promoted to admin after an admin actor read them as a user.
    await load("on");
    const repo2 = await import("@/lib/db/repos/usersRepo.js");
    const db2 = await import("@/lib/db/index.js");
    await db2.updateUserUnscoped(t.b.user.id, { instanceRole: "admin" });
    const mid = sv(t.b);
    await expect(
      repo2.revokeUserSessionsUnscoped(t.b.user.id, { actorUserId: admin.user.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(sv(t.b)).toBe(mid);
  });
});

describe("what survives a logout-all", () => {
  it("target sessions die; actor session and both user-scoped API keys stay valid", async () => {
    await load("on");
    await installHashedKeyStore();
    const targetOld = await tokenFor(t.b);
    const actorToken = await tokenFor(t.a);
    // Keys OWNED by target and actor (userId set): the rows a wrong
    // implementation would tombstone via revokeUserApiKeysSync(db, userId).
    const targetKey = await issueUserKey(t.b);
    const actorKey = await issueUserKey(t.a);
    expect(await keyEligible(targetKey)).toBe(true);
    expect(await keyEligible(actorKey)).toBe(true);

    expect((await post(t.a, t.b.user.id)).status).toBe(200);
    // Bite check (verified, then reverted): temporarily inserting
    // `revokeUserApiKeysSync(adapter, t.b.user.id)` here flips the target-key
    // assertion to false while the actor sibling stays true — so the test
    // catches the tombstone regression. The mutation is not left in.

    expect(await live(targetOld)).toBe(false);
    expect(await live(actorToken)).toBe(true);
    expect(await keyEligible(targetKey)).toBe(true);
    expect(await keyEligible(actorKey)).toBe(true);
    // Target can sign in again: a fresh token for the new version is live.
    expect(await live(await tokenFor(t.b))).toBe(true);
    const u = await db.getUserUnscoped(t.b.user.id);
    expect(u).toMatchObject({ status: "active", instanceRole: "user" });
    // No tombstone on the target's key row.
    expect(
      adapter.get(`SELECT revokedAt, isActive FROM apiKeys WHERE userId = ?`, [t.b.user.id]),
    ).toMatchObject({ revokedAt: null, isActive: 1 });
  });

  it("writes exactly one id-only audit row", async () => {
    await load("on");
    await post(t.a, t.b.user.id);
    const [row, ...rest] = rows();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      actorUserId: t.a.user.id,
      targetType: "user",
      targetId: t.b.user.id,
      result: "success",
    });
    expect(`${row.before ?? ""}${row.after ?? ""}`).not.toMatch(/email|password|token|hash/i);
  });
});

describe("guards", () => {
  it("switch off -> 404 before auth, nothing changes", async () => {
    await load("off");
    const before = sv(t.b);
    expect((await post(null, t.b.user.id)).status).toBe(404);
    expect((await post(t.a, t.b.user.id)).status).toBe(404);
    expect(sv(t.b)).toBe(before);
    expect(rows()).toEqual([]);
  });

  it("cross-site origin -> 403 forbidden_origin, nothing changes", async () => {
    await load("on");
    const before = sv(t.b);
    for (const headers of [
      { origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site" },
    ]) {
      const res = await post(t.a, t.b.user.id, headers);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "forbidden_origin" });
    }
    expect(sv(t.b)).toBe(before);
    expect(rows()).toEqual([]);
  });
});
