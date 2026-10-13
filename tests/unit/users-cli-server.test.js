import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { seedTenancy } from "../setup/tenancyHarness.js";

const savedEnv = process.env.TOKENHOP_MULTI_USER;
const PEER = "users-cli-server-peer";
const jar = vi.hoisted(() => ({ cookies: new Map(), headers: new Headers() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n) => (jar.cookies.has(n) ? { value: jar.cookies.get(n) } : undefined),
  }),
  headers: async () => jar.headers,
}));
let db, users, pw, cli, routes, tenancy;
async function load(state = "on") {
  vi.resetModules();
  process.env.TOKENHOP_MULTI_USER = state;
  process.env.TOKENHOP_PEER_TOKEN = PEER;
  db = await import("@/lib/db/index.js");
  users = await import("@/lib/db/repos/usersRepo.js");
  pw = await import("@/lib/auth/userPassword.js");
  cli = await import("@/lib/auth/cliToken.js");
  await db.updateSettings({ requireLogin: true });
  tenancy = await seedTenancy();
  routes = {
    users: await import("@/app/api/users/route.js"),
    user: await import("@/app/api/users/[id]/route.js"),
    password: await import("@/app/api/users/[id]/password/route.js"),
    workspaces: await import("@/app/api/workspaces/route.js"),
    members: await import("@/app/api/workspaces/[id]/members/route.js"),
    member: await import("@/app/api/workspaces/[id]/members/[userId]/route.js"),
    transfer: await import("@/app/api/users/ownership-transfer/route.js"),
    reset: await import("@/app/api/auth/reset-mode/route.js"),
    logout: await import("@/app/api/users/[id]/logout-all/route.js"),
    workspace: await import("@/app/api/workspaces/[id]/route.js"),
    invitation: await import("@/app/api/workspaces/[id]/invitations/route.js"),
    invitationItem: await import("@/app/api/workspaces/[id]/invitations/[inviteId]/route.js"),
    ssoTransfer: await import("@/app/api/users/ownership-transfer/sso/route.js"),
  };
  jar.cookies.clear();
  jar.headers = new Headers({
    [cli.CLI_TOKEN_HEADER]: await cli.getCliToken(),
    "x-9r-peer-token": PEER,
    "x-9r-real-ip": "127.0.0.1",
  });
}
async function call(handler, path, method = "GET", body, params = {}) {
  const headers = new Headers(jar.headers);
  if (body !== undefined) headers.set("content-type", "application/json");
  return handler(
    new NextRequest(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve(params) },
  );
}
async function signIn(seeded) {
  const jwt = await import("@/lib/auth/dashboardSession.js");
  jar.cookies.set(
    "auth_token",
    await jwt.createDashboardAuthToken({
      sub: seeded.user.id,
      sv: seeded.user.sessionVersion,
      wid: seeded.personal,
    }),
  );
  jar.headers = new Headers();
}
async function auditRows() {
  const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  return adapter.all("SELECT * FROM auditEvents WHERE actorUserId = ? AND via = ?", [
    tenancy.a.user.id,
    "cli",
  ]);
}
beforeEach(async () => {
  await load();
});
afterAll(() => {
  if (savedEnv === undefined) delete process.env.TOKENHOP_MULTI_USER;
  else process.env.TOKENHOP_MULTI_USER = savedEnv;
});

it("accepts both header spellings, rejects wrong token, new spelling wins", async () => {
  const token = await cli.getCliToken();
  for (const header of cli.CLI_TOKEN_HEADERS) {
    expect(await cli.hasValidCliToken({ headers: new Headers({ [header]: token }) })).toBe(true);
  }
  for (const value of ["wrong", ""]) {
    expect(
      await cli.hasValidCliToken({
        headers: new Headers({
          [cli.CLI_TOKEN_HEADER]: value,
          [cli.CLI_TOKEN_HEADER_LEGACY]: token,
        }),
      }),
    ).toBe(false);
  }
  expect(
    await cli.hasValidCliToken({
      headers: new Headers({
        [cli.CLI_TOKEN_HEADER]: token,
        [cli.CLI_TOKEN_HEADER_LEGACY]: "wrong",
      }),
    }),
  ).toBe(true);
  expect(
    await cli.hasValidCliToken({
      headers: new Headers({ [cli.CLI_TOKEN_HEADER_LEGACY]: "wrong" }),
    }),
  ).toBe(false);
  const {
    __test__: { sanitizeHeaders },
  } = await import("@/lib/db/repos/requestDetailsRepo.js");
  expect(
    sanitizeHeaders({ "X-Tokenhop-Cli-Token": token, "x-9r-cli-token": token, other: "keep" }),
  ).toEqual({ other: "keep" });
  const { sanitizeGatewayCapture } = await import("@/lib/auth/gatewayAuth.js");
  const capture = sanitizeGatewayCapture({
    headers: new Headers({ [cli.CLI_TOKEN_HEADER]: token, [cli.CLI_TOKEN_HEADER_LEGACY]: token }),
  });
  for (const header of cli.CLI_TOKEN_HEADERS)
    expect(capture.headers.get(header)).toBe("[REDACTED]");
});

it("pins CLI-enabled route rows and session-only rows", async () => {
  const { resolveRoutePolicy } = await import("@/lib/auth/routePolicy.js");
  for (const [path, method] of [
    ["/api/users", "GET"],
    ["/api/users/u", "PATCH"],
    ["/api/users/u/password", "POST"],
    ["/api/users/ownership-transfer", "POST"],
    ["/api/workspaces", "GET"],
    ["/api/workspaces/w/members", "POST"],
    ["/api/workspaces/w/members/u", "DELETE"],
    ["/api/auth/reset-mode", "POST"],
  ]) {
    expect(resolveRoutePolicy(path, method)).toMatchObject({
      cliAllowed: true,
      alwaysProtected: true,
      multiUserOnly: true,
    });
  }
  expect(resolveRoutePolicy("/api/auth/reset-mode", "POST")).toMatchObject({
    localOnly: true,
    capability: "instance.ownership.transfer",
  });
  for (const path of [
    "/api/users/ownership-transfer/sso",
    "/api/users/u/logout-all",
    "/api/workspaces/w",
    "/api/workspaces/w/reauth",
    "/api/workspaces/w/invitations",
    "/api/workspaces/w/invitations/i1",
    "/api/workspaces/w/move",
    "/api/workspaces/w/budgets",
    "/api/workspaces/w/export",
    "/api/workspaces/w/import",
  ]) {
    expect(resolveRoutePolicy(path, "POST").cliAllowed).toBe(false);
  }
});

describe("owner CLI management", () => {
  it("lists users, reads detail, patches role/status, resets password; records actor", async () => {
    const id = tenancy.b.user.id;
    expect((await call(routes.users.GET, "/api/users")).status).toBe(200);
    expect((await call(routes.user.GET, `/api/users/${id}`, "GET", undefined, { id })).status).toBe(
      200,
    );
    const res = await call(
      routes.user.PATCH,
      `/api/users/${id}`,
      "PATCH",
      { instanceRole: "admin", status: "disabled" },
      { id },
    );
    expect(res.status).toBe(200);
    expect(await users.getUserUnscoped(id)).toMatchObject({
      instanceRole: "admin",
      status: "disabled",
    });
    const reset = await call(
      routes.password.POST,
      `/api/users/${id}/password`,
      "POST",
      { password: "temporary horse password" },
      { id },
    );
    expect(await reset.json()).toEqual({ success: true });
    expect(
      await pw.verifyPassword(
        "temporary horse password",
        await users.getUserPasswordHashUnscoped(id),
      ),
    ).toBe(true);
    expect((await users.getUserUnscoped(id)).mustChangePassword).toBe(1);
    expect((await auditRows()).some((r) => r.action === "instance.users.update")).toBe(true);
  });
  it("lists workspaces; lists/adds/patches/removes shared members", async () => {
    const id = tenancy.shared.id;
    const extra = await users.createUserUnscoped({ email: "extra@cli.test", instanceRole: "user" });
    expect((await call(routes.workspaces.GET, "/api/workspaces")).status).toBe(200);
    const path = `/api/workspaces/${id}/members`;
    expect((await call(routes.members.GET, path, "GET", undefined, { id })).status).toBe(200);
    expect(
      (await call(routes.members.POST, path, "POST", { userId: extra.id, role: "viewer" }, { id }))
        .status,
    ).toBe(201);
    expect(
      (
        await call(
          routes.member.PATCH,
          `${path}/${extra.id}`,
          "PATCH",
          { role: "member" },
          { id, userId: extra.id },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(routes.member.DELETE, `${path}/${extra.id}`, "DELETE", undefined, {
          id,
          userId: extra.id,
        })
      ).status,
    ).toBe(200);
    expect((await auditRows()).some((r) => r.action === "membership.add")).toBe(true);
  });
  it("non-owner session, invalid token, remote/proxied CLI, owner self-patch denied", async () => {
    expect(
      (
        await call(
          routes.user.PATCH,
          "/api/users/owner",
          "PATCH",
          { status: "disabled" },
          { id: tenancy.a.user.id },
        )
      ).status,
    ).toBe(403);
    await signIn(tenancy.b);
    expect((await call(routes.users.GET, "/api/users")).status).toBe(403);
    jar.cookies.clear();
    jar.headers.set(cli.CLI_TOKEN_HEADER, "wrong");
    expect((await call(routes.users.GET, "/api/users")).status).toBe(401);
    await load();
    jar.headers.set("x-9r-real-ip", "203.0.113.1");
    expect((await call(routes.users.GET, "/api/users")).status).toBe(401);
    jar.headers.set("x-9r-real-ip", "127.0.0.1");
    jar.headers.set("x-9r-via-proxy", "1");
    expect((await call(routes.users.GET, "/api/users")).status).toBe(401);
  });
  it("unopened handlers still reject CLI", async () => {
    const id = tenancy.shared.id;
    for (const [handler, path, method, body, params] of [
      [routes.user.DELETE, "/api/users/u", "DELETE", undefined, { id: tenancy.b.user.id }],
      [routes.logout.POST, "/api/users/u/logout-all", "POST", {}, { id: tenancy.b.user.id }],
      [routes.workspace.GET, `/api/workspaces/${id}`, "GET", undefined, { id }],
      [routes.invitation.GET, `/api/workspaces/${id}/invitations`, "GET", undefined, { id }],
      [routes.invitation.POST, `/api/workspaces/${id}/invitations`, "POST", {}, { id }],
      [
        routes.invitationItem.DELETE,
        `/api/workspaces/${id}/invitations/i1`,
        "DELETE",
        undefined,
        { id, inviteId: "i1" },
      ],
      [routes.ssoTransfer.POST, "/api/users/ownership-transfer/sso", "POST", {}, {}],
    ])
      expect((await call(handler, path, method, body, params)).status).toBe(401);
  });
  it("ownership transfer still requires same-request password; CLI actor audit", async () => {
    const password = "owner horse password";
    await users.setUserPasswordUnscoped(tenancy.a.user.id, {
      passwordHash: await pw.hashPassword(password),
    });
    const body = { toUserId: tenancy.b.user.id, currentPassword: "wrong password" };
    const wrong = await call(routes.transfer.POST, "/api/users/ownership-transfer", "POST", body);
    expect(await wrong.json()).toMatchObject({ code: "reauth_required" });
    body.currentPassword = password;
    expect(
      (await call(routes.transfer.POST, "/api/users/ownership-transfer", "POST", body)).status,
    ).toBe(200);
    expect((await auditRows()).some((r) => r.action === "instance.ownership.transfer")).toBe(true);
  });
});

describe("delegated user key (owner CLI keys create --user)", () => {
  const MASTER = Buffer.alloc(32, 7);
  async function hashed() {
    const { masterKeyId } = await import("@/lib/security/masterKey.js");
    process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    adapter.exec("DROP TABLE IF EXISTS apiKeys");
    adapter.exec(`CREATE TABLE apiKeys (
      id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      userId TEXT REFERENCES users(id) ON DELETE CASCADE,
      createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
      keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
      machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
      revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
      expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
    adapter.run(
      "INSERT INTO _meta(key, value) VALUES ('apiKeysHashedVersion', '1'), ('apiKeysHashKid', ?)",
      [masterKeyId(MASTER)],
    );
    return adapter;
  }
  it("owner CLI mints for a member; non-member, non-manager caller and plain member denied", async () => {
    const adapter = await hashed();
    const { createApiKey } = await import("@/lib/users/apiKeyManagement.js");
    const ownerCtx = { ...tenancy.a.ctx, via: "cli" };
    const { key, metadata } = await createApiKey(ownerCtx, tenancy.shared.id, {
      type: "user",
      name: "delegated",
      userId: tenancy.b.user.id,
    });
    expect(typeof key).toBe("string");
    const row = adapter.get("SELECT userId, createdByUserId FROM apiKeys WHERE id = ?", [
      metadata.id,
    ]);
    expect(row).toEqual({ userId: tenancy.b.user.id, createdByUserId: tenancy.a.user.id });
    expect(JSON.stringify(metadata)).not.toContain(key);
    const outsider = await users.createUserUnscoped({
      email: "out@cli.test",
      instanceRole: "user",
    });
    await expect(
      createApiKey(ownerCtx, tenancy.shared.id, { type: "user", name: "x", userId: outsider.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      createApiKey(tenancy.b.ctx, tenancy.shared.id, {
        type: "user",
        name: "x",
        userId: tenancy.a.user.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("reset mode", () => {
  async function sso() {
    await db.updateSettings({
      authMode: "sso",
      ssoType: "oidc",
      oidcEnabled: true,
      oidcIssuerUrl: "https://idp.example",
      oidcClientId: "stub",
      oidcClientSecret: "stub-secret",
    });
  }
  it("recovers SSO-only owner, password login helper succeeds; audit has no secrets", async () => {
    await sso();
    const password = "recovered horse password";
    const res = await call(routes.reset.POST, "/api/auth/reset-mode", "POST", {
      mode: "password",
      password,
    });
    expect(await res.json()).toEqual({
      success: true,
      authMode: "password",
      ownerPasswordSet: true,
    });
    expect((await db.getSettings()).authMode).toBe("password");
    const { verifyDashboardPassword } = await import("@/lib/auth/dashboardSession.js");
    expect(await verifyDashboardPassword(password)).toBe(true);
    const rows = await auditRows();
    expect(rows.some((r) => r.action === "auth.resetMode")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(password);
    expect(JSON.stringify(rows)).not.toContain(await cli.getCliToken());
  });
  it("absent credential requires password without changing mode; existing credential retained", async () => {
    await sso();
    const missing = await call(routes.reset.POST, "/api/auth/reset-mode", "POST", {
      mode: "password",
    });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ code: "OWNER_PASSWORD_REQUIRED" });
    expect((await db.getSettings()).authMode).toBe("sso");
    const hash = await pw.hashPassword("existing horse password");
    await users.setUserPasswordUnscoped(tenancy.a.user.id, { passwordHash: hash });
    expect(
      await (
        await call(routes.reset.POST, "/api/auth/reset-mode", "POST", { mode: "password" })
      ).json(),
    ).toMatchObject({ ownerPasswordSet: false });
    expect(await users.getUserPasswordHashUnscoped(tenancy.a.user.id)).toBe(hash);
  });
  it("valid CLI token from a remote or proxied peer is denied, even at cardinality 1", async () => {
    await users.updateUserUnscoped(tenancy.b.user.id, { status: "disabled" });
    expect(await users.countActiveUsersUnscoped()).toBe(1);
    jar.headers.set("x-9r-real-ip", "203.0.113.1");
    expect(
      (await call(routes.reset.POST, "/api/auth/reset-mode", "POST", { mode: "password" })).status,
    ).toBe(403);
    jar.headers.set("x-9r-real-ip", "127.0.0.1");
    jar.headers.set("x-9r-via-proxy", "1");
    expect(
      (await call(routes.reset.POST, "/api/auth/reset-mode", "POST", { mode: "password" })).status,
    ).toBe(403);
    jar.headers.delete("x-9r-via-proxy");
    expect(
      (await call(routes.reset.POST, "/api/auth/reset-mode", "POST", { mode: "password" })).status,
    ).not.toBe(403);
    await users.updateUserUnscoped(tenancy.b.user.id, { status: "active" });
  });
  it("invalid mode/password/extra keys and non-owner denied", async () => {
    for (const body of [
      { mode: "sso" },
      { mode: "password", password: "short" },
      { mode: "password", requireLogin: false },
    ]) {
      expect((await call(routes.reset.POST, "/api/auth/reset-mode", "POST", body)).status).toBe(
        400,
      );
    }
    await signIn(tenancy.b);
    expect(
      (await call(routes.reset.POST, "/api/auth/reset-mode", "POST", { mode: "password" })).status,
    ).toBe(403);
  });
  it("switch off hides reset mode and opened management handlers", async () => {
    await load("off");
    for (const [handler, path, method, body, params] of [
      [routes.reset.POST, "/api/auth/reset-mode", "POST", { mode: "password" }, {}],
      [routes.users.GET, "/api/users", "GET", undefined, {}],
      [
        routes.user.PATCH,
        "/api/users/u",
        "PATCH",
        { status: "disabled" },
        { id: tenancy.b.user.id },
      ],
      [
        routes.password.POST,
        "/api/users/u/password",
        "POST",
        { password: "password horse" },
        { id: tenancy.b.user.id },
      ],
      [routes.workspaces.GET, "/api/workspaces", "GET", undefined, {}],
      [
        routes.members.GET,
        "/api/workspaces/w/members",
        "GET",
        undefined,
        { id: tenancy.shared.id },
      ],
    ])
      expect((await call(handler, path, method, body, params)).status).toBe(404);
  });
});
