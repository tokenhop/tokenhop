// YAN-376: audit read API — scoped (ADR-0002 workspace.audit.read): instance
// owner/admin read cross-workspace; workspace owner/manager read their
// selected or active workspace. Switch-off 404, Bearer rejection, live
// re-read of status/role/membership (stale claims never grant), scoped
// pagination counts, no-store.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute, seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];

let db;
let t;
let adapter;
let GET;

async function load(state) {
  vi.resetModules();
  process.env[ENV] = state;
  db = await import("@/lib/db/index.js");
  ({ GET } = await import("@/app/api/audit/route.js"));
}

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

beforeEach(async () => {
  await load("on");
  t = await seedTenancy();
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  adapter.run(`DELETE FROM auditEvents`);
});

const evt = (over = {}) => ({ action: "auth.login", result: "success", ...over });

async function seedRows() {
  await db.auditRepo.insert(
    evt({
      action: "auth.login",
      actorUserId: t.a.user.id,
      workspaceId: t.a.personal,
      ts: "2026-01-01T00:00:00.000Z",
    }),
  );
  await db.auditRepo.insert(
    evt({
      action: "key.create",
      actorUserId: t.b.user.id,
      workspaceId: t.shared.id,
      targetType: "apiKey",
      targetId: "k1",
    }),
  );
  await db.auditRepo.insert(
    evt({
      action: "user.login",
      actorUserId: t.b.user.id,
      workspaceId: t.b.personal,
    }),
  );
}

// Raw SQL on purpose: repo mutators bump sessionVersion, which would revoke
// the session outright. These tests exercise the handler's LIVE re-read with
// a session whose claims (sv) are still valid but whose role/membership/
// status rows changed underneath.
const setRole = (role) =>
  adapter.run(`UPDATE memberships SET role = ? WHERE workspaceId = ? AND userId = ?`, [
    role,
    t.shared.id,
    t.b.user.id,
  ]);

describe("GET /api/audit", () => {
  it("returns every row to the instance owner (cross-workspace) with no-store", async () => {
    await seedRows();
    const res = await callRoute(GET, "/api/audit", { as: t.a });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.pagination).toMatchObject({ page: 1, totalItems: 3, totalPages: 1 });
    expect(body.events.map((e) => e.action).sort()).toEqual([
      "auth.login",
      "key.create",
      "user.login",
    ]);

    const filtered = await (await callRoute(GET, "/api/audit?action=auth.", { as: t.a })).json();
    expect(filtered.events.map((e) => e.action)).toEqual(["auth.login"]);

    const page2 = await (await callRoute(GET, "/api/audit?page=2&pageSize=1", { as: t.a })).json();
    expect(page2.pagination).toMatchObject({ totalItems: 3, totalPages: 3 });
    expect(page2.events).toHaveLength(1);
  });

  it("scopes a workspace manager to the selected workspace, counts and all", async () => {
    await seedRows();
    setRole("manager");
    const res = await callRoute(GET, `/api/audit?workspaceId=${t.shared.id}`, { as: t.b });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events.map((e) => e.action)).toEqual(["key.create"]);
    // 3 rows exist globally; the counts stay scoped to the workspace.
    expect(body.pagination).toMatchObject({ totalItems: 1, totalPages: 1 });
    const paged = await (
      await callRoute(GET, `/api/audit?workspaceId=${t.shared.id}&pageSize=1`, { as: t.b })
    ).json();
    expect(paged.pagination).toMatchObject({ totalItems: 1, totalPages: 1 });
    expect(paged.events).toHaveLength(1);

    // A foreign actor filter cannot widen the forced workspace scope.
    const foreign = await (
      await callRoute(GET, `/api/audit?workspaceId=${t.shared.id}&actorUserId=${t.a.user.id}`, {
        as: t.b,
      })
    ).json();
    expect(foreign.events).toEqual([]);
    expect(foreign.pagination.totalItems).toBe(0);
  });

  it("defaults a non-admin to their active workspace", async () => {
    await seedRows();
    setRole("manager");
    const body = await (await callRoute(GET, "/api/audit", { as: t.b })).json();
    expect(body.events.map((e) => e.action)).toEqual(["user.login"]);
    expect(body.pagination.totalItems).toBe(1);
  });

  it.each([["member"], ["viewer"]])("403s a workspace %s (non-manager member)", async (role) => {
    await seedRows();
    setRole(role);
    expect(
      (await callRoute(GET, `/api/audit?workspaceId=${t.shared.id}`, { as: t.b })).status,
    ).toBe(403);
  });

  it("404s a foreign workspace and an unknown id (no existence leak)", async () => {
    await seedRows();
    setRole("manager");
    expect(
      (await callRoute(GET, `/api/audit?workspaceId=${t.a.personal}`, { as: t.b })).status,
    ).toBe(404);
    expect((await callRoute(GET, "/api/audit?workspaceId=nope", { as: t.b })).status).toBe(404);
  });

  it("denies stale claims: demotion, removal and disablement are read live", async () => {
    await seedRows();
    setRole("manager");
    const url = `/api/audit?workspaceId=${t.shared.id}`;
    expect((await callRoute(GET, url, { as: t.b })).status).toBe(200);

    // Demoted after the session was minted: live role read -> 403.
    setRole("member");
    expect((await callRoute(GET, url, { as: t.b })).status).toBe(403);

    // Removed from the workspace: 404, indistinguishable from missing.
    adapter.run(`DELETE FROM memberships WHERE workspaceId = ? AND userId = ?`, [
      t.shared.id,
      t.b.user.id,
    ]);
    expect((await callRoute(GET, url, { as: t.b })).status).toBe(404);

    // Disabled: live status denies even if the cached session still resolves. (Membership
    // restored: the denial must come from the status check, not the 404.)
    adapter.run(
      `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?, ?, 'manager', 'manual', ?)`,
      [t.shared.id, t.b.user.id, new Date().toISOString()],
    );

    // Disabled: live status denies even if the cached session still resolves.
    adapter.run(`UPDATE users SET status = 'disabled' WHERE id = ?`, [t.b.user.id]);
    expect((await callRoute(GET, url, { as: t.b })).status).toBe(403);
  });

  it("403s a Bearer gateway key even alongside a session", async () => {
    await seedRows();
    expect((await callRoute(GET, "/api/audit", { as: t.a, apiKey: "sk-x" })).status).toBe(403);
  });

  it("400s invalid paging params", async () => {
    expect((await callRoute(GET, "/api/audit?page=0", { as: t.a })).status).toBe(400);
    expect((await callRoute(GET, "/api/audit?pageSize=999", { as: t.a })).status).toBe(400);
  });
});

describe("GET /api/audit with the switch off", () => {
  it("404s (requireMultiUser)", async () => {
    await load("off");
    expect((await callRoute(GET, "/api/audit", { as: t.a })).status).toBe(404);
  });
});
