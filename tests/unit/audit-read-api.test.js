// YAN-367: audit read API — owner/admin only (ADR-0002 instance.audit.read),
// switch-off 404, Bearer rejection, filter + pagination passthrough.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute, seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];

let db;
let t;
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
  const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
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
}

describe("GET /api/audit", () => {
  it("returns rows + pagination to the owner and filters by action prefix", async () => {
    await seedRows();
    const res = await callRoute(GET, "/api/audit", { as: t.a });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pagination).toMatchObject({ page: 1, totalItems: 2, totalPages: 1 });
    expect(body.events.map((e) => e.action).sort()).toEqual(["auth.login", "key.create"]);

    const filtered = await (await callRoute(GET, "/api/audit?action=auth.", { as: t.a })).json();
    expect(filtered.events.map((e) => e.action)).toEqual(["auth.login"]);

    const page2 = await (await callRoute(GET, "/api/audit?page=2&pageSize=1", { as: t.a })).json();
    expect(page2.pagination.totalPages).toBe(2);
    expect(page2.events).toHaveLength(1);
  });

  it("403s a non-admin user", async () => {
    await seedRows();
    expect((await callRoute(GET, "/api/audit", { as: t.b })).status).toBe(403);
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
