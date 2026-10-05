// YAN-367: per-event audit wiring — login success/failure, API denial,
// ownership transfer, membership ops, and the single-user legacy login.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const PEER = "peer-token-yan-367";
process.env.TOKENHOP_PEER_TOKEN = PEER;

const jar = vi.hoisted(() => ({ cookies: new Map(), writes: [], deletes: [] }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n) => (jar.cookies.has(n) ? { name: n, value: jar.cookies.get(n) } : undefined),
    set: (n, v, opts = {}) => {
      jar.cookies.set(n, v);
      jar.writes.push({ name: n, value: v, options: opts });
    },
    delete: (n) => {
      jar.cookies.delete(n);
      jar.deletes.push(n);
    },
  }),
  headers: async () => new Headers(),
}));

let db;
let loginPOST = null;

async function load(state) {
  vi.resetModules();
  process.env[ENV] = state;
  db = await import("@/lib/db/index.js");
  loginPOST = (await import("@/app/api/auth/login/route.js")).POST;
}

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

async function rows() {
  const { events } = await db.auditRepo.list({ pageSize: 100 });
  return events;
}

// Trusted loopback+peer headers so getClientIp buckets per test IP.
const peer = (ip) => ({ "x-9r-peer-token": PEER, "x-9r-real-ip": ip, host: "localhost" });

function loginReq(body, ip = "10.67.0.1") {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json", ...peer(ip) }),
    body: JSON.stringify(body),
  });
}

async function seedUsers(pwB = "correct-horse-15+") {
  const t = await seedTenancy();
  await db.updateSettings({ requireLogin: true });
  const hashB = await bcrypt.hash(pwB, 4);
  await db.updateUserUnscoped(t.b.user.id, { passwordHash: hashB, instanceRole: "user" });
  t.b.user = await db.getUserUnscoped(t.b.user.id);
  const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  adapter.run(`DELETE FROM auditEvents`);
  return { t, pwB };
}

describe("audit legacy single-user login (switch off)", () => {
  // Runs first: the per-file DB has no users and no security marker yet.
  it("login still succeeds and writes a null-actor auth.login row", async () => {
    jar.cookies.clear();
    await load("off");
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    adapter.run(`DELETE FROM auditEvents`);
    // Loopback localhost with no peer headers = local, so the default-password
    // remote guard does not fire.
    const localReq = new NextRequest("http://localhost/api/auth/login", {
      method: "POST",
      headers: new Headers({
        "content-type": "application/json",
        host: "localhost",
        ...peer("127.0.0.1"),
      }),
      body: JSON.stringify({ password: "123456" }),
    });
    const res = await loginPOST(localReq);
    expect(res.status).toBe(200);
    const [evt] = await rows();
    expect(evt).toMatchObject({ action: "auth.login", actorUserId: null, result: "success" });
  });
});

describe("audit auth events", () => {
  beforeEach(async () => {
    jar.cookies.clear();
    jar.writes.length = 0;
    jar.deletes.length = 0;
    await load("on");
  });

  it("wrong password records auth.loginFailed with actor", async () => {
    const { t, pwB } = await seedUsers();
    const res = await loginPOST(
      loginReq({ login: "b@tenancy.test", password: "nope-xyz" }, "10.67.0.11"),
    );
    expect(res.status).toBe(401);
    const [evt] = await rows();
    expect(evt).toMatchObject({
      action: "auth.loginFailed",
      actorUserId: t.b.user.id,
      targetType: "user",
      targetId: t.b.user.id,
      result: "failure",
    });
    expect(JSON.parse(evt.after)).toMatchObject({ reason: "invalid" });
    expect(pwB).toBeTruthy();
  });

  it("successful login records auth.login", async () => {
    const { t, pwB } = await seedUsers();
    const res = await loginPOST(loginReq({ login: "b@tenancy.test", password: pwB }, "10.67.0.12"));
    expect(res.status).toBe(200);
    const [evt] = await rows();
    expect(evt).toMatchObject({
      action: "auth.login",
      actorUserId: t.b.user.id,
      targetType: "user",
      targetId: t.b.user.id,
      result: "success",
    });
    expect(JSON.parse(evt.after)).toMatchObject({ provider: "password" });
  });

  it("authorize() denial for user B records auth.denied", async () => {
    const { t } = await seedUsers();
    // B's session as the request principal: token into the next/headers jar.
    const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
    const token = await createDashboardAuthToken({
      sub: t.b.user.id,
      sv: t.b.user.sessionVersion,
      wid: t.b.ctx.activeWorkspaceId,
    });
    jar.cookies.set("auth_token", token);
    const { authorize } = await import("@/lib/users/session.js");
    const deniedRes = await authorize("instance.users.manage", {});
    expect(deniedRes.status).toBe(403);
    jar.cookies.clear();
    const deniedRows = (await rows()).filter((e) => e.action === "auth.denied");
    expect(deniedRows).toHaveLength(1);
    expect(deniedRows[0]).toMatchObject({
      actorUserId: t.b.user.id,
      targetType: "capability",
      targetId: "instance.users.manage",
      result: "denied",
    });
  });

  it("transferOwnership + addMembership record actor rows", async () => {
    const { t } = await seedUsers();
    const before = await db.getUserUnscoped(t.a.user.id);
    expect(before.instanceRole).toBe("owner");
    const patch = await db.getUserUnscoped(t.b.user.id);
    expect(patch.instanceRole).toBe("user");
    const { transferOwnership } = db;
    await transferOwnership(t.a.ctx, t.b.user.id);
    const added = await db.createUserUnscoped({ email: "c@tenancy.test", instanceRole: "user" });
    await db.addMembership(t.b.ctx, t.shared.id, { userId: added.id, role: "viewer" });
    const actions = (await rows()).map((e) => e.action);
    expect(actions).toContain("instance.ownership.transfer");
    expect(actions).toContain("membership.add");
    const transfer = (await rows()).find((e) => e.action === "instance.ownership.transfer");
    expect(transfer.actorUserId).toBe(t.a.user.id);
  });
});
