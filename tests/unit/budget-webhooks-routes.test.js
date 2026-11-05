// YAN-1831 budget webhook route (switch on) on the YAN-354 harness: JSON
// contract (create reveals the secret once, reads/updates/deletes never),
// URL rules, live `workspace.budgets.lower` authority, audit rows carrying
// only { host, enabled }, and the secret absent from every export, the audit
// table and the console. Switch off: budget-webhooks-switch-off-routes.test.js.
import { afterAll, describe, expect, it, vi } from "vitest";
import { callRoute, seedTenancy } from "../setup/tenancyHarness.js";
import { captureConsole, findExactSentinels, leakSummary } from "../helpers/secretScan.js";

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

const SECRET_RE = /^whsec_[A-Za-z0-9_-]{43}$/;
const URL_OK = "https://hooks.example.com/budget?token=pathsecret";

let adapter;
let t;
let route;
let db;

async function load() {
  vi.resetModules();
  process.env[ENV] = "on";
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  for (const tbl of ["budgetWebhooks", "auditEvents"]) adapter.run(`DELETE FROM ${tbl}`);
  route = await import("@/app/api/workspaces/[id]/budget-webhook/route.js");
  db = await import("@/lib/db/index.js");
  await db.updateSettings({ budgetWebhookAllowPrivateNetworks: false });
  t = await seedTenancy();
}

async function seedUser(email, role, instanceRole = "user") {
  const u = await db.createUserUnscoped({ email, instanceRole });
  if (role) await db.addMembership(t.a.ctx, t.shared.id, { userId: u.id, role });
  return { user: u, ctx: { ...t.b.ctx, userId: u.id, activeWorkspaceId: u.personalWorkspaceId } };
}

async function as(seeded, handler, ws, opts = {}) {
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  jar.cookie = `auth_token=${await createDashboardAuthToken({
    sub: seeded.user.id,
    sv: seeded.user.sessionVersion,
    wid: seeded.ctx.activeWorkspaceId,
  })}`;
  try {
    return await callRoute(handler, `/api/workspaces/${ws}/budget-webhook`, {
      as: seeded,
      params: { id: ws },
      ...opts,
    });
  } finally {
    jar.cookie = "";
  }
}

const get = (who, ws) => as(who, route.GET, ws);
const put = (who, ws, body) => as(who, route.PUT, ws, { method: "PUT", body });
const del = (who, ws) => as(who, route.DELETE, ws, { method: "DELETE" });

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("budget webhook route contract", () => {
  it("creates, reveals the secret once, updates, rotates and deletes", async () => {
    await load();
    const ws = t.shared.id;
    const empty = await get(t.a, ws);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({
      webhook: null,
      workspaceId: ws,
      allowPrivateNetworks: false,
    });

    const created = await put(t.a, ws, { url: URL_OK });
    expect(created.status).toBe(201);
    const c = await created.json();
    expect(c.secret).toMatch(SECRET_RE);
    expect(c.webhook).toMatchObject({ url: URL_OK, enabled: true, secretSet: true });
    expect(c.webhook).not.toHaveProperty("createdByUserId");

    const read = await (await get(t.a, ws)).json();
    expect(read.webhook).toMatchObject({ url: URL_OK, enabled: true, secretSet: true });
    expect(read).not.toHaveProperty("secret");

    const upd = await put(t.a, ws, { enabled: false });
    expect(upd.status).toBe(200);
    const u = await upd.json();
    expect(u).not.toHaveProperty("secret");
    expect(u.webhook.enabled).toBe(false);

    const rot = await put(t.a, ws, { rotateSecret: true });
    expect(rot.status).toBe(200);
    const r = await rot.json();
    expect(r.secret).toMatch(SECRET_RE);
    expect(r.secret).not.toBe(c.secret);

    const gone = await del(t.a, ws);
    expect(gone.status).toBe(200);
    expect(await gone.json()).toEqual({ webhook: null });
    const again = await del(t.a, ws);
    expect(again.status).toBe(404);
    expect((await again.json()).code).toBe("not_found");
  });

  it("rejects malformed bodies and disallowed destinations", async () => {
    await load();
    const ws = t.shared.id;
    for (const body of [
      {},
      { url: URL_OK, extra: 1 },
      { url: 5 },
      { url: URL_OK, rotateSecret: true },
    ]) {
      const res = await put(t.a, ws, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).code).toBe("invalid_request");
    }
    for (const url of ["ftp://hooks.example.com/", "https://u:p@hooks.example.com/"]) {
      const res = await put(t.a, ws, { url });
      expect((await res.json()).code, url).toBe("invalid_url");
    }
    for (const url of ["https://169.254.169.254/", "https://10.0.0.5/"]) {
      const res = await put(t.a, ws, { url });
      expect(res.status).toBe(400);
      expect((await res.json()).code, url).toBe("blocked_destination");
    }
    await db.updateSettings({ budgetWebhookAllowPrivateNetworks: true });
    expect((await put(t.a, ws, { url: "http://10.0.0.5/" })).status).toBe(201);
    expect((await (await get(t.a, ws)).json()).allowPrivateNetworks).toBe(true);
    // Created rows exist now: wrong type on update is still invalid_request.
    expect((await (await put(t.a, ws, { enabled: "yes" })).json()).code).toBe("invalid_request");
    await db.updateSettings({ budgetWebhookAllowPrivateNetworks: false });
  });

  it("refuses non-JSON writes, cross-site requests and gateway credentials", async () => {
    await load();
    const ws = t.shared.id;
    const { NextRequest } = await import("next/server");
    const url = new URL(`/api/workspaces/${ws}/budget-webhook`, "http://localhost");
    const ctx = { params: Promise.resolve({ id: ws }) };
    const plain = new NextRequest(url, {
      method: "PUT",
      body: "x",
      headers: { "content-type": "text/plain" },
    });
    expect((await route.PUT(plain, ctx)).status).toBe(415);
    const cross = new NextRequest(url, {
      headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    });
    expect((await route.GET(cross, ctx)).status).toBe(403);
    const bearer = await callRoute(route.GET, url.pathname, {
      apiKey: "sk-test",
      params: { id: ws },
    });
    expect(bearer.status).toBe(401);
  });
});

describe("budget webhook authority (switch on)", () => {
  it("owner and manager manage; member and viewer 403; outsiders 404; admin non-member 403", async () => {
    await load();
    const ws = t.shared.id;
    const mgr = await seedUser("m@tenancy.test", "manager");
    const viewer = await seedUser("v@tenancy.test", "viewer");
    const outsider = await seedUser("o@tenancy.test", null);
    const admin = await seedUser("adm@tenancy.test", null, "admin");

    expect((await put(t.a, ws, { url: URL_OK })).status).toBe(201);
    expect((await get(mgr, ws)).status).toBe(200);
    expect((await put(mgr, ws, { enabled: false })).status).toBe(200);
    for (const who of [t.b, viewer]) {
      expect((await get(who, ws)).status).toBe(403);
      expect((await put(who, ws, { enabled: true })).status).toBe(403);
      expect((await del(who, ws)).status).toBe(403);
    }
    expect((await get(outsider, ws)).status).toBe(404);
    expect((await put(outsider, ws, { enabled: true })).status).toBe(404);
    for (const res of [
      await get(admin, ws),
      await put(admin, ws, { enabled: true }),
      await del(admin, ws),
    ]) {
      expect(res.status).toBe(403);
    }
    expect((await del(mgr, ws)).status).toBe(200);
  });
});

describe("budget webhook audit and secret handling", () => {
  it("audits host and enabled only, and the secret never leaks", async () => {
    await load();
    const ws = t.shared.id;
    const cons = captureConsole("log", "warn", "error", "info", "debug");
    const secrets = [];
    const bodies = [];
    try {
      const created = await (await put(t.a, ws, { url: URL_OK })).json();
      secrets.push(created.secret);
      bodies.push(await (await get(t.a, ws)).json());
      bodies.push(await (await put(t.a, ws, { enabled: false })).json());
      const rotated = await (await put(t.a, ws, { rotateSecret: true, enabled: true })).json();
      secrets.push(rotated.secret);
      bodies.push(await (await get(t.a, ws)).json());

      const { exportConfig } = await import("@/lib/db/configExport.js");
      const { exportWorkspace } = await import("@/lib/db/workspaceTransfer.js");
      bodies.push(await exportConfig());
      bodies.push(
        await exportWorkspace({ ...t.a.ctx, workspaceRoles: { [ws]: "owner" } }, ws, {
          passphrase: "correct horse battery",
        }),
      );
      bodies.push(await db.exportDb());
      // Snapshots carry no webhook table at all.
      expect(JSON.stringify(bodies.at(-1))).not.toContain("budgetWebhooks");

      const audits = adapter.all(
        `SELECT * FROM auditEvents WHERE action LIKE 'budget.webhook.%' ORDER BY ts`,
      );
      bodies.push(await (await del(t.a, ws)).json());
      const all = adapter.all(
        `SELECT * FROM auditEvents WHERE action LIKE 'budget.webhook.%' ORDER BY ts`,
      );
      expect(all.map((a) => a.action).sort()).toEqual([
        "budget.webhook.create",
        "budget.webhook.delete",
        "budget.webhook.rotate",
        "budget.webhook.update",
      ]);
      expect(audits).toHaveLength(3);
      for (const row of all) {
        expect(row.targetType).toBe("budgetWebhook");
        for (const snap of [row.before, row.after].filter(Boolean)) {
          const parsed = JSON.parse(snap);
          expect(Object.keys(parsed).every((k) => ["host", "enabled"].includes(k))).toBe(true);
          expect(parsed.host).toBe("hooks.example.com");
        }
        expect(JSON.stringify(row)).not.toContain("pathsecret");
      }
      bodies.push(all);
    } finally {
      cons.restore();
    }
    const sentinels = Object.fromEntries(secrets.map((s, i) => [`hook${i}`, s]));
    const leaks = findExactSentinels([bodies, cons.lines], { sentinels });
    expect(leaks, leakSummary(leaks)).toEqual([]);
  });
});
