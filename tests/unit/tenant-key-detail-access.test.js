// YAN-378: /api/keys/[id] is scoped at the edge so personal-workspace owners
// reach the handler (approved YAN-363 spec); the handler's live workspace check
// still decides. Real proxy + real handlers; only the rollout reader is mocked.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const rollout = vi.hoisted(() => ({ on: true }));
vi.mock("@/lib/users/featureSwitch.js", () => ({
  isMultiUserEnabled: async () => rollout.on,
}));

const master = Buffer.alloc(32, 41);
const savedEnv = {
  key: process.env.TOKENHOP_MASTER_KEY,
  peer: process.env.TOKENHOP_PEER_TOKEN,
  multi: process.env.TOKENHOP_MULTI_USER,
};
let adapter;
let proxy;
let item;
const tokens = {};

beforeAll(async () => {
  process.env.TOKENHOP_MASTER_KEY = master.toString("base64");
  process.env.TOKENHOP_PEER_TOKEN = "key-detail-peer";
  delete process.env.TOKENHOP_MULTI_USER;
  const db = await import("@/lib/db/index.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  const schema = await import("@/lib/db/schema.js");
  const { deriveApiKeyHashKey, hashApiKey, masterKeyId } = await import(
    "@/lib/security/masterKey.js"
  );
  const { insertHashedApiKeySync } = await import("@/lib/db/repos/apiKeysRepo.js");
  const now = new Date().toISOString();
  await db.updateSettings({ requireLogin: true });
  const users = [
    ["owner", "owner"],
    ["admin", "admin"],
    ["user", "user"],
    ["member", "user"],
    ["viewer", "user"],
  ];
  for (const [id, role] of users)
    adapter.run(
      "INSERT INTO users(id, instanceRole, status, createdAt, updatedAt) VALUES (?, ?, 'active', ?, ?)",
      [id, role, now, now],
    );
  for (const [id, kind] of [
    ["default", "shared"],
    ["admin-personal", "personal"],
    ["user-personal", "personal"],
  ])
    adapter.run("INSERT INTO workspaces(id,name,kind,createdAt,updatedAt) VALUES (?,?,?,?,?)", [
      id,
      id,
      kind,
      now,
      now,
    ]);
  for (const [ws, user, role] of [
    ["default", "owner", "owner"],
    ["admin-personal", "admin", "owner"],
    ["user-personal", "user", "owner"],
    ["default", "user", "member"],
    ["default", "member", "member"],
    ["default", "viewer", "viewer"],
  ])
    adapter.run("INSERT INTO memberships(workspaceId,userId,role,createdAt) VALUES (?,?,?,?)", [
      ws,
      user,
      role,
      now,
    ]);
  await db.setMeta("defaultWorkspaceId", "default");
  adapter.exec("DROP TABLE apiKeys");
  adapter.exec(schema.buildCreateTableSql("apiKeys", schema.HASHED_API_KEYS_TABLE));
  const kid = masterKeyId(master);
  await db.setMeta("apiKeysHashedVersion", "1");
  await db.setMeta("apiKeysHashKid", kid);
  for (const [id, ws, userId] of [
    ["k-admin", "admin-personal", "admin"],
    ["k-user", "user-personal", "user"],
    ["k-default", "default", "owner"],
  ])
    insertHashedApiKeySync(adapter, {
      id,
      workspaceId: ws,
      userId,
      createdByUserId: userId,
      keyHash: hashApiKey(`th_${id}${"x".repeat(24)}`, deriveApiKeyHashKey(master)),
      hashKid: kid,
      prefix: "th_test",
      name: id,
      createdAt: now,
    });
  const jwt = await import("@/lib/auth/dashboardSession.js");
  for (const [id] of users) {
    const user = await db.getUserUnscoped(id);
    tokens[id] = await jwt.createDashboardAuthToken({ sub: user.id, sv: user.sessionVersion });
  }
  ({ proxy } = await import("../../src/dashboardGuard.js"));
  item = await import("@/app/api/keys/[id]/route.js");
});
afterAll(() => {
  for (const [name, value] of [
    ["TOKENHOP_MASTER_KEY", savedEnv.key],
    ["TOKENHOP_PEER_TOKEN", savedEnv.peer],
    ["TOKENHOP_MULTI_USER", savedEnv.multi],
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function req(principal, method, id, workspaceId, body) {
  const headers = new Headers({
    host: "router.example.test",
    cookie: `auth_token=${tokens[principal]}`,
  });
  if (body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(`http://localhost/api/keys/${id}?workspaceId=${workspaceId}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
// Edge decision, then (if admitted) the handler's decision.
async function run(principal, method, id, workspaceId, body) {
  const edge = await proxy(req(principal, method, id, workspaceId, body));
  if (edge.status !== 200) return { edge: edge.status, handler: null };
  const response = await item[method](req(principal, method, id, workspaceId, body), {
    params: Promise.resolve({ id }),
  });
  return { edge: 200, handler: response.status };
}

describe("YAN-378 key detail edge + handler", () => {
  it("personal-workspace owners read, update and revoke their own key", async () => {
    for (const [principal, id, ws] of [
      ["user", "k-user", "user-personal"],
      ["admin", "k-admin", "admin-personal"],
    ]) {
      expect(await run(principal, "GET", id, ws)).toEqual({ edge: 200, handler: 200 });
      expect(await run(principal, "PUT", id, ws, { name: `${id}-renamed` })).toEqual({
        edge: 200,
        handler: 200,
      });
      expect(await run(principal, "DELETE", id, ws)).toEqual({ edge: 200, handler: 200 });
    }
  });

  it("the Default-workspace owner manages the Default key", async () => {
    expect(await run("owner", "GET", "k-default", "default")).toEqual({ edge: 200, handler: 200 });
  });

  it("foreign workspace keys never resolve for a non-member", async () => {
    // Edge admits (user owns a personal workspace); the handler hides the row.
    for (const method of ["GET", "PUT", "DELETE"]) {
      const body = method === "PUT" ? { name: "x" } : undefined;
      expect(await run("user", method, "k-admin", "admin-personal", body)).toEqual({
        edge: 200,
        handler: 404,
      });
    }
    // Right workspace id, key from elsewhere: still hidden.
    expect(await run("user", "GET", "k-admin", "user-personal")).toEqual({
      edge: 200,
      handler: 404,
    });
  });

  it("a plain member of Default cannot manage Default keys, even via the handler", async () => {
    // user holds manage via personal workspace, so the edge admits; the
    // handler's live role check for Default still denies.
    for (const method of ["GET", "PUT", "DELETE"]) {
      const body = method === "PUT" ? { name: "x" } : undefined;
      expect(await run("user", method, "k-default", "default", body)).toEqual({
        edge: 200,
        handler: 403,
      });
    }
  });

  it("principals with no manage right in any workspace stop at the edge", async () => {
    for (const principal of ["member", "viewer"])
      for (const method of ["GET", "PUT", "DELETE"])
        expect((await run(principal, method, "k-default", "default")).edge).toBe(403);
  });

  it("revoking removed no foreign rows", () => {
    const revoked = adapter
      .all("SELECT id FROM apiKeys WHERE revokedAt IS NOT NULL ORDER BY id")
      .map((r) => r.id);
    expect(revoked).toEqual(["k-admin", "k-user"]);
  });
});
