// YAN-376: sharing metadata on GET /api/providers (scoped only), grantee ids on
// GET /api/grants, and member displayName on the members list — no secrets, no email.
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
    providers: await import("@/app/api/providers/route.js"),
    grants: await import("@/app/api/grants/route.js"),
    manage: await import("@/app/api/providers/[id]/grants/route.js"),
    members: await import("@/app/api/workspaces/[id]/members/route.js"),
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

function conn(id, workspaceId, provider, authType, createdByUserId = null) {
  adapter.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, isActive, data, createdAt, updatedAt, workspaceId, createdByUserId)
     VALUES(?, ?, ?, ?, 'owner@secret.test', 1, ?, ?, ?, ?, ?)`,
    [
      id,
      provider,
      authType,
      id,
      JSON.stringify({ apiKey: `sk-secret-${id}` }),
      NOW,
      NOW,
      workspaceId,
      createdByUserId,
    ],
  );
}

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("GET /api/providers sharing metadata", () => {
  it("scoped rows carry sharing, warning and creator display name, no secrets", async () => {
    await load("on");
    adapter.run("UPDATE users SET displayName = 'Ann A' WHERE id = ?", [t.a.user.id]);
    conn("oa", t.shared.id, "openai", "apikey", t.a.user.id);
    conn("cl", t.shared.id, "claude", "oauth", t.a.user.id);
    conn("anon", t.shared.id, "openai", "apikey");

    const res = await as(t.a, routes.providers.GET, `/api/providers?workspaceId=${t.shared.id}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const byId = Object.fromEntries(JSON.parse(text).connections.map((c) => [c.id, c]));

    expect(byId.oa).toMatchObject({
      sharing: "shareable",
      sharingWarning: null,
      createdByDisplayName: "Ann A",
    });
    expect(byId.cl.sharing).toBe("personal");
    expect(byId.cl.sharingWarning).toMatch(/Anthropic/);
    expect(byId.anon.createdByDisplayName).toBeNull();
    // `email` is existing connection metadata; the credential and the creator's
    // user email never appear.
    expect(text).not.toMatch(/sk-secret|a@tenancy\.test/);
  });

  it("unscoped rows lack the new fields", async () => {
    await load("off");
    adapter.run("DELETE FROM providerConnections");
    conn("oa", null, "openai", "apikey");
    const res = await callRoute(routes.providers.GET, "/api/providers");
    expect(res.status).toBe(200);
    const [row] = (await res.json()).connections;
    expect(row.id).toBe("oa");
    for (const k of ["sharing", "sharingWarning", "createdByDisplayName"]) {
      expect(k in row).toBe(false);
    }
  });
});

describe("GET /api/grants grantee ids", () => {
  it("projects an exact field list incl. grantee ids", async () => {
    await load("on");
    conn("oa", t.shared.id, "openai", "apikey");
    const made = await as(t.a, routes.manage.POST, "/api/providers/oa/grants", {
      method: "POST",
      body: { workspaceId: t.b.personal, allowedModels: ["openai/gpt-5"] },
      params: { id: "oa" },
    });
    expect(made.status).toBe(201);
    const { grant } = await made.json();

    const body = await (await as(t.b, routes.grants.GET, "/api/grants")).json();
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

    // user-targeted grant: workspace id null, user id set.
    adapter.run("DELETE FROM connectionGrants");
    await as(t.a, routes.manage.POST, "/api/providers/oa/grants", {
      method: "POST",
      body: { userId: t.b.user.id },
      params: { id: "oa" },
    });
    const [g] = (await (await as(t.b, routes.grants.GET, "/api/grants")).json()).grants;
    expect(g).toMatchObject({ granteeWorkspaceId: null, granteeUserId: t.b.user.id });
  });
});

describe("GET /api/workspaces/[id]/members displayName", () => {
  it("includes displayName per member and never email", async () => {
    await load("on");
    adapter.run("UPDATE users SET displayName = 'Ann A' WHERE id = ?", [t.a.user.id]);
    const res = await as(t.a, routes.members.GET, `/api/workspaces/${t.shared.id}/members`, {
      params: { id: t.shared.id },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const { members } = JSON.parse(text);
    const byUser = Object.fromEntries(members.map((m) => [m.userId, m]));
    expect(byUser[t.a.user.id].displayName).toBe("Ann A");
    expect(byUser[t.b.user.id].displayName).toBeNull();
    expect(text).not.toMatch(/tenancy\.test|"email"/);
  });
});
