// YAN-360 spec219 / YAN-378: real proxy + members/invitations handlers.
// Non-members get identical 404s for foreign/missing workspace; exact members
// without manage rights keep 403; managers/admins still work.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Only Next's request-local context is supplied; auth, capabilities and DB stay real.
const context = vi.hoisted(() => ({ request: null }));
vi.mock("next/headers", () => ({
  cookies: async () => context.request.cookies,
  headers: async () => context.request.headers,
}));

const savedMulti = process.env.TOKENHOP_MULTI_USER;
let adapter;
let proxy;
let collection;
let item;
let inviteCollection;
let inviteItem;
const tokens = {};

beforeAll(async () => {
  process.env.TOKENHOP_MULTI_USER = "off";
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  await db.updateSettings({ requireLogin: true });
  const now = new Date().toISOString();
  for (const [id, role] of [
    ["owner", "owner"],
    ["admin", "admin"],
    ["manager", "user"],
    ["member", "user"],
    ["viewer", "user"],
    ["target", "user"],
  ])
    adapter.run(
      "INSERT INTO users(id,instanceRole,status,createdAt,updatedAt) VALUES (?,?,'active',?,?)",
      [id, role, now, now],
    );
  for (const id of ["default", "foreign"])
    adapter.run(
      "INSERT INTO workspaces(id,name,kind,createdAt,updatedAt) VALUES (?,?,'shared',?,?)",
      [id, id, now, now],
    );
  for (const [ws, user, role] of [
    ["default", "owner", "owner"],
    ["default", "manager", "manager"],
    ["default", "member", "member"],
    ["default", "viewer", "viewer"],
    ["foreign", "owner", "owner"],
    ["foreign", "target", "member"],
  ])
    adapter.run(
      "INSERT INTO memberships(workspaceId,userId,role,source,createdAt) VALUES (?,?,?,'manual',?)",
      [ws, user, role, now],
    );
  await db.setMeta("defaultWorkspaceId", "default");
  const jwt = await import("@/lib/auth/dashboardSession.js");
  for (const id of ["owner", "admin", "manager", "member", "viewer"]) {
    const user = await db.getUserUnscoped(id);
    tokens[id] = await jwt.createDashboardAuthToken({ sub: id, sv: user.sessionVersion });
  }
  process.env.TOKENHOP_MULTI_USER = "on";
  vi.resetModules();
  ({ proxy } = await import("../../src/dashboardGuard.js"));
  collection = await import("@/app/api/workspaces/[id]/members/route.js");
  item = await import("@/app/api/workspaces/[id]/members/[userId]/route.js");
  inviteCollection = await import("@/app/api/workspaces/[id]/invitations/route.js");
  inviteItem = await import("@/app/api/workspaces/[id]/invitations/[inviteId]/route.js");
});

afterAll(() => {
  if (savedMulti === undefined) delete process.env.TOKENHOP_MULTI_USER;
  else process.env.TOKENHOP_MULTI_USER = savedMulti;
});

function request(principal, method, id, body, userId = "target") {
  const suffix = ["PATCH", "DELETE"].includes(method) ? `/${userId}` : "";
  return new NextRequest(`http://localhost/api/workspaces/${id}/members${suffix}`, {
    method,
    headers: {
      host: "router.example.test",
      ...(tokens[principal] ? { cookie: `auth_token=${tokens[principal]}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function run(principal, method, id, body) {
  context.request = request(principal, method, id, body);
  const edge = await proxy(context.request);
  if (edge.headers.get("x-middleware-next") !== "1")
    return { edge: edge.status, status: edge.status, body: await edge.json() };
  const handler = ["PATCH", "DELETE"].includes(method) ? item : collection;
  const response = await handler[method](context.request, {
    params: Promise.resolve({ id, userId: "target" }),
  });
  return { edge: edge.status, status: response.status, body: await response.json() };
}
const mutations = [
  ["GET", undefined],
  ["POST", { userId: "target", role: "member" }],
  ["PATCH", { role: "viewer" }],
  ["DELETE", undefined],
];

describe("members exact-workspace guard + handler", () => {
  it("foreign/missing workspaces return identical 404s for every non-admin role", async () => {
    const before = adapter.all("SELECT * FROM memberships ORDER BY workspaceId,userId");
    for (const principal of ["manager", "member", "viewer"])
      for (const [method, body] of mutations) {
        const foreign = await run(principal, method, "foreign", body);
        const missing = await run(principal, method, "missing", body);
        expect(foreign).toEqual({
          edge: 404,
          status: 404,
          body: { error: "Workspace not found", code: "not_found" },
        });
        expect(missing).toEqual(foreign);
      }
    expect(adapter.all("SELECT * FROM memberships ORDER BY workspaceId,userId")).toEqual(before);
  });

  it("anonymous requests stay 401, even with login off", async () => {
    const db = await import("@/lib/db/index.js");
    await db.updateSettings({ requireLogin: false });
    for (const [method, body] of mutations)
      expect((await run("anonymous", method, "foreign", body)).status).toBe(401);
    await db.updateSettings({ requireLogin: true });
  });

  it("exact members/viewers without manager rights stay 403", async () => {
    for (const principal of ["member", "viewer"])
      for (const [method, body] of mutations)
        expect((await run(principal, method, "default", body)).status).toBe(403);
  });

  it("exact manager lists, adds, changes role and removes a member through handlers", async () => {
    expect((await run("manager", "GET", "default")).status).toBe(200);
    expect(
      (await run("manager", "POST", "default", { userId: "target", role: "member" })).status,
    ).toBe(201);
    expect((await run("manager", "PATCH", "default", { role: "viewer" })).status).toBe(200);
    expect((await run("manager", "DELETE", "default")).status).toBe(200);
    expect(
      adapter.get("SELECT * FROM memberships WHERE workspaceId='foreign' AND userId='target'")
        ?.role,
    ).toBe("member");
  });

  it("instance admin without membership retains management access", async () => {
    const result = await run("admin", "GET", "foreign");
    expect(result.edge).toBe(200);
    expect(result.status).toBe(200);
    expect(result.body.members.map((m) => m.userId)).toEqual(["owner", "target"]);
  });

  it("unlisted methods and encoded separators never borrow members admission", async () => {
    expect((await proxy(request("member", "PUT", "default"))).status).toBe(403);
    expect((await proxy(request("manager", "GET", "default%2Fother"))).status).toBe(403);
  });
});

function invitationRequest(principal, method, id, body, inviteId) {
  return new NextRequest(
    `http://localhost/api/workspaces/${id}/invitations${inviteId ? `/${inviteId}` : ""}`,
    {
      method,
      headers: {
        host: "router.example.test",
        ...(tokens[principal] ? { cookie: `auth_token=${tokens[principal]}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
}
async function runInvitation(principal, method, id, { body, inviteId } = {}) {
  context.request = invitationRequest(principal, method, id, body, inviteId);
  const edge = await proxy(context.request);
  if (edge.headers.get("x-middleware-next") !== "1")
    return { edge: edge.status, status: edge.status, body: await edge.json() };
  const handler = method === "DELETE" ? inviteItem : inviteCollection;
  const response = await handler[method](context.request, {
    params: Promise.resolve({ id, inviteId }),
  });
  return { edge: edge.status, status: response.status, body: await response.json() };
}
const invitationCalls = [
  ["GET", {}],
  ["POST", { body: { role: "member", email: "sam@example.invalid" } }],
  ["DELETE", { inviteId: "inv-1" }],
];

describe("invitations exact-workspace guard + handler", () => {
  it("foreign/missing workspaces return identical 404s for non-admin principals", async () => {
    for (const principal of ["manager", "member", "viewer"])
      for (const [method, opts] of invitationCalls) {
        const foreign = await runInvitation(principal, method, "foreign", opts);
        const missing = await runInvitation(principal, method, "missing", opts);
        expect(foreign).toEqual({
          edge: 404,
          status: 404,
          body: { error: "Workspace not found", code: "not_found" },
        });
        expect(missing).toEqual(foreign);
      }
  });

  it("anonymous stays 401", async () => {
    for (const [method, opts] of invitationCalls)
      expect((await runInvitation("anonymous", method, "foreign", opts)).status).toBe(401);
  });

  it("exact members/viewers without manager rights stay 403", async () => {
    for (const principal of ["member", "viewer"])
      for (const [method, opts] of invitationCalls)
        expect((await runInvitation(principal, method, "default", opts)).status).toBe(403);
  });

  it("exact manager lists and mints; admin of none lists foreign", async () => {
    expect((await runInvitation("manager", "GET", "default")).status).toBe(200);
    const mint = await runInvitation("manager", "POST", "default", {
      body: { role: "member", email: "sam@example.invalid" },
    });
    expect(mint.status).toBe(201);
    expect(mint.body.token).toEqual(expect.any(String));
    expect(
      (await runInvitation("manager", "DELETE", "default", { inviteId: mint.body.invitation.id }))
        .status,
    ).toBe(200);
    const adminList = await runInvitation("admin", "GET", "foreign");
    expect(adminList.edge).toBe(200);
    expect(adminList.status).toBe(200);
    expect(adminList.body.invitations).toEqual([]);
  });

  it("unlisted methods and encoded separators never borrow invitations admission", async () => {
    for (const method of ["PATCH", "PUT"]) {
      expect((await proxy(invitationRequest("member", method, "default"))).status).toBe(403);
      expect((await proxy(invitationRequest("manager", method, "default"))).status).toBe(403);
    }
    expect((await proxy(invitationRequest("manager", "GET", "default%2Fother"))).status).toBe(403);
  });
});
