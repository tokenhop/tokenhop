// YAN-373: GET /api/workspaces — admin list of SHARED workspaces only.
// Switch off 404, non-admin 403, admin sees shared workspaces with member
// counts, personal workspaces never listed. Plus the routePolicy row and the
// public /invite page prefix.
import { afterAll, describe, expect, it, vi } from "vitest";
import { callRoute, seedTenancy } from "../setup/tenancyHarness.js";
import { resolveRoutePolicy } from "@/lib/auth/routePolicy";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];

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

let t;
let route;

async function load(state) {
  vi.resetModules();
  process.env[ENV] = state;
  route = await import("@/app/api/workspaces/route.js");
  t = await seedTenancy();
}

async function as(seeded) {
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  jar.cookie = `auth_token=${await createDashboardAuthToken({
    sub: seeded.user.id,
    sv: seeded.user.sessionVersion,
    wid: seeded.ctx.activeWorkspaceId,
  })}`;
  try {
    return await callRoute(route.GET, "/api/workspaces", { as: seeded });
  } finally {
    jar.cookie = "";
  }
}

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("GET /api/workspaces", () => {
  it("is hidden (404) while the switch is off", async () => {
    await load("off");
    expect((await callRoute(route.GET, "/api/workspaces")).status).toBe(404);
  });

  it("rejects a plain member with 403 and anonymous with 401", async () => {
    await load("on");
    expect((await as(t.b)).status).toBe(403);
    expect((await callRoute(route.GET, "/api/workspaces")).status).toBe(401);
  });

  it("admin sees shared workspaces only, with member counts, sorted by name", async () => {
    await load("on");
    const db = await import("@/lib/db/index.js");
    await db.createSharedWorkspace(t.a.ctx, { name: "Alpha" });
    const res = await as(t.a);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { workspaces } = await res.json();
    expect(workspaces.map((w) => w.name)).toEqual(["Alpha", "Shared"]);
    const shared = workspaces.find((w) => w.name === "Shared");
    expect(shared).toEqual({
      id: t.shared.id,
      name: "Shared",
      createdAt: expect.any(String),
      memberCount: 2,
    });
    expect(workspaces.find((w) => w.name === "Alpha").memberCount).toBe(1);
    const ids = workspaces.map((w) => w.id);
    expect(ids).not.toContain(t.a.personal);
    expect(ids).not.toContain(t.b.personal);
  });
});

describe("routePolicy /api/workspaces", () => {
  it("is multiUserOnly, admin-gated, session only", () => {
    expect(resolveRoutePolicy("/api/workspaces", "GET")).toMatchObject({
      key: "/api/workspaces",
      capability: "instance.users.manage",
      multiUserOnly: true,
      alwaysProtected: true,
      cliAllowed: false,
    });
  });
});
