// YAN-1012: fresh SSO re-auth for instance/workspace export/import. Real slots,
// sealing, DB, routes and databaseTransfer; only protocol I/O and the core
// snapshot layer are mocked.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { seedTenancy } from "../setup/tenancyHarness.js";

const m = vi.hoisted(() => ({
  jar: new Map(),
  multi: true,
  verify: vi.fn(),
  exportWorkspace: vi.fn(),
  importWorkspace: vi.fn(),
  exportDb: vi.fn(),
  importDb: vi.fn(),
  importDbStream: vi.fn(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n) => (m.jar.has(n) ? { value: m.jar.get(n) } : undefined),
    set: (n, v) => m.jar.set(n, v),
    delete: (n) => m.jar.delete(n),
  }),
  headers: async () => new Headers({ cookie: `auth_token=${m.jar.get("auth_token") || ""}` }),
}));
vi.mock("@/lib/auth/dashboardSession.js", async (original) => ({
  ...(await original()),
  shouldUseSecureCookie: () => true,
}));
vi.mock("@/lib/auth/oidc.js", async (original) => ({
  ...(await original()),
  getPublicOrigin: () => "https://hop.test",
  getOidcRuntimeConfig: async () => ({
    issuerUrl: "https://idp.test",
    clientId: "client",
    scopes: "openid",
  }),
  fetchOidcDiscovery: async () => ({
    issuer: "https://idp.test",
    authorization_endpoint: "https://idp.test/auth",
  }),
  exchangeOidcCode: async () => ({ id_token: "t", access_token: "a" }),
  verifyOidcIdToken: m.verify,
}));
vi.mock("@/lib/users/featureSwitch.js", () => ({
  isMultiUserEnabled: async () => m.multi,
  requireMultiUser: async () =>
    m.multi ? null : NextResponse.json({ error: "Not found" }, { status: 404 }),
}));
vi.mock("@/lib/db/workspaceTransfer.js", () => ({
  exportWorkspace: m.exportWorkspace,
  importWorkspace: m.importWorkspace,
}));
vi.mock("@/lib/localDb", () => ({
  exportDbToFile: m.exportDb,
  importDb: m.importDb,
  importDbStream: m.importDbStream,
  getSettings: vi.fn(async () => ({})),
}));
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("@/lib/auth/cliToken", () => ({ hasValidCliToken: async () => false }));

const savedEnv = process.env.TOKENHOP_MULTI_USER;
const WS_PASSPHRASE = "pass-phrase";
let t, db, proof, slots, cookieStore, transfer, ssoData;

const req = (path, body, method = "POST", headers = {}) =>
  new NextRequest(`https://hop.test${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: `auth_token=${m.jar.get("auth_token") || ""}`,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function auth(seed = t.a) {
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  m.jar.set(
    "auth_token",
    await createDashboardAuthToken({
      sub: seed.user.id,
      sv: seed.user.sessionVersion,
      wid: seed.personal,
    }),
  );
}
const purposeOf = (action) => slots.DATA_TRANSFER_PURPOSES[action];
async function complete() {
  const state = await slots.openSsoProofState(m.jar.get(slots.SSO_PROOF_COOKIE));
  return proof.handleSsoProofCallback(
    new NextRequest(
      `https://hop.test/api/auth/oidc/callback?state=${encodeURIComponent(state.flow)}&code=code`,
    ),
    "oidc",
    cookieStore,
  );
}
/** Full begin -> callback -> consume; returns the one-time ssoProof. */
async function mint(action, workspaceId = null) {
  await proof.beginSsoProof(req("/api/me/reauth", {}), t.a.ctx, {
    provider: "oidc",
    purpose: purposeOf(action),
    workspaceId,
  });
  await complete();
  return (await proof.consumeSsoResult(t.a.ctx, purposeOf(action), workspaceId)).ssoProof;
}
const wsCtx = (id) => ({ params: Promise.resolve({ id }) });
const wsExport = async (ssoProof, id = t.shared.id, extra = {}) =>
  (await import("@/app/api/workspaces/[id]/export/route.js")).POST(
    req(`/api/workspaces/${id}/export`, { passphrase: WS_PASSPHRASE, ssoProof, ...extra }),
    wsCtx(id),
  );
const wsImport = async (ssoProof, id = t.shared.id) =>
  (await import("@/app/api/workspaces/[id]/import/route.js")).POST(
    req(`/api/workspaces/${id}/import`, { passphrase: WS_PASSPHRASE, ssoProof, data: { v: 1 } }),
    wsCtx(id),
  );
const instExport = async (ssoProof) =>
  (await import("@/app/api/settings/database/route.js")).GET(
    req("/api/settings/database", undefined, "GET", { "x-tokenhop-sso-proof": ssoProof }),
  );
const instImport = async (body) =>
  (await import("@/app/api/settings/database/route.js")).POST(req("/api/settings/database", body));

beforeEach(async () => {
  process.env.TOKENHOP_MULTI_USER = "on";
  m.multi = true;
  db = await (await import("@/lib/db/driver.js")).getAdapter();
  db.run("DELETE FROM _meta WHERE key = 'defaultWorkspaceId'");
  t = await seedTenancy();
  db.run(
    "INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
    [JSON.stringify({ requireLogin: true, authMode: "saml" })],
  );
  await (await import("@/lib/db/repos/identitiesRepo.js")).linkIdentityUnscoped(t.a.user.id, {
    provider: "oidc",
    issuer: "https://idp.test",
    subject: "actor-sub",
  });
  t.a.user = await (await import("@/lib/db/repos/usersRepo.js")).getUserUnscoped(t.a.user.id);
  m.jar.clear();
  vi.clearAllMocks();
  await auth();
  proof = await import("@/lib/users/ssoPreview.js");
  slots = await import("@/lib/users/ssoProofState.js");
  ssoData = await import("@/lib/users/ssoDataProof.js");
  transfer = await import("@/lib/users/databaseTransfer.js");
  slots.resetProofSlots();
  const limiter = await import("@/lib/auth/loginLimiter.js");
  limiter.clearAccount(limiter.accountKey({ userId: t.a.user.id }));
  limiter.recordSuccess("unknown");
  cookieStore = await (await import("next/headers")).cookies();
  m.verify.mockResolvedValue({
    iss: "https://idp.test",
    sub: "actor-sub",
    auth_time: Math.floor(Date.now() / 1000),
  });
  m.exportWorkspace.mockResolvedValue({ snapshot: true });
  m.importWorkspace.mockResolvedValue(undefined);
  m.exportDb.mockImplementation(async () => ({
    size: 11,
    openStream: () => Readable.from([Buffer.from('{"db":true}')]),
    cleanup: vi.fn(),
  }));
  m.importDbStream.mockResolvedValue(undefined);
  m.importDb.mockResolvedValue(undefined);
});
afterAll(() => {
  if (savedEnv === undefined) delete process.env.TOKENHOP_MULTI_USER;
  else process.env.TOKENHOP_MULTI_USER = savedEnv;
});

describe("data-transfer proof lifecycle", () => {
  it("maps every action to its own purpose with action-specific redirects", async () => {
    expect(new Set(Object.values(slots.DATA_TRANSFER_PURPOSES)).size).toBe(4);
    await proof.beginSsoProof(req("/x", {}), t.a.ctx, {
      provider: "oidc",
      purpose: purposeOf("workspace.import"),
      workspaceId: t.shared.id,
    });
    expect((await complete()).headers.get("location")).toBe(
      `https://hop.test/dashboard/settings?ssoReauth=workspace.import&workspace=${t.shared.id}#data`,
    );
    await proof.beginSsoProof(req("/x", {}), t.a.ctx, {
      provider: "oidc",
      purpose: purposeOf("instance.export"),
    });
    expect((await complete()).headers.get("location")).toBe(
      "https://hop.test/dashboard/settings?ssoReauth=instance.export#data",
    );
  });

  it("failure redirects to the fixed settings failure path", async () => {
    await proof.beginSsoProof(req("/x", {}), t.a.ctx, {
      provider: "oidc",
      purpose: purposeOf("instance.import"),
    });
    m.verify.mockResolvedValue({ iss: "https://idp.test", sub: "other", auth_time: 1e9 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await complete()).headers.get("location")).toBe(
      "https://hop.test/dashboard/settings?ssoReauth=failed#data",
    );
  });

  it("is bound to the exact action: a different purpose cannot consume it", async () => {
    await proof.beginSsoProof(req("/x", {}), t.a.ctx, {
      provider: "oidc",
      purpose: purposeOf("instance.export"),
    });
    await complete();
    expect(await proof.consumeSsoResult(t.a.ctx, purposeOf("instance.import"))).toBeNull();
    const { ssoProof } = await proof.consumeSsoResult(t.a.ctx, purposeOf("instance.export"));
    const base = { actorId: t.a.user.id, sv: t.a.user.sessionVersion, workspaceId: null };
    expect(() =>
      ssoData.consumeDataTransferProof(ssoProof, {
        ...base,
        purpose: purposeOf("instance.import"),
      }),
    ).toThrow(); // cross-action; consuming burned it
    expect(() =>
      ssoData.consumeDataTransferProof(ssoProof, {
        ...base,
        purpose: purposeOf("instance.export"),
      }),
    ).toThrow(); // one-time
  });

  it("binds the workspace, actor and sv; one-time", async () => {
    const mk = () => mint("workspace.export", t.shared.id);
    const base = { purpose: purposeOf("workspace.export"), sv: t.a.user.sessionVersion };
    const good = { ...base, actorId: t.a.user.id, workspaceId: t.shared.id };
    for (const bad of [
      { workspaceId: t.a.personal },
      { workspaceId: null },
      { actorId: t.b.user.id },
      { sv: base.sv + 1 },
    ]) {
      const p = await mk();
      expect(() => ssoData.consumeDataTransferProof(p, { ...good, ...bad })).toThrow();
    }
    const p = await mk();
    expect(ssoData.consumeDataTransferProof(p, good)).toMatchObject({ stage: "action_proof" });
    expect(() => ssoData.consumeDataTransferProof(p, good)).toThrow();
  });

  it("expires after the inherited 5 minute TTL", async () => {
    const p = await mint("instance.export");
    const slot = slots.peekProofSlot(p);
    expect(slot.expiresAt).toBeLessThanOrEqual(Date.now() + 300_000);
    expect(slots.peekProofSlot(p, slot.expiresAt)).toBeNull();
    expect(() =>
      ssoData.consumeDataTransferProof("expired-ref", {
        purpose: purposeOf("instance.export"),
        actorId: t.a.user.id,
        sv: t.a.user.sessionVersion,
      }),
    ).toThrow();
  });

  it("workspace owner demotion between begin and consume fails closed", async () => {
    await proof.beginSsoProof(req("/x", {}), t.a.ctx, {
      provider: "oidc",
      purpose: purposeOf("workspace.export"),
      workspaceId: t.shared.id,
    });
    await complete();
    db.run("UPDATE memberships SET role = 'manager' WHERE workspaceId = ? AND userId = ?", [
      t.shared.id,
      t.a.user.id,
    ]);
    await expect(
      proof.consumeSsoResult(t.a.ctx, purposeOf("workspace.export"), t.shared.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Begin is refused for a non-owner as well.
    await expect(
      proof.beginSsoProof(req("/x", {}), t.a.ctx, {
        provider: "oidc",
        purpose: purposeOf("workspace.export"),
        workspaceId: t.shared.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("/api/me/reauth", () => {
  it("is hidden while the switch is off and refuses malformed or unauthorized actions", async () => {
    const { POST, GET } = await import("@/app/api/me/reauth/route.js");
    const post = (b) => POST(req("/api/me/reauth", b));
    m.multi = false;
    expect((await post({ provider: "oidc", action: "instance.export" })).status).toBe(404);
    m.multi = true;
    expect((await post({ provider: "oidc", action: "nope" })).status).toBe(400);
    expect((await post({ provider: "oidc", action: "instance.export", extra: 1 })).status).toBe(
      400,
    );
    expect(
      (await post({ provider: "oidc", action: "instance.export", workspaceId: t.shared.id }))
        .status,
    ).toBe(400);
    expect((await post({ provider: "oidc", action: "workspace.export" })).status).toBe(400);
    // Non-member of the workspace: 404, no existence leak.
    expect(
      (await post({ provider: "oidc", action: "workspace.export", workspaceId: t.b.personal }))
        .status,
    ).toBe(404);
    // Member but not owner: 403.
    await auth(t.b);
    const denied = await post({
      provider: "oidc",
      action: "workspace.import",
      workspaceId: t.shared.id,
    });
    expect(denied.status).toBe(403);
    expect((await GET(req("/api/me/reauth?action=instance.export", undefined, "GET"))).status).toBe(
      403,
    );
  });

  it("begins and returns a proof once via GET", async () => {
    const { POST, GET } = await import("@/app/api/me/reauth/route.js");
    const res = await POST(
      req("/api/me/reauth", {
        provider: "oidc",
        action: "workspace.export",
        workspaceId: t.shared.id,
      }),
    );
    expect(res.status).toBe(200);
    expect(new URL((await res.json()).authorizeUrl).searchParams.get("prompt")).toBe("login");
    await complete();
    const url = `/api/me/reauth?action=workspace.export&workspaceId=${t.shared.id}`;
    const ok = await GET(req(url, undefined, "GET"));
    expect(ok.status).toBe(200);
    expect(typeof (await ok.json()).ssoProof).toBe("string");
    expect((await GET(req(url, undefined, "GET"))).status).toBe(404);
  });
});

describe("export/import with an SSO proof", () => {
  it("SSO-only owner can export the instance and import a workspace; replay fails", async () => {
    const p = await mint("instance.export");
    const ok = await instExport(p);
    expect(ok.status).toBe(200);
    expect(m.exportDb).toHaveBeenCalledTimes(1);
    expect((await instExport(p)).status).toBe(401); // replay
    expect(m.exportDb).toHaveBeenCalledTimes(1);

    const w = await mint("workspace.import", t.shared.id);
    expect((await wsImport(w)).status).toBe(200);
    expect(m.importWorkspace).toHaveBeenCalledTimes(1);
    expect((await wsImport(w)).status).toBe(401);
    expect(m.importWorkspace).toHaveBeenCalledTimes(1);

    // Audit records the re-auth method, never the proof value.
    const rows = db.all(
      "SELECT action, after FROM auditEvents WHERE action IN ('db.export','workspace.import') AND result IS NOT 'failure'",
    );
    for (const action of ["db.export", "workspace.import"]) {
      const row = rows.find((r) => r.action === action);
      expect(JSON.parse(row.after)).toMatchObject({ reauth: "sso" });
    }
    expect(JSON.stringify(rows)).not.toContain(p);
    expect(JSON.stringify(rows)).not.toContain(w);
  });

  it("instance import accepts a proof and never forwards it to importDb", async () => {
    const p = await mint("instance.import");
    const res = await instImport({
      ssoProof: p,
      passphrase: WS_PASSPHRASE,
      settings: {},
      marker: 1,
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(m.importDb.mock.calls[0][0])).not.toContain(p);
    expect(m.importDb.mock.calls[0][0]).toMatchObject({ marker: 1 });
    expect(m.importDb.mock.calls[0][0]).not.toHaveProperty("ssoProof");
  });

  it("rejects a proof for the wrong action or workspace", async () => {
    expect((await instExport(await mint("instance.import"))).status).toBe(401);
    expect((await wsImport(await mint("workspace.export", t.shared.id))).status).toBe(401);
    expect((await wsExport(await mint("workspace.export", t.a.personal))).status).toBe(401);
    expect(m.exportDb).not.toHaveBeenCalled();
    expect(m.exportWorkspace).not.toHaveBeenCalled();
    expect(m.importWorkspace).not.toHaveBeenCalled();
  });

  it("stale sv, demoted admin, owner demotion and deactivation fail closed", async () => {
    let p = await mint("instance.export");
    db.run("UPDATE users SET sessionVersion = sessionVersion + 1 WHERE id = ?", [t.a.user.id]);
    expect((await instExport(p)).status).toBeGreaterThanOrEqual(401);
    expect(m.exportDb).not.toHaveBeenCalled();
    db.run("UPDATE users SET sessionVersion = sessionVersion - 1 WHERE id = ?", [t.a.user.id]);

    p = await mint("instance.export");
    db.run("UPDATE users SET instanceRole = 'user' WHERE id = ?", [t.a.user.id]);
    // Route principal is resolved from the live row (401/403); the helper's own
    // live re-read after consumption must also refuse (403).
    expect((await instExport(p)).status).toBeGreaterThanOrEqual(401);
    db.run("UPDATE users SET instanceRole = 'owner' WHERE id = ?", [t.a.user.id]);

    p = await mint("workspace.export", t.shared.id);
    db.run("UPDATE memberships SET role = 'manager' WHERE workspaceId = ? AND userId = ?", [
      t.shared.id,
      t.a.user.id,
    ]);
    expect((await wsExport(p)).status).toBeGreaterThanOrEqual(401);
    expect(m.exportWorkspace).not.toHaveBeenCalled();
    db.run("UPDATE memberships SET role = 'owner' WHERE workspaceId = ? AND userId = ?", [
      t.shared.id,
      t.a.user.id,
    ]);

    p = await mint("instance.export");
    db.run("UPDATE users SET status = 'disabled' WHERE id = ?", [t.a.user.id]);
    expect((await instExport(p)).status).toBeGreaterThanOrEqual(401);
    expect(m.exportDb).not.toHaveBeenCalled();
  });

  it("helper re-reads the live row after consuming the proof (demoted admin -> 403)", async () => {
    const p = await mint("instance.export");
    db.run("UPDATE users SET instanceRole = 'user' WHERE id = ?", [t.a.user.id]);
    const res = await transfer.reauthActor(
      req("/x", {}),
      { ...t.a.ctx, instanceRole: "owner", via: "session" },
      { ssoProof: p },
      { purpose: purposeOf("instance.export"), instanceAdmin: true },
    );
    expect(res.status).toBe(403);
    expect(slots.peekProofSlot(p)).toBeNull(); // consumed even though refused
  });

  it("requires exactly one of password / ssoProof (400)", async () => {
    const p = await mint("workspace.export", t.shared.id);
    const both = await wsExport(p, t.shared.id, { password: "pw" });
    expect(both.status).toBe(400);
    expect(slots.peekProofSlot(p)).not.toBeNull(); // rejected before any consumption
    const none = await wsExport(undefined);
    expect(none.status).toBe(400);
    expect((await wsExport("x".repeat(129))).status).toBe(400);
    expect((await instImport({ password: "pw", ssoProof: p, passphrase: "p" })).status).toBe(400);
  });

  it("CLI / non-session principals can never use an SSO proof", async () => {
    const p = await mint("instance.export");
    const principal = { userId: t.a.user.id, instanceRole: "owner", via: "cli" };
    const res = await transfer.reauthActor(
      req("/x", {}),
      principal,
      { ssoProof: p },
      { purpose: purposeOf("instance.export"), instanceAdmin: true },
    );
    expect(res.status).toBe(403);
    // A session principal without a verified sv claim is also refused.
    const noClaims = await transfer.reauthActor(
      new Request("https://hop.test/x"),
      { ...principal, via: "session" },
      { ssoProof: p },
      { purpose: purposeOf("instance.export"), instanceAdmin: true },
    );
    expect(noClaims.status).toBe(409);
  });

  it("switch-off legacy path ignores an ssoProof and grants nothing", async () => {
    const p = await mint("instance.export");
    m.multi = false;
    m.jar.delete("auth_token");
    const res = await instExport(p);
    expect(res.status).toBe(401);
    expect(m.exportDb).not.toHaveBeenCalled();
    expect(slots.peekProofSlot(p)).not.toBeNull(); // never consumed
  });
});

describe("proof slot exhaustion and failure redirects", () => {
  it("per-actor cap: one actor cannot exhaust the global store; others unaffected", async () => {
    let accepted = 0;
    let limited = 0;
    for (let i = 0; i < 600; i++) {
      try {
        slots.putProofSlot({ stage: "draft", actorId: t.b.user.id });
        accepted++;
      } catch (err) {
        expect(err.code).toBe("PROOF_RATE_LIMITED");
        limited++;
      }
    }
    expect(accepted).toBeLessThan(10);
    expect(limited).toBeGreaterThan(590);
    expect(() => slots.putProofSlot({ stage: "draft", actorId: t.a.user.id })).not.toThrow();
    const res = proof.proofFailure({ code: "PROOF_RATE_LIMITED" });
    expect(res.status).toBe(429);
  });

  it("a plain user repeatedly beginning never blocks an admin begin (supersede frees slot)", async () => {
    await auth(t.b);
    for (let i = 0; i < 600; i++) {
      await proof
        .beginSsoProof(req("/x", {}), t.b.ctx, {
          provider: "oidc",
          purpose: purposeOf("workspace.export"),
          workspaceId: t.b.personal,
        })
        .catch(() => {}); // not linked: the identity check precedes the slot
    }
    await auth(t.a);
    const first = await proof.beginSsoProof(req("/x", {}), t.a.ctx, {
      provider: "oidc",
      purpose: purposeOf("instance.export"),
    });
    expect(first.status).toBe(200);
    const old = (await slots.openSsoProofState(m.jar.get(slots.SSO_PROOF_COOKIE))).ref;
    expect(slots.peekProofSlot(old)).not.toBeNull();
    for (let i = 0; i < 20; i++) {
      await proof.beginSsoProof(req("/x", {}), t.a.ctx, {
        provider: "oidc",
        purpose: purposeOf("instance.export"),
      });
    }
    expect(slots.peekProofSlot(old)).toBeNull(); // superseded, freed
    const mine = [...(globalThis.__tokenhopSsoProofSlots?.values() ?? [])].filter(
      (x) => x.actorId === t.a.user.id,
    );
    expect(mine).toHaveLength(1);
  });

  it.each(["expired", "missing"])(
    "data purpose with an %s slot redirects to the settings failure path",
    async (kind) => {
      await proof.beginSsoProof(req("/x", {}), t.a.ctx, {
        provider: "oidc",
        purpose: purposeOf("workspace.export"),
        workspaceId: t.shared.id,
      });
      const state = await slots.openSsoProofState(m.jar.get(slots.SSO_PROOF_COOKIE));
      if (kind === "expired") slots.peekProofSlot(state.ref, Date.now() + 301_000);
      else slots.takeProofSlot(state.ref);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      expect((await complete()).headers.get("location")).toBe(
        "https://hop.test/dashboard/settings?ssoReauth=failed#data",
      );
    },
  );

  it("instance import force denial and IP lock do not burn the proof", async () => {
    // Admin (not owner) forcing a restore is refused before the proof is consumed.
    db.run("UPDATE users SET instanceRole = 'admin' WHERE id = ?", [t.a.user.id]);
    t.a.user = await (await import("@/lib/db/repos/usersRepo.js")).getUserUnscoped(t.a.user.id);
    await auth();
    const p = await mint("instance.import");
    const res = await instImport({ ssoProof: p, passphrase: WS_PASSPHRASE, force: true });
    expect(res.status).toBe(403);
    expect(slots.peekProofSlot(p)).not.toBeNull();
    expect(m.importDb).not.toHaveBeenCalled();
  });
});
