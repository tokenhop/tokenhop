// YAN-360 task 2.1: the routePolicy `multiUserOnly` flag and the dashboard
// guard's 404-before-auth ordering for the 13 new switch-gated routes. While
// the users & teams switch is off, every gated route answers the exact
// requireMultiUser() 404 body — anonymous AND authenticated, before any
// local/auth check, so 401/403 can never leak. Switch on: the flag changes
// nothing and the row's own capability gate applies.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRoutePolicy } from "@/lib/auth/routePolicy";

const ENV = "TOKENHOP_MULTI_USER";

const mocks = vi.hoisted(() => ({
  nextResponse: Symbol("next"),
  jsonResponse: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
  getDashboardAuthSession: vi.fn(),
  securityEnforced: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => mocks.nextResponse),
    json: mocks.jsonResponse,
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
  getDashboardAuthSession: mocks.getDashboardAuthSession,
}));

// The switch-on fallthrough below asserts the row's real capability gate, so
// pin the YAN-363 security latch without dragging the DB marker into play.
vi.mock("@/lib/users/securityState.js", () => ({
  isUserSecurityEnforced: mocks.securityEnforced,
}));

// Every gated route/method: sample path, method, expected capability (null =
// public), and the row flags the guard must see.
const USERS = "instance.users.manage";
const MEMBERS = "workspace.members.manage";
const GATED = [
  { sample: "/api/users", route: "/api/users", method: "GET", cap: USERS, always: true },
  {
    sample: "/api/users/ownership-transfer",
    route: "/api/users/ownership-transfer",
    method: "POST",
    cap: "instance.ownership.transfer",
    always: true,
  },
  { sample: "/api/users/u1", route: "/api/users/[id]", method: "PATCH", cap: USERS, always: true },
  {
    sample: "/api/users/u1",
    route: "/api/users/[id]",
    method: "DELETE",
    cap: USERS,
    always: true,
  },
  {
    sample: "/api/workspaces/w1/members",
    route: "/api/workspaces/[id]/members",
    method: "GET",
    cap: MEMBERS,
    scoped: true,
  },
  {
    sample: "/api/workspaces/w1/members",
    route: "/api/workspaces/[id]/members",
    method: "POST",
    cap: MEMBERS,
    scoped: true,
  },
  {
    sample: "/api/workspaces/w1/members/u1",
    route: "/api/workspaces/[id]/members/[userId]",
    method: "PATCH",
    cap: MEMBERS,
    scoped: true,
  },
  {
    sample: "/api/workspaces/w1/members/u1",
    route: "/api/workspaces/[id]/members/[userId]",
    method: "DELETE",
    cap: MEMBERS,
    scoped: true,
  },
  {
    sample: "/api/workspaces/w1/invitations",
    route: "/api/workspaces/[id]/invitations",
    method: "GET",
    cap: MEMBERS,
    scoped: true,
  },
  {
    sample: "/api/workspaces/w1/invitations",
    route: "/api/workspaces/[id]/invitations",
    method: "POST",
    cap: MEMBERS,
    scoped: true,
  },
  {
    sample: "/api/workspaces/w1/invitations/i1",
    route: "/api/workspaces/[id]/invitations/[inviteId]",
    method: "DELETE",
    cap: MEMBERS,
    scoped: true,
  },
  {
    sample: "/api/invitations/accept",
    route: "/api/invitations/accept",
    method: "POST",
    cap: null,
  },
];

let savedEnv;

beforeEach(() => {
  savedEnv = process.env[ENV];
  delete process.env[ENV];
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({ requireLogin: true });
  mocks.validateApiKey.mockResolvedValue(false);
  mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  mocks.getDashboardAuthSession.mockResolvedValue(false);
  mocks.securityEnforced.mockResolvedValue(true);
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  vi.resetModules();
});

// featureSwitch reads the env once at module load; resetModules between phases.
const guardWith = async (env) => {
  if (env === undefined) delete process.env[ENV];
  else process.env[ENV] = env;
  vi.resetModules();
  return (await import("../../src/dashboardGuard.js")).proxy;
};

function request(pathname, { method = "GET", headers = {}, cookie } = {}) {
  return {
    nextUrl: { pathname, searchParams: new URL(`http://localhost${pathname}`).searchParams },
    method,
    headers: new Headers({ host: "router.example.com", ...headers }),
    cookies: { get: vi.fn(() => (cookie ? { value: cookie } : undefined)) },
    url: `http://localhost${pathname}`,
  };
}

describe("multiUserOnly route-policy rows", () => {
  it("maps every new route/method to its exact row, capability and flags", () => {
    for (const { sample, route, method, cap, always = false, scoped = false } of GATED) {
      const policy = resolveRoutePolicy(sample, method);
      expect(policy.key, `${method} ${sample}`).toBe(route);
      expect(policy.multiUserOnly, `${method} ${sample}`).toBe(true);
      expect(policy.capability, `${method} ${sample}`).toBe(cap);
      expect(policy.public, `${method} ${sample}`).toBe(cap === null);
      expect(policy.alwaysProtected, `${method} ${sample}`).toBe(always);
      expect(policy.scoped, `${method} ${sample}`).toBe(scoped);
      expect(policy.localOnly, `${method} ${sample}`).toBe(false);
      expect(policy.gateway, `${method} ${sample}`).toBe(false);
    }
  });

  it("matches the static ownership-transfer row before the dynamic user id", () => {
    expect(resolveRoutePolicy("/api/users/ownership-transfer", "POST").key).toBe(
      "/api/users/ownership-transfer",
    );
    expect(resolveRoutePolicy("/api/users/ownership-transfer", "POST").capability).toBe(
      "instance.ownership.transfer",
    );
  });

  it("fails closed to hostOps on unlisted methods", () => {
    for (const [sample, method] of [
      ["/api/users", "POST"],
      ["/api/users/u1", "GET"],
      ["/api/users/ownership-transfer", "GET"],
      ["/api/workspaces/w1/members", "DELETE"],
      ["/api/workspaces/w1/members/u1", "GET"],
      ["/api/workspaces/w1/invitations", "DELETE"],
      ["/api/workspaces/w1/invitations/i1", "GET"],
    ]) {
      const policy = resolveRoutePolicy(sample, method);
      expect(policy.capability, `${method} ${sample}`).toBe("instance.hostOps");
      expect(policy.multiUserOnly, `${method} ${sample}`).toBe(true);
    }
  });

  it("keeps routePolicy.js import-free (proxy bundle)", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../src/lib/auth/routePolicy.js"),
      "utf8",
    );
    expect(src).not.toMatch(/^\s*(import|export\s+.*from|const\s+\w+\s*=\s*require\()/m);
    expect(src).not.toContain("require(");
  });
});

describe("multiUserOnly guard while the switch is off", () => {
  it("404s every gated route/method anonymously, before auth/local checks", async () => {
    const proxy = await guardWith("off");
    for (const { sample, method } of GATED) {
      const response = await proxy(request(sample, { method }));
      expect(response.status, `${method} ${sample}`).toBe(404);
      expect(response.body, `${method} ${sample}`).toEqual({ error: "Not found" });
    }
  });

  it("404s byte-identically to requireMultiUser()", async () => {
    const proxy = await guardWith("off");
    const { requireMultiUser } = await import("@/lib/users/featureSwitch.js");
    const expected = await requireMultiUser();
    expect(expected.status).toBe(404);
    expect(expected.body).toEqual({ error: "Not found" });
    const response = await proxy(request("/api/users", { method: "GET" }));
    expect(response.status).toBe(expected.status);
    expect(response.body).toEqual(expected.body);
  });

  it("still 404s for an authenticated session (no 401/403 leak)", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
    const proxy = await guardWith("off");
    for (const { sample, method } of GATED) {
      const response = await proxy(request(sample, { method, cookie: "jwt" }));
      expect(response.status, `${method} ${sample}`).toBe(404);
      expect(response.body, `${method} ${sample}`).toEqual({ error: "Not found" });
    }
  });

  it("still 404s with the security latch off (single-user mode would authenticate)", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    mocks.securityEnforced.mockResolvedValue(false);
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
    const proxy = await guardWith("off");
    const response = await proxy(request("/api/users", { method: "GET", cookie: "jwt" }));
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Not found" });
  });
});

describe("multiUserOnly rows with the switch on", () => {
  it("applies the row's own gate instead of hiding (flag is inert)", async () => {
    const proxy = await guardWith("on");
    // Public accept passes straight through (token is the authorization).
    expect(await proxy(request("/api/invitations/accept", { method: "POST" }))).toBe(
      mocks.nextResponse,
    );
    // instance.users.manage: anonymous gets the auth gate, never the hide.
    const denied = await proxy(request("/api/users", { method: "GET" }));
    expect(denied.status).toBe(401);
    // Security latch off with login off: the single admin is let through the
    // scoped members row (not alwaysProtected), still through its capability.
    mocks.securityEnforced.mockResolvedValue(false);
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    expect(await proxy(request("/api/workspaces/w1/members", { method: "GET" }))).toBe(
      mocks.nextResponse,
    );
    // alwaysProtected rows never open via single-user mode (YAN-358 semantics).
    expect((await proxy(request("/api/users", { method: "GET" }))).status).toBe(401);
  });
});
