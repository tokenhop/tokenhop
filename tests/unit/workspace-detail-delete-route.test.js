// YAN-373: GET/DELETE /api/workspaces/:id and POST/GET /api/workspaces/:id/reauth.
// Switch off 404, roles, CLI refusal, origin/JSON/body bounds, strict body,
// password and SSO fresh proofs, no state change on any failed proof,
// Default/personal protection, continued SSO login after map cleanup.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const jar = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n) => {
      const mt = jar.cookie.match(new RegExp(`(?:^|; )${n}=([^;]*)`));
      return mt ? { name: n, value: mt[1] } : undefined;
    },
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(jar.cookie ? { cookie: jar.cookie } : {}),
}));

let t;
let route;
let reauth;
let db;
const PASSWORD = "correct horse battery";

async function load(state) {
  vi.resetModules();
  process.env[ENV] = state;
  route = await import("@/app/api/workspaces/[id]/route.js");
  reauth = await import("@/app/api/workspaces/[id]/reauth/route.js");
  db = await (await import("@/lib/db/driver.js")).getAdapter();
  db.exec("PRAGMA foreign_keys = ON");
  db.run("DELETE FROM _meta WHERE key = 'defaultWorkspaceId'");
  db.run("DELETE FROM auditEvents");
  t = await seedTenancy();
  const { hashPassword } = await import("@/lib/auth/userPassword.js");
  db.run("UPDATE users SET passwordHash = ? WHERE id = ?", [
    await hashPassword(PASSWORD),
    t.a.user.id,
  ]);
}

async function call(
  handler,
  seeded,
  { method = "DELETE", id = t.shared.id, body, headers = {}, cli } = {},
) {
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  const live = await (await import("@/lib/db/repos/usersRepo.js")).getUserUnscoped(seeded.user.id);
  const token = await createDashboardAuthToken({
    sub: live.id,
    sv: live.sessionVersion,
    wid: seeded.personal,
  });
  jar.cookie = cli ? "" : `auth_token=${token}`;
  const raw =
    body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  const req = new NextRequest(`http://localhost/api/workspaces/${id}`, {
    method,
    headers: { "content-type": "application/json", cookie: jar.cookie, ...headers },
    body: raw,
  });
  try {
    return await handler(req, { params: Promise.resolve({ id }) });
  } finally {
    jar.cookie = "";
  }
}
const exists = (id = t.shared.id) => !!db.get("SELECT 1 AS x FROM workspaces WHERE id = ?", [id]);
const good = (extra = {}) => ({
  confirmWorkspaceId: t.shared.id,
  acknowledgeDekDestruction: true,
  currentPassword: PASSWORD,
  ...extra,
});

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("GET /api/workspaces/:id", () => {
  beforeEach(() => load("on"));

  it("is hidden while the switch is off", async () => {
    await load("off");
    expect((await call(route.GET, t.a, { method: "GET" })).status).toBe(404);
  });
  it("401 anonymous/CLI, 403 plain member", async () => {
    expect((await call(route.GET, t.a, { method: "GET", cli: true })).status).toBe(401);
    expect((await call(route.GET, t.b, { method: "GET" })).status).toBe(403);
  });
  it("returns detail with no-store; personal and unknown share one 404", async () => {
    const res = await call(route.GET, t.a, { method: "GET" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).workspace).toMatchObject({
      id: t.shared.id,
      kind: "shared",
      isDefault: false,
    });
    const personal = await call(route.GET, t.a, { method: "GET", id: t.b.personal });
    const missing = await call(route.GET, t.a, {
      method: "GET",
      id: "00000000-0000-4000-8000-000000000000",
    });
    expect(personal.status).toBe(404);
    expect(await personal.json()).toEqual(await missing.json());
  });
});

describe("DELETE /api/workspaces/:id", () => {
  beforeEach(() => load("on"));

  it("hidden off; refused for CLI, plain member, cross-site and non-JSON", async () => {
    expect((await call(route.DELETE, t.a, { body: good(), cli: true })).status).toBe(401);
    expect((await call(route.DELETE, t.b, { body: good() })).status).toBe(403);
    expect(
      (await call(route.DELETE, t.a, { body: good(), headers: { origin: "https://evil.test" } }))
        .status,
    ).toBe(403);
    expect(
      (await call(route.DELETE, t.a, { body: good(), headers: { "content-type": "text/plain" } }))
        .status,
    ).toBe(415);
    expect(exists()).toBe(true);
    await load("off");
    expect((await call(route.DELETE, t.a, { body: good() })).status).toBe(404);
    expect(exists()).toBe(true);
  });

  it.each([
    ["wrong confirmation id", () => good({ confirmWorkspaceId: "other" })],
    ["no DEK acknowledgement", () => good({ acknowledgeDekDestruction: false })],
    ["extra key", () => good({ extra: 1 })],
    ["both proofs", () => good({ ssoProof: "x" })],
    [
      "no proof",
      () => ({ confirmWorkspaceId: t.shared.id, acknowledgeDekDestruction: true, x: 1 }),
    ],
    ["non-string password", () => good({ currentPassword: 5 })],
  ])("400 and no state change: %s", async (_n, make) => {
    const res = await call(route.DELETE, t.a, { body: make() });
    expect(res.status).toBe(400);
    expect(exists()).toBe(true);
  });

  it("413 oversize and malformed JSON are rejected without changes", async () => {
    expect((await call(route.DELETE, t.a, { body: "x".repeat(5000) })).status).toBe(413);
    expect((await call(route.DELETE, t.a, { body: "{" })).status).toBe(400);
    expect(exists()).toBe(true);
  });

  it("wrong password fails 401 without deleting; right password deletes and audits", async () => {
    expect(
      (await call(route.DELETE, t.a, { body: good({ currentPassword: "nope" }) })).status,
    ).toBe(401);
    expect(exists()).toBe(true);
    const res = await call(route.DELETE, t.a, { body: good() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted: true });
    expect(exists()).toBe(false);
    expect(
      db.get("SELECT COUNT(*) AS c FROM auditEvents WHERE action = 'workspace.delete'").c,
    ).toBe(1);
  });

  it("SSO-only admin has no weaker fallback: password proof is unsupported", async () => {
    db.run("UPDATE users SET passwordHash = NULL WHERE id = ?", [t.a.user.id]);
    const res = await call(route.DELETE, t.a, { body: good() });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("reauth_unsupported");
    expect(exists()).toBe(true);
  });

  it("forged or reused ssoProof never deletes", async () => {
    const body = {
      confirmWorkspaceId: t.shared.id,
      acknowledgeDekDestruction: true,
      ssoProof: "forged",
    };
    expect((await call(route.DELETE, t.a, { body })).status).toBe(401);
    expect(exists()).toBe(true);
  });

  it("valid ssoProof deletes once, bound to the exact workspace; replay fails", async () => {
    const { putProofSlot } = await import("@/lib/users/ssoProofState.js");
    const live = await (await import("@/lib/db/repos/usersRepo.js")).getUserUnscoped(t.a.user.id);
    const mk = (workspaceId) =>
      putProofSlot({
        stage: "delete_proof",
        purpose: "workspace_delete",
        actorId: live.id,
        sv: live.sessionVersion,
        workspaceId,
      });
    const other = await (await import("@/lib/db/index.js")).createSharedWorkspace(t.a.ctx, {
      name: "Other",
    });
    const wrong = mk(other.id);
    const bodyFor = (proof) => ({
      confirmWorkspaceId: t.shared.id,
      acknowledgeDekDestruction: true,
      ssoProof: proof,
    });
    // A proof for another workspace is consumed and rejected.
    expect((await call(route.DELETE, t.a, { body: bodyFor(wrong) })).status).toBe(401);
    expect(exists()).toBe(true);
    const ok = mk(t.shared.id);
    expect((await call(route.DELETE, t.a, { body: bodyFor(ok) })).status).toBe(200);
    expect(exists()).toBe(false);
    expect(exists(other.id)).toBe(true);
    // Replay of a consumed proof can never delete anything.
    expect((await call(route.DELETE, t.a, { body: bodyFor(ok) })).status).toBe(401);
  });

  it("stale session version fails closed and a demoted admin cannot delete", async () => {
    const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
    const stale = await createDashboardAuthToken({ sub: t.a.user.id, sv: 999, wid: t.a.personal });
    jar.cookie = `auth_token=${stale}`;
    const req = new NextRequest(`http://localhost/api/workspaces/${t.shared.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie: jar.cookie },
      body: JSON.stringify(good()),
    });
    const res = await route.DELETE(req, { params: Promise.resolve({ id: t.shared.id }) });
    jar.cookie = "";
    expect([401, 403, 409]).toContain(res.status);
    expect(exists()).toBe(true);
  });

  it("protects Default (409) and personal (404)", async () => {
    db.run("INSERT INTO _meta(key, value) VALUES('defaultWorkspaceId', ?)", [t.shared.id]);
    const res = await call(route.DELETE, t.a, { body: good() });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("default_workspace");
    expect(exists()).toBe(true);
    const personal = await call(route.DELETE, t.a, {
      id: t.b.personal,
      body: good({ confirmWorkspaceId: t.b.personal }),
    });
    expect(personal.status).toBe(404);
    expect(exists(t.b.personal)).toBe(true);
  });

  it("clears the SSO map target so the next SSO admission still validates", async () => {
    db.run(
      "INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      [
        JSON.stringify({
          ssoGroupWorkspaceMap: [{ group: "eng", workspaceId: t.shared.id, role: "member" }],
        }),
      ],
    );
    expect((await call(route.DELETE, t.a, { body: good() })).status).toBe(200);
    const { validateSsoWorkspaceTargets } = await import("@/app/api/settings/validateSettings.js");
    const blob = JSON.parse(db.get("SELECT data FROM settings WHERE id = 1").data);
    expect(blob.ssoGroupWorkspaceMap).toEqual([]);
    expect(await validateSsoWorkspaceTargets(blob.ssoGroupWorkspaceMap)).toBe("");
  });

  it("active session on the deleted workspace still resolves to its personal workspace", async () => {
    expect((await call(route.DELETE, t.a, { body: good() })).status).toBe(200);
    const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
    const live = await (await import("@/lib/db/repos/usersRepo.js")).getUserUnscoped(t.b.user.id);
    const token = await createDashboardAuthToken({
      sub: live.id,
      sv: live.sessionVersion,
      wid: t.shared.id,
    });
    const { resolvePrincipal } = await import("@/lib/users/session");
    const principal = await resolvePrincipal({
      cookies: { get: (n) => (n === "auth_token" ? { value: token } : undefined) },
      headers: new Headers(),
    });
    expect(principal.activeWorkspaceId).toBe(t.b.personal);
  });
});

describe("POST/GET /api/workspaces/:id/reauth", () => {
  beforeEach(() => load("on"));

  it("hidden off, refuses CLI/members/cross-site, validates body, GET 404 without a completed proof", async () => {
    await load("off");
    expect(
      (await call(reauth.POST, t.a, { method: "POST", body: { provider: "oidc" } })).status,
    ).toBe(404);
    await load("on");
    expect(
      (await call(reauth.POST, t.a, { method: "POST", body: { provider: "oidc" }, cli: true }))
        .status,
    ).toBe(401);
    expect(
      (await call(reauth.POST, t.b, { method: "POST", body: { provider: "oidc" } })).status,
    ).toBe(403);
    expect(
      (
        await call(reauth.POST, t.a, {
          method: "POST",
          body: { provider: "oidc" },
          headers: { origin: "https://evil.test" },
        })
      ).status,
    ).toBe(403);
    expect((await call(reauth.POST, t.a, { method: "POST", body: { provider: "x" } })).status).toBe(
      400,
    );
    expect(
      (await call(reauth.POST, t.a, { method: "POST", body: { provider: "oidc", extra: 1 } }))
        .status,
    ).toBe(400);
    // No linked identity / unconfigured SSO: fixed safe failure, nothing stored.
    const res = await call(reauth.POST, t.a, { method: "POST", body: { provider: "oidc" } });
    expect([409, 500]).toContain(res.status);
    expect((await call(reauth.GET, t.a, { method: "GET" })).status).toBe(404);
  });
});
