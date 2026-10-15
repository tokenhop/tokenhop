// YAN-1160 / GH #915: GET /api/keys is admitted at the edge by keys.create (any
// workspace) so members can list their OWN keys; the handler rechecks live
// (manage → all rows, member → own rows, viewer/non-member → denied). PATCH
// stays manage-only. Real proxy + real collection handler; only the rollout
// reader is mocked.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const rollout = vi.hoisted(() => ({ on: true }));
vi.mock("@/lib/users/featureSwitch.js", () => ({
  isMultiUserEnabled: async () => rollout.on,
}));

const master = Buffer.alloc(32, 43);
const savedEnv = {
  key: process.env.TOKENHOP_MASTER_KEY,
  peer: process.env.TOKENHOP_PEER_TOKEN,
  multi: process.env.TOKENHOP_MULTI_USER,
};
let adapter;
let proxy;
let collection;
const tokens = {};

beforeAll(async () => {
  process.env.TOKENHOP_MASTER_KEY = master.toString("base64");
  process.env.TOKENHOP_PEER_TOKEN = "keys-collection-peer";
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
    ["member", "user"], // ONLY a member of the shared workspace
    ["other", "user"],
    ["viewer", "user"], // ONLY a viewer of the shared workspace
    ["multi", "user"], // member of team + team-b, later removed from team-b
    ["revoked", "user"], // member of team, later removed from everything
  ];
  for (const [id, instanceRole] of users)
    adapter.run(
      "INSERT INTO users(id, instanceRole, status, createdAt, updatedAt) VALUES (?, ?, 'active', ?, ?)",
      [id, instanceRole, now, now],
    );
  for (const [id, kind] of [
    ["default", "shared"],
    ["team", "shared"],
    ["team-b", "shared"],
    ["foreign", "shared"],
    ["member-personal", "personal"],
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
    ["foreign", "owner", "owner"],
    ["team", "owner", "owner"],
    ["team-b", "owner", "owner"],
    // The member's personal workspace role is lowered explicitly: no manage
    // capability anywhere, so the old manage-in-any-workspace gate denied them.
    ["member-personal", "member", "viewer"],
    ["team", "member", "member"],
    ["team", "other", "member"],
    ["team", "viewer", "viewer"],
    ["team", "multi", "member"],
    ["team-b", "multi", "member"],
    ["team", "revoked", "member"],
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
    ["k-member", "team", "member"],
    ["k-other", "team", "other"],
    ["k-service", "team", null],
    ["k-team-b-multi", "team-b", "multi"],
    ["k-team-b-owner", "team-b", "owner"],
    ["k-foreign", "foreign", "owner"],
  ])
    insertHashedApiKeySync(adapter, {
      id,
      workspaceId: ws,
      userId,
      createdByUserId: userId ?? "owner",
      keyHash: hashApiKey(`th_${id}${"x".repeat(24)}`, deriveApiKeyHashKey(master)),
      hashKid: kid,
      prefix: "th_test",
      name: id,
      createdAt: now,
    });

  // Sessions are issued while every membership above is still live.
  const jwt = await import("@/lib/auth/dashboardSession.js");
  for (const [id] of users) {
    const user = await db.getUserUnscoped(id);
    tokens[id] = await jwt.createDashboardAuthToken({ sub: user.id, sv: user.sessionVersion });
  }
  ({ default: proxy } = await import("../../src/proxy.js"));
  collection = await import("@/app/api/keys/route.js");
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

function req(principal, method, workspaceId, body) {
  const headers = new Headers({
    host: "router.example.test",
    cookie: `auth_token=${tokens[principal]}`,
  });
  if (body !== undefined) headers.set("content-type", "application/json");
  const query = workspaceId === undefined ? "" : `?workspaceId=${workspaceId}`;
  return new NextRequest(`http://localhost/api/keys${query}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
// Edge decision, then (if admitted) the handler's decision and JSON body.
async function run(principal, method, workspaceId, body) {
  const edge = await proxy(req(principal, method, workspaceId, body));
  if (edge.status !== 200) return { edge: edge.status, handler: null, body: null };
  const response = await collection[method](req(principal, method, workspaceId, body));
  return { edge: 200, handler: response.status, body: await response.json().catch(() => null) };
}

describe("YAN-1160 GET /api/keys member own-key admission", () => {
  it("a member-only principal lists exactly their own keys, metadata only", async () => {
    const result = await run("member", "GET", "team");
    expect(result.edge).toBe(200);
    expect(result.handler).toBe(200);
    expect(result.body.storage).toBe("hashed");
    expect(result.body.keys.map((k) => k.id)).toEqual(["k-member"]);
    for (const row of result.body.keys) {
      expect(row).not.toHaveProperty("key");
      expect(row).not.toHaveProperty("keyHash");
      expect(row).not.toHaveProperty("hashKid");
    }
    // Neither the other member's key nor the service key leaks.
    const ids = result.body.keys.map((k) => k.id);
    expect(ids).not.toContain("k-other");
    expect(ids).not.toContain("k-service");
  });

  it("a bare GET without workspaceId is admitted at the edge, then 400 at the handler", async () => {
    expect(await run("member", "GET")).toMatchObject({ edge: 200, handler: 400 });
  });

  it("a viewer-only principal stops at the edge", async () => {
    expect((await run("viewer", "GET", "team")).edge).toBe(403);
  });

  it("a foreign workspace fails closed for a member (never 200)", async () => {
    const result = await run("member", "GET", "foreign");
    expect(result.body?.keys).toBeUndefined();
    expect(result.edge === 403 || (result.edge === 200 && result.handler === 404)).toBe(true);
    // Admitted via create in `team`; the handler's live recheck hides `foreign`.
    expect(result).toMatchObject({ edge: 200, handler: 404 });
  });

  it("revoked membership fails closed at the edge when no create-capable workspace remains", async () => {
    expect((await run("revoked", "GET", "team")).edge).toBe(200); // still a member
    adapter.run("DELETE FROM memberships WHERE userId = 'revoked'");
    const result = await run("revoked", "GET", "team");
    expect(result.edge).toBe(403);
    expect(result.body).toBeNull();
  });

  it("a removed workspace membership is rechecked live by the handler", async () => {
    expect(await run("multi", "GET", "team-b")).toMatchObject({ edge: 200, handler: 200 });
    adapter.run("DELETE FROM memberships WHERE userId = 'multi' AND workspaceId = 'team-b'");
    // Still create-capable in `team` (edge admits), but team-b is now foreign.
    expect(await run("multi", "GET", "team-b")).toMatchObject({ edge: 200, handler: 404 });
    const own = await run("multi", "GET", "team");
    expect(own).toMatchObject({ edge: 200, handler: 200 });
    expect(own.body.keys).toEqual([]);
  });

  it("PATCH (manage) stays denied at the edge for the member", async () => {
    expect((await run("member", "PATCH", "team", { acknowledgeMigration: true })).edge).toBe(403);
  });
});
