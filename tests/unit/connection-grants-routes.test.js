// YAN-369 grant routes on the YAN-354 two-user harness: switch-off 404,
// manager-only creation, the ADR-0006 personal-connection guardrails, grantee
// reads that never expose secrets, and audited revocation.
import { afterAll, describe, expect, it, vi } from "vitest";
import { callRoute, seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const NOW = "2026-01-01T00:00:00.000Z";

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

let adapter;
let t;
let routes;

async function load(state) {
  vi.resetModules();
  process.env[ENV] = state;
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  for (const tbl of ["connectionGrants", "auditEvents", "providerConnections"]) {
    adapter.run(`DELETE FROM ${tbl}`);
  }
  adapter.run("INSERT OR REPLACE INTO settings(id, data) VALUES (1, '{}')");
  routes = {
    manage: await import("@/app/api/providers/[id]/grants/route.js"),
    revoke: await import("@/app/api/providers/[id]/grants/[grantId]/route.js"),
    incoming: await import("@/app/api/grants/route.js"),
    provider: await import("@/app/api/providers/[id]/route.js"),
  };
  t = await seedTenancy();
}

async function as(seeded, handler, url, opts = {}) {
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  jar.cookie = `auth_token=${await createDashboardAuthToken({
    sub: seeded.user.id,
    sv: seeded.user.sessionVersion,
    wid: seeded.ctx.activeWorkspaceId,
  })}`;
  try {
    return await callRoute(handler, url, { as: seeded, ...opts });
  } finally {
    jar.cookie = "";
  }
}

function conn(id, workspaceId, provider = "openai", authType = "apikey") {
  adapter.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, isActive, data, createdAt, updatedAt, workspaceId)
     VALUES(?, ?, ?, ?, 'owner@secret.test', 1, ?, ?, ?, ?)`,
    [
      id,
      provider,
      authType,
      id,
      JSON.stringify({ apiKey: `sk-secret-${id}` }),
      NOW,
      NOW,
      workspaceId,
    ],
  );
}

const post = (who, id, body) =>
  as(who, routes.manage.POST, `/api/providers/${id}/grants`, {
    method: "POST",
    body,
    params: { id },
  });

const allowPersonal = () =>
  adapter.run("INSERT OR REPLACE INTO settings(id, data) VALUES (1, ?)", [
    JSON.stringify({ allowPersonalConnectionGrants: true }),
  ]);

const ACK = { providerId: "claude", sharing: "personal" };

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("grant routes, switch off", () => {
  it("hides all three routes (404)", async () => {
    await load("off");
    const params = { id: "x", grantId: "g" };
    for (const [h, url] of [
      [routes.manage.GET, "/api/providers/x/grants"],
      [routes.revoke.DELETE, "/api/providers/x/grants/g"],
      [routes.incoming.GET, "/api/grants"],
    ]) {
      expect((await callRoute(h, url, { params })).status).toBe(404);
    }
  });
});

describe("grant routes, switch on", () => {
  it("lets a manager grant a shareable connection; grantee sees metadata only", async () => {
    await load("on");
    conn("oa", t.shared.id);
    const res = await post(t.a, "oa", {
      workspaceId: t.b.personal,
      allowedModels: ["openai/gpt-5"],
      rpm: 10,
    });
    expect(res.status).toBe(201);
    const { grant } = await res.json();

    const incoming = await as(t.b, routes.incoming.GET, "/api/grants");
    expect(incoming.status).toBe(200);
    const body = await incoming.json();
    expect(body.grants).toEqual([
      {
        grantId: grant.id,
        provider: "openai",
        name: "oa",
        allowedModels: ["openai/gpt-5"],
        granteeWorkspaceId: t.b.personal,
        granteeUserId: null,
      },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/sk-secret|owner@secret|apiKey|"data"/);
  });

  it("does not let a grantee read the granted connection itself", async () => {
    await load("on");
    conn("oa", t.a.personal);
    expect((await post(t.a, "oa", { userId: t.b.user.id })).status).toBe(201);
    const res = await as(t.b, routes.provider.GET, "/api/providers/oa", { params: { id: "oa" } });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toMatch(/sk-secret/);
  });

  it("refuses non-managers and rejects unknown body keys", async () => {
    await load("on");
    conn("oa", t.shared.id);
    expect((await post(t.b, "oa", { workspaceId: t.b.personal })).status).toBe(403);
    expect((await post(t.a, "oa", { workspaceId: t.b.personal, budgetId: "b1" })).status).toBe(400);
  });

  it("blocks personal connections without the toggle, the ack, or an admin", async () => {
    await load("on");
    conn("cl", t.a.personal, "claude", "oauth");
    const noToggle = await post(t.a, "cl", { workspaceId: t.shared.id, tosAcknowledged: ACK });
    expect(noToggle.status).toBe(403);

    allowPersonal();
    const noAck = await post(t.a, "cl", { workspaceId: t.shared.id });
    expect(noAck.status).toBe(403);
    expect(await noAck.json()).toMatchObject({
      sharing: "personal",
      warning: expect.stringContaining("Anthropic"),
    });

    conn("cl-b", t.b.personal, "claude", "oauth"); // B manages it, but is not an instance admin
    const nonAdmin = await post(t.b, "cl-b", {
      workspaceId: t.shared.id,
      tosAcknowledged: ACK,
    });
    expect(nonAdmin.status).toBe(403);
    expect(adapter.get("SELECT COUNT(*) AS c FROM connectionGrants").c).toBe(0);
  });

  it("allows an acknowledged admin grant on a personal connection and audits it", async () => {
    await load("on");
    allowPersonal();
    conn("cl", t.a.personal, "claude", "oauth");
    const res = await post(t.a, "cl", { workspaceId: t.shared.id, tosAcknowledged: ACK });
    expect(res.status).toBe(201);
    expect((await res.json()).grant.tosAcknowledgedAt).toBeGreaterThan(0);
    const rows = adapter.all("SELECT * FROM auditEvents WHERE action = 'connectionGrant.create'");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toMatch(/sk-secret|owner@secret/);
  });

  it("revokes, audits, and drops the grant from the gateway reader", async () => {
    await load("on");
    conn("oa", t.shared.id);
    const { grant } = await (await post(t.a, "oa", { workspaceId: t.b.personal })).json();
    const res = await as(t.a, routes.revoke.DELETE, `/api/providers/oa/grants/${grant.id}`, {
      method: "DELETE",
      params: { id: "oa", grantId: grant.id },
    });
    expect(res.status).toBe(200);
    expect(
      adapter.get("SELECT COUNT(*) AS c FROM auditEvents WHERE action = 'connectionGrant.revoke'")
        .c,
    ).toBe(1);
    const { listActiveGrantsForPrincipal } = await import("@/lib/db/repos/connectionGrantsRepo.js");
    expect(listActiveGrantsForPrincipal(adapter, { workspaceId: t.b.personal })).toEqual([]);
  });
});
