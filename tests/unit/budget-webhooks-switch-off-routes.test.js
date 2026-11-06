// YAN-1831 budget webhook route with Users & teams off: the pristine
// dashboard admin manages the webhook on the (pending) Default via the
// `default` alias; on an established install the owner with Default
// membership does; a non-admin session is refused and gateway credentials never
// authorize.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const NOW = "2026-01-01T00:00:00.000Z";
const URL_OK = "https://hooks.example.com/budget";

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
let route;
let db;

async function load() {
  vi.resetModules();
  process.env[ENV] = "off";
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  for (const tbl of [
    "budgetWebhooks",
    "budgets",
    "auditEvents",
    "apiKeys",
    "memberships",
    "identities",
    "workspaces",
    "users",
  ])
    adapter.run(`DELETE FROM ${tbl}`);
  adapter.run(
    `DELETE FROM _meta WHERE key IN ('defaultWorkspaceId', 'pendingDefaultWorkspaceId', 'apiKeysHashedVersion', 'apiKeysHashKid')`,
  );
  adapter.run(
    `INSERT INTO apiKeys(id, key, name, isActive, createdAt) VALUES('legacy-key', 'sk-pristine-raw-0123456789', 'k', 1, ?)`,
    [NOW],
  );
  db = await import("@/lib/db/index.js");
  await db.updateSettings({ requireLogin: true });
  route = await import("@/app/api/workspaces/[id]/budget-webhook/route.js");
}

async function call(handler, { method = "GET", body, cookie, bearer, id = "default" } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  jar.cookie = cookie ?? "";
  try {
    const req = new NextRequest(
      new URL(`/api/workspaces/${id}/budget-webhook`, "http://localhost"),
      {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    return await handler(req, { params: Promise.resolve({ id }) });
  } finally {
    jar.cookie = "";
  }
}

async function cookieFor(claims) {
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  return `auth_token=${await createDashboardAuthToken(claims)}`;
}
const userCookie = (u, wid) => cookieFor({ sub: u.id, sv: u.sessionVersion, wid });

beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("budget webhook, switch off", () => {
  it("pristine admin creates on the pending Default via the alias", async () => {
    await load();
    const cookie = await cookieFor({});
    const empty = await call(route.GET, { cookie });
    expect(empty.status).toBe(200);
    expect((await empty.json()).workspaceId).toBeNull();

    const created = await call(route.PUT, { method: "PUT", body: { url: URL_OK }, cookie });
    expect(created.status).toBe(201);
    expect((await created.json()).secret).toMatch(/^whsec_/);
    const pending = adapter.get(
      `SELECT value FROM _meta WHERE key = 'pendingDefaultWorkspaceId'`,
    ).value;
    const read = await (await call(route.GET, { cookie })).json();
    expect(read.workspaceId).toBe(pending);
    expect(read.webhook).toMatchObject({ url: URL_OK, enabled: true });
    expect(read).not.toHaveProperty("secret");
    expect((await call(route.GET, { cookie, id: pending })).status).toBe(200);

    expect((await call(route.GET, { bearer: "sk-pristine-raw-0123456789" })).status).toBe(401);
    expect((await call(route.DELETE, { method: "DELETE", cookie })).status).toBe(200);
  });

  it("established install: the owner with Default membership manages it, a plain user cannot", async () => {
    await load();
    const t = await seedTenancy();
    await db.setMeta("defaultWorkspaceId", t.shared.id);
    const owner = await userCookie(t.a.user, t.shared.id);
    const created = await call(route.PUT, { method: "PUT", body: { url: URL_OK }, cookie: owner });
    expect(created.status).toBe(201);
    const read = await (await call(route.GET, { cookie: owner })).json();
    expect(read.workspaceId).toBe(t.shared.id);

    // A non-admin session is not the dashboard admin: refused by the shared
    // budget gate (401, as for budgets) and nothing changes.
    const plain = await userCookie(t.b.user, t.shared.id);
    expect((await call(route.GET, { cookie: plain })).status).toBe(401);
    expect(
      (await call(route.PUT, { method: "PUT", body: { enabled: false }, cookie: plain })).status,
    ).toBe(401);
    expect(adapter.get(`SELECT enabled FROM budgetWebhooks`).enabled).toBe(1);
    expect((await call(route.GET, { bearer: "sk-test" })).status).toBe(401);
  });
});
