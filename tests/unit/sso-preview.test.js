// YAN-373 fresh SSO proof flows: real slots/sealing/DB; protocol I/O mocked.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { seedTenancy } from "../setup/tenancyHarness.js";

const m = vi.hoisted(() => ({
  jar: new Map(),
  options: new Map(),
  verify: vi.fn(),
  info: vi.fn(),
  saml: vi.fn(),
  fresh: vi.fn(),
  admit: vi.fn(),
  mint: vi.fn(),
  secure: true,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n) => (m.jar.has(n) ? { value: m.jar.get(n) } : undefined),
    set: (n, v, opts) => {
      m.jar.set(n, v);
      m.options.set(n, opts);
    },
    delete: (n) => m.jar.delete(n),
  }),
  headers: async () => new Headers({ cookie: `auth_token=${m.jar.get("auth_token") || ""}` }),
}));
vi.mock("@/lib/auth/dashboardSession.js", async (original) => ({
  ...(await original()),
  shouldUseSecureCookie: () => m.secure,
  setDashboardAuthCookie: m.mint,
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
    userinfo_endpoint: "https://idp.test/info",
  }),
  exchangeOidcCode: async () => ({ id_token: "secret-token", access_token: "secret-access" }),
  verifyOidcIdToken: m.verify,
  fetchOidcUserInfo: m.info,
}));
vi.mock("@/lib/auth/saml.js", async (original) => ({
  ...(await original()),
  getSamlBaseUrl: () => "https://hop.test",
  isSamlConfigured: () => true,
  buildSamlReauthAuthorizeUrl: async () => ({
    authorizeUrl: "https://saml.test/auth",
    requestId: "req-id",
  }),
  validateSamlResponse: m.saml,
  verifyFreshSamlAuthnInstant: m.fresh,
}));
vi.mock("@/lib/users/ssoProvisioning.js", async (original) => ({
  ...(await original()),
  ssoAdmit: m.admit,
}));

const savedEnv = process.env.TOKENHOP_MULTI_USER;
let t, db, proof, slots, cookieStore;
const req = (path, body, method = "POST") =>
  new NextRequest(`https://hop.test${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: `auth_token=${m.jar.get("auth_token") || ""}`,
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
async function start(provider = "oidc", policy) {
  return proof.beginSsoProof(req("/api/auth/sso/preview", {}), t.a.ctx, { provider, policy });
}
async function complete(provider = "oidc", flow = null) {
  const state = await slots.openSsoProofState(m.jar.get(slots.SSO_PROOF_COOKIE));
  flow ??= state.flow;
  const r =
    provider === "oidc"
      ? new NextRequest(
          `https://hop.test/api/auth/oidc/callback?state=${encodeURIComponent(flow)}&code=code`,
        )
      : new NextRequest("https://hop.test/api/auth/saml/acs", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ RelayState: flow, SAMLResponse: "signed-response" }),
        });
  return proof.handleSsoProofCallback(r, provider, cookieStore, {
    authMode: "saml",
    samlEntryPoint: "https://saml.test/auth",
    samlCert: "cert",
  });
}

beforeEach(async () => {
  process.env.TOKENHOP_MULTI_USER = "on";
  db = await (await import("@/lib/db/driver.js")).getAdapter();
  db.run("DELETE FROM _meta WHERE key = 'defaultWorkspaceId'");
  t = await seedTenancy();
  db.run(
    "INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
    [
      JSON.stringify({
        requireLogin: true,
        authMode: "saml",
        ssoGroupsClaim: "groups",
        samlAttributeGroups: "groups",
        ssoAllowedGroups: [],
        ssoAdminGroups: ["admins"],
        ssoDefaultRole: "pending",
        ssoGroupWorkspaceMap: [],
      }),
    ],
  );
  for (const [provider, issuer] of [
    ["oidc", "https://idp.test"],
    ["saml", "https://saml.test"],
  ]) {
    await (await import("@/lib/db/repos/identitiesRepo.js")).linkIdentityUnscoped(t.a.user.id, {
      provider,
      issuer,
      subject: "actor-sub",
    });
  }
  // Linking bumps sv; fresh session binds updated version.
  t.a.user = await (await import("@/lib/db/repos/usersRepo.js")).getUserUnscoped(t.a.user.id);
  m.jar.clear();
  m.options.clear();
  m.secure = true;
  vi.clearAllMocks();
  await auth();
  proof = await import("@/lib/users/ssoPreview.js");
  slots = await import("@/lib/users/ssoProofState.js");
  slots.resetProofSlots();
  const limiter = await import("@/lib/auth/loginLimiter.js");
  limiter.clearAccount(limiter.accountKey({ userId: t.a.user.id }));
  limiter.recordSuccess("unknown");
  cookieStore = await (await import("next/headers")).cookies();
  m.verify.mockResolvedValue({
    iss: "https://idp.test",
    sub: "actor-sub",
    auth_time: Math.floor(Date.now() / 1000),
    groups: ["admins", "eng"],
  });
  m.info.mockResolvedValue({ sub: "actor-sub", groups: ["eng"] });
  m.saml.mockResolvedValue({ issuer: "https://saml.test", nameID: "actor-sub", groups: ["eng"] });
  m.fresh.mockReturnValue({ authnInstant: Date.now() });
});
afterAll(() => {
  if (savedEnv === undefined) delete process.env.TOKENHOP_MULTI_USER;
  else process.env.TOKENHOP_MULTI_USER = savedEnv;
});

describe("SSO preview round trip", () => {
  it("forces fresh OIDC login, keeps 100 map entries and groups out of cookie, consumes result once, no writes", async () => {
    const policy = {
      ssoGroupWorkspaceMap: Array.from({ length: 100 }, (_, i) => ({
        group: `group-${i}`,
        workspaceId: t.shared.id,
        role: "member",
      })),
    };
    const res = await start("oidc", policy);
    const url = new URL((await res.json()).authorizeUrl);
    expect(url.searchParams.get("prompt")).toBe("login");
    expect(url.searchParams.get("max_age")).toBe("0");
    const cookie = m.jar.get(slots.SSO_PROOF_COOKIE);
    expect(cookie.length).toBeLessThan(1000);
    const state = await slots.openSsoProofState(cookie);
    expect(Object.keys(state)).not.toContain("policy");
    expect(Object.keys(state)).not.toContain("groups");
    expect(Object.keys(state)).not.toContain("subject");
    const before = db.all("SELECT * FROM users");
    const identities = db.all("SELECT * FROM identities");
    const memberships = db.all("SELECT * FROM memberships");
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cb = await complete();
    expect(cb.headers.get("location")).toBe("https://hop.test/dashboard/admin/sso?ssoPreview=1");
    const result = await proof.consumeSsoResult(t.a.ctx, "sso_preview");
    expect(result).toMatchObject({
      provider: "oidc",
      groupsSource: "id_token",
      groups: ["admins", "eng"],
      totalGroups: 2,
      admit: true,
      adminMatch: true,
      wouldProvisionRole: "admin",
    });
    expect(await proof.consumeSsoResult(t.a.ctx, "sso_preview")).toBeNull();
    expect(db.all("SELECT * FROM users")).toEqual(before);
    expect(db.all("SELECT * FROM identities")).toEqual(identities);
    expect(db.all("SELECT * FROM memberships")).toEqual(memberships);
    expect(m.admit).not.toHaveBeenCalled();
    expect(m.mint).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
  it("uses subject/issuer-checked UserInfo fallback, caps visible groups at 20", async () => {
    m.verify.mockResolvedValue({
      iss: "https://idp.test",
      sub: "actor-sub",
      auth_time: Math.floor(Date.now() / 1000),
    });
    m.info.mockResolvedValue({
      sub: "actor-sub",
      iss: "https://idp.test",
      groups: Array.from({ length: 30 }, (_, i) => `g${i}`),
    });
    await start();
    await complete();
    const result = await proof.consumeSsoResult(t.a.ctx, "sso_preview");
    expect(result.groupsSource).toBe("userinfo");
    expect(result.groups).toHaveLength(20);
    expect(result.totalGroups).toBe(30);
    expect(m.info).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSub: "actor-sub", expectedIssuer: "https://idp.test" }),
    );
  });
  it.each([
    "wrong_subject",
    "wrong_issuer",
    "missing_auth_time",
    "stale_auth_time",
    "future_auth_time",
    "userinfo_subject",
    "userinfo_issuer",
  ])("fails closed: %s", async (failure) => {
    const p = {
      iss: "https://idp.test",
      sub: "actor-sub",
      auth_time: Math.floor(Date.now() / 1000),
      groups: [],
    };
    if (failure === "wrong_subject") p.sub = "other";
    if (failure === "wrong_issuer") p.iss = "https://other.test";
    if (failure === "missing_auth_time") delete p.auth_time;
    if (failure === "stale_auth_time") p.auth_time -= 600;
    if (failure === "future_auth_time") p.auth_time += 600;
    if (failure.startsWith("userinfo")) {
      delete p.groups;
      m.info.mockResolvedValue({
        sub: failure === "userinfo_subject" ? "other" : "actor-sub",
        iss: failure === "userinfo_issuer" ? "wrong" : "https://idp.test",
        groups: [],
      });
    }
    m.verify.mockResolvedValue(p);
    await start();
    const cb = await complete();
    expect(cb.headers.get("location")).toBe(
      "https://hop.test/dashboard/admin/sso?ssoPreview=failed",
    );
    expect(await proof.consumeSsoResult(t.a.ctx, "sso_preview")).toBeNull();
    expect(m.admit).not.toHaveBeenCalled();
  });
  it("SAML uses Secure SameSite=None cookie and verified fresh assertion groups", async () => {
    const res = await start("saml");
    const state = await slots.openSsoProofState(m.jar.get(slots.SSO_PROOF_COOKIE));
    expect(new URL((await res.json()).authorizeUrl).searchParams.get("RelayState")).toBe(
      state.flow,
    );
    expect(m.options.get(slots.SSO_PROOF_COOKIE)).toMatchObject({
      secure: true,
      sameSite: "none",
      httpOnly: true,
    });
    // The cross-site ACS may not retain the begin hop's forwarding metadata.
    m.secure = false;
    const cb = await complete("saml");
    expect(cb.headers.get("location")).toContain("ssoPreview=1");
    expect(m.options.get(slots.SSO_PROOF_COOKIE)).toMatchObject({ secure: true, sameSite: "lax" });
    expect(m.saml).toHaveBeenCalledWith(
      expect.anything(),
      { SAMLResponse: "signed-response" },
      "req-id",
      expect.anything(),
    );
    expect(m.fresh).toHaveBeenCalled();
    expect(await proof.consumeSsoResult(t.a.ctx, "sso_preview")).toMatchObject({
      groupsSource: "saml_attribute",
      groups: ["eng"],
    });
  });
  it("SAML cannot start without secure cross-site proof cookie", async () => {
    m.secure = false;
    await expect(start("saml")).rejects.toMatchObject({ code: "SSO_UNAVAILABLE" });
  });
  it.each(["tamper", "missing", "expired", "actor_sv", "role", "wrong_purpose"])(
    "proof binding rejects %s",
    async (failure) => {
      await start();
      const cookie = m.jar.get(slots.SSO_PROOF_COOKIE);
      const state = await slots.openSsoProofState(cookie);
      if (failure === "tamper") m.jar.set(slots.SSO_PROOF_COOKIE, `${cookie}x`);
      if (failure === "missing") m.jar.delete(slots.SSO_PROOF_COOKIE);
      if (failure === "expired") slots.takeProofSlot(state.ref, Date.now() + 600_000);
      if (failure === "actor_sv")
        db.run("UPDATE users SET sessionVersion = sessionVersion + 1 WHERE id = ?", [t.a.user.id]);
      if (failure === "role")
        db.run("UPDATE users SET instanceRole = 'user' WHERE id = ?", [t.a.user.id]);
      if (failure === "wrong_purpose")
        m.jar.set(
          slots.SSO_PROOF_COOKIE,
          await slots.sealSsoProofState({ ...state, purpose: "workspace_delete" }),
        );
      const cb = await complete("oidc", state.flow);
      expect(cb.headers.get("location")).toBe(
        "https://hop.test/dashboard/admin/sso?ssoPreview=failed",
      );
      expect(m.admit).not.toHaveBeenCalled();
    },
  );
  it("normal flow never claimed by unrelated proof cookie", async () => {
    await start();
    expect(await complete("oidc", "normal-state")).toBeNull();
    expect(m.jar.has(slots.SSO_PROOF_COOKIE)).toBe(true);
  });
  it("requires exact linked identity, rejects draft secret/issuer config", async () => {
    await expect(start("oidc", { oidcClientSecret: "secret" })).rejects.toMatchObject({
      code: "INVALID",
    });
    db.run("DELETE FROM identities WHERE provider = 'oidc'");
    await expect(start()).rejects.toMatchObject({ code: "SSO_NOT_LINKED" });
  });
});

describe("workspace delete SSO proof purpose separation", () => {
  it("two concurrent reauth GETs issue exactly one delete proof", async () => {
    await proof.beginSsoProof(req("/api/workspaces/id/reauth", {}), t.a.ctx, {
      provider: "oidc",
      workspaceId: t.shared.id,
    });
    await complete();
    const { GET } = await import("@/app/api/workspaces/[id]/reauth/route.js");
    const responses = await Promise.all(
      Array.from({ length: 2 }, () =>
        GET(req(`/api/workspaces/${t.shared.id}/reauth`, undefined, "GET"), {
          params: Promise.resolve({ id: t.shared.id }),
        }),
      ),
    );
    expect(responses.map((res) => res.status).sort()).toEqual([200, 404]);
    const { ssoProof } = await responses.find((res) => res.status === 200).json();
    expect(
      proof.consumeWorkspaceDeleteProof(
        ssoProof,
        t.a.user.id,
        t.shared.id,
        t.a.user.sessionVersion,
      ),
    ).toMatchObject({ purpose: "workspace_delete", stage: "delete_proof" });
  });

  it("actor recheck failure burns the result slot", async () => {
    await proof.beginSsoProof(req("/api/workspaces/id/reauth", {}), t.a.ctx, {
      provider: "oidc",
      workspaceId: t.shared.id,
    });
    await complete();
    const state = await slots.openSsoProofState(m.jar.get(slots.SSO_PROOF_COOKIE));
    db.run("UPDATE users SET instanceRole = 'user' WHERE id = ?", [t.a.user.id]);
    await expect(
      proof.consumeSsoResult(t.a.ctx, "workspace_delete", t.shared.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(slots.peekProofSlot(state.ref)).toBeNull();
    db.run("UPDATE users SET instanceRole = 'owner' WHERE id = ?", [t.a.user.id]);
    expect(await proof.consumeSsoResult(t.a.ctx, "workspace_delete", t.shared.id)).toBeNull();
  });

  it.each(["oidc", "saml"])(
    "corrupt saved policy cannot block %s deletion reauth",
    async (provider) => {
      const settings = JSON.parse(db.get("SELECT data FROM settings WHERE id = 1").data);
      db.run("UPDATE settings SET data = ? WHERE id = 1", [
        JSON.stringify({
          ...settings,
          ssoGroupsClaim: "__proto__",
          ssoGroupWorkspaceMap: [{ group: "eng", workspaceId: "missing", role: "member" }],
        }),
      ]);
      const res = await proof.beginSsoProof(req("/api/workspaces/id/reauth", {}), t.a.ctx, {
        provider,
        workspaceId: t.shared.id,
      });
      expect(res.status).toBe(200);
      const state = await slots.openSsoProofState(m.jar.get(slots.SSO_PROOF_COOKIE));
      expect(slots.peekProofSlot(state.ref).policy).toBeNull();
      expect((await complete(provider)).headers.get("location")).toBe(
        `https://hop.test/dashboard/admin/workspaces/${t.shared.id}?ssoReauth=1`,
      );
      // Preview still rejects the invalid saved policy.
      await expect(start(provider)).rejects.toMatchObject({ code: "INVALID" });
    },
  );

  it.each(["oidc", "saml"])(
    "failed %s deletion returns to server-bound workspace, preserving auth_token",
    async (provider) => {
      await proof.beginSsoProof(req("/api/workspaces/id/reauth", {}), t.a.ctx, {
        provider,
        workspaceId: t.shared.id,
      });
      const authToken = m.jar.get("auth_token");
      if (provider === "oidc") m.verify.mockRejectedValue(new Error("provider_failure"));
      else m.saml.mockRejectedValue(new Error("provider_failure"));
      const cb = await complete(provider);
      expect(cb.headers.get("location")).toBe(
        `https://hop.test/dashboard/admin/workspaces/${t.shared.id}?ssoReauth=failed`,
      );
      expect(cb.headers.get("cache-control")).toBe("no-store");
      expect(cb.headers.get("referrer-policy")).toBe("no-referrer");
      expect(m.jar.get("auth_token")).toBe(authToken);
    },
  );

  it.each(["missing", "tamper", "expired"])(
    "%s deletion slot uses fixed failure surface, never request target",
    async (failure) => {
      await proof.beginSsoProof(req("/api/workspaces/id/reauth", {}), t.a.ctx, {
        provider: "oidc",
        workspaceId: t.shared.id,
      });
      const cookie = m.jar.get(slots.SSO_PROOF_COOKIE);
      const state = await slots.openSsoProofState(cookie);
      const authToken = m.jar.get("auth_token");
      if (failure === "missing") m.jar.delete(slots.SSO_PROOF_COOKIE);
      if (failure === "tamper") m.jar.set(slots.SSO_PROOF_COOKIE, `${cookie}x`);
      if (failure === "expired") slots.takeProofSlot(state.ref, Date.now() + 600_000);
      const cb = await proof.handleSsoProofCallback(
        new NextRequest(
          `https://hop.test/api/auth/oidc/callback?state=${encodeURIComponent(state.flow)}&code=code&workspaceId=https://evil.test&redirect=https://evil.test`,
        ),
        "oidc",
        cookieStore,
      );
      expect(cb.headers.get("location")).toBe(
        "https://hop.test/dashboard/admin/sso?ssoPreview=failed",
      );
      expect(m.jar.get("auth_token")).toBe(authToken);
    },
  );

  it("fresh proof binds exact actor/sv/workspace; one-time; cannot consume preview as deletion", async () => {
    await proof.beginSsoProof(req("/api/workspaces/id/reauth", {}), t.a.ctx, {
      provider: "oidc",
      workspaceId: t.shared.id,
    });
    await complete();
    expect(await proof.consumeSsoResult(t.a.ctx, "sso_preview")).toBeNull();
    const { ssoProof } = await proof.consumeSsoResult(t.a.ctx, "workspace_delete", t.shared.id);
    expect(() =>
      proof.consumeWorkspaceDeleteProof(
        ssoProof,
        t.a.user.id,
        t.shared.id,
        t.a.user.sessionVersion,
      ),
    ).not.toThrow();
    expect(() =>
      proof.consumeWorkspaceDeleteProof(
        ssoProof,
        t.a.user.id,
        t.shared.id,
        t.a.user.sessionVersion,
      ),
    ).toThrow();
    await start();
    await complete();
    expect(await proof.consumeSsoResult(t.a.ctx, "workspace_delete", t.shared.id)).toBeNull();
  });
});

// Module reloads share pending slots but cannot reset their TTL or cap.
describe("global proof slot store", () => {
  it("retains pending slots across module instances, with original TTL and cap", async () => {
    const now = Date.now();
    const ref = slots.putProofSlot({ stage: "draft" }, now);
    vi.resetModules();
    const reloaded = await import("@/lib/users/ssoProofState.js");
    expect(reloaded.peekProofSlot(ref, now + 299_999)).toMatchObject({ stage: "draft" });
    expect(reloaded.peekProofSlot(ref, now + 300_000)).toBeNull();
    for (let i = 0; i < 512; i++) slots.putProofSlot({ stage: "draft" }, now);
    expect(() => reloaded.putProofSlot({ stage: "draft" }, now)).toThrow("Service unavailable");
    reloaded.resetProofSlots();
    expect(slots.peekProofSlot(ref, now)).toBeNull();
  });
});
