import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { clearAccount, recordSuccess } from "@/lib/auth/loginLimiter";

const ISSUER = "https://idp.test";
const SECRET = "client-secret-value-0123456789abcdef";
const NONCE = "nonce-abc";
const TOKEN = "A".repeat(43);
const SAML_ISSUER = "https://saml-idp.test";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  setDashboardAuthCookie: vi.fn(),
  cookies: new Map(),
  sessionClaims: vi.fn(async () => ({ sub: "u1", sv: 1 })),
  enforced: vi.fn(async () => true),
  multiUser: vi.fn(async () => true),
  ssoAdmit: vi.fn(),
  audit: vi.fn(),
  validateSamlResponse: vi.fn(),
  jwtSecret: "test-secret-for-invite-cookie-0123456789",
}));

vi.mock("next/server", () => ({
  NextResponse: {
    redirect: (url) => ({ status: 307, location: String(url), headers: new Headers() }),
    json: (body, init) => ({ status: init?.status ?? 200, body, headers: new Headers() }),
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name) => (mocks.cookies.has(name) ? { value: mocks.cookies.get(name) } : undefined),
    set: (name, value) => mocks.cookies.set(name, value),
    delete: (name) => mocks.cookies.delete(name),
  }),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/lib/db/index.js", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/lib/users/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/users/securityState", () => ({ isUserSecurityEnforced: mocks.enforced }));
vi.mock("@/lib/users/securityState.js", () => ({ isUserSecurityEnforced: mocks.enforced }));
vi.mock("@/lib/users/featureSwitch.js", () => ({
  requireMultiUser: async () =>
    (await mocks.multiUser()) ? null : { status: 404, body: { error: "Not found" } },
  isMultiUserEnabled: mocks.multiUser,
}));
vi.mock("@/lib/users/bootstrap", () => ({
  SETUP_TOKEN_COOKIE: "setup_token",
  stashSetupToken: vi.fn(),
  takeSetupToken: vi.fn(),
}));
vi.mock("@/lib/users/ssoProvisioning", async (importOriginal) => ({
  ...(await importOriginal()),
  ssoAdmit: mocks.ssoAdmit,
}));
vi.mock("@/lib/users/session", () => ({ sessionClaims: mocks.sessionClaims }));
vi.mock("@/lib/auth/saml.js", async (importOriginal) => ({
  ...(await importOriginal()),
  validateSamlResponse: mocks.validateSamlResponse,
  buildSamlAuthorizeUrl: async () => ({
    authorizeUrl: `${SAML_ISSUER}/sso?SAMLRequest=x`,
    requestId: "req-1",
  }),
}));
// Real sign/verify for the invite cookie; only cookie writing is stubbed.
vi.mock("@/lib/auth/dashboardSession", async () => {
  const key = new TextEncoder().encode(mocks.jwtSecret);
  const { SignJWT: Sign, jwtVerify } = await import("jose");
  const { createHmac } = await import("node:crypto");
  return {
    shouldUseSecureCookie: () => false,
    setDashboardAuthCookie: mocks.setDashboardAuthCookie,
    deriveSecretKey: (p) => createHmac("sha256", key).update(`tokenhop:${p}`).digest(),
    createDashboardAuthToken: (claims, exp = "24h") =>
      new Sign({ authenticated: true, ...claims })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime(exp)
        .sign(key),
    readSignedAuthToken: async (t) => {
      try {
        return (await jwtVerify(t, key, { algorithms: ["HS256"] })).payload;
      } catch {
        return null;
      }
    },
  };
});

const oidcStart = await import("@/app/api/auth/oidc/start/route.js");
const oidcCb = await import("@/app/api/auth/oidc/callback/route.js");
const samlStart = await import("@/app/api/auth/saml/start/route.js");
const samlAcs = await import("@/app/api/auth/saml/acs/route.js");

const post = (url, body, headers = {}) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

function stubIdp(idToken) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => ({
      ok: true,
      json: async () => {
        const u = String(url);
        if (u.endsWith("/.well-known/openid-configuration")) {
          return {
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/authorize`,
            token_endpoint: `${ISSUER}/token`,
            jwks_uri: `${ISSUER}/jwks`,
            id_token_signing_alg_values_supported: ["HS256"],
          };
        }
        return { id_token: idToken, access_token: "a" };
      },
    })),
  );
}

const hsToken = (extra = {}) =>
  new SignJWT({ nonce: NONCE, groups: ["eng"], ...extra })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience("client")
    .setSubject("user-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(SECRET));

const oidcSettings = {
  authMode: "sso",
  ssoType: "oidc",
  oidcIssuerUrl: ISSUER,
  oidcClientId: "client",
  oidcClientSecret: SECRET,
  ssoGroupsClaim: "groups",
};

beforeEach(() => {
  vi.stubEnv("BASE_URL", "http://localhost");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // Real limiter is in-memory and shared: fail-closed cases and 400 rejects
  // pile failures on the "unknown" IP bucket and lock later tests (429/too_many_attempts).
  recordSuccess("unknown");
  clearAccount(`sso:${JSON.stringify(["oidc", ISSUER, "user-1"])}`);
  clearAccount(`sso:${JSON.stringify(["saml", SAML_ISSUER, "n1"])}`);
  mocks.cookies = new Map();
  mocks.enforced.mockReset().mockResolvedValue(true);
  mocks.multiUser.mockReset().mockResolvedValue(true);
  mocks.ssoAdmit.mockReset().mockResolvedValue({ kind: "active", userId: "u1" });
  mocks.sessionClaims.mockReset().mockResolvedValue({ sub: "u1", sv: 1 });
  mocks.setDashboardAuthCookie.mockReset();
  mocks.getSettings.mockReset().mockResolvedValue({
    ...oidcSettings,
    baseUrl: "http://localhost",
    samlEntryPoint: `${SAML_ISSUER}/sso`,
    samlCert: "cert",
    samlAttributeGroups: "groups",
  });
});

describe("OIDC invitation start (POST)", () => {
  it("redirects to the IdP without the token in any URL; token only in a sealed cookie", async () => {
    stubIdp("x");
    const res = await oidcStart.POST(
      post("http://localhost/api/auth/oidc/start", { invitationToken: TOKEN }),
    );
    expect(res.status).toBe(307);
    expect(res.location).toContain(`${ISSUER}/authorize`);
    expect(res.location).not.toContain(TOKEN);
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    const sealed = mocks.cookies.get("oidc_invite");
    expect(sealed).toBeTruthy();
    expect(sealed).not.toContain(TOKEN); // JWT payload is base64: raw token not visible as-is
    expect(mocks.cookies.get("oidc_state")).toBeTruthy();
  });

  it("404 with the switch off, no cookies set", async () => {
    mocks.multiUser.mockResolvedValue(false);
    const res = await oidcStart.POST(
      post("http://localhost/api/auth/oidc/start", { invitationToken: TOKEN }),
    );
    expect(res.status).toBe(404);
    expect(mocks.cookies.size).toBe(0);
  });

  it.each([
    ["cross-site", { "sec-fetch-site": "cross-site" }, { invitationToken: TOKEN }, 403],
    ["wrong content-type", { "content-type": "text/plain" }, { invitationToken: TOKEN }, 415],
    ["bad shape", {}, { invitationToken: "short" }, 400],
    ["extra key", {}, { invitationToken: TOKEN, x: 1 }, 400],
    ["oversize", {}, { invitationToken: TOKEN, pad: "p".repeat(400) }, 413],
  ])("rejects %s", async (_n, headers, body, status) => {
    const res = await oidcStart.POST(post("http://localhost/api/auth/oidc/start", body, headers));
    expect(res.status).toBe(status);
    expect(mocks.cookies.has("oidc_invite")).toBe(false);
  });

  it("GET (regular login) sets no invite cookie", async () => {
    stubIdp("x");
    const res = await oidcStart.GET(new Request("http://localhost/api/auth/oidc/start"));
    expect(res.status).toBe(307);
    expect(mocks.cookies.has("oidc_invite")).toBe(false);
  });
});

describe("OIDC callback with invitation proof", () => {
  async function startThenCallback({ tamper } = {}) {
    stubIdp("x");
    await oidcStart.POST(post("http://localhost/api/auth/oidc/start", { invitationToken: TOKEN }));
    const state = mocks.cookies.get("oidc_state");
    mocks.cookies.set("oidc_nonce", NONCE);
    if (tamper) tamper(state);
    stubIdp(await hsToken());
    return oidcCb.GET(new Request(`http://localhost/api/auth/oidc/callback?code=c&state=${state}`));
  }

  it("passes the server-held token to ssoAdmit after verification and clears the cookie", async () => {
    const res = await startThenCallback();
    expect(res.location).toBe("http://localhost/dashboard");
    expect(mocks.ssoAdmit).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "oidc", issuer: ISSUER, subject: "user-1" }),
      ["eng"],
      expect.objectContaining({ invitationToken: TOKEN }),
    );
    expect(mocks.cookies.has("oidc_invite")).toBe(false);
  });

  it("emailVerified comes only from the verified email_verified claim", async () => {
    stubIdp("x");
    await oidcStart.POST(post("http://localhost/api/auth/oidc/start", { invitationToken: TOKEN }));
    const state = mocks.cookies.get("oidc_state");
    mocks.cookies.set("oidc_nonce", NONCE);
    stubIdp(await hsToken({ email: "a@b.test", email_verified: "true" }));
    await oidcCb.GET(new Request(`http://localhost/api/auth/oidc/callback?code=c&state=${state}`));
    expect(mocks.ssoAdmit.mock.calls[0][0].emailVerified).toBe(false);
  });

  it("fails closed when the invite cookie is bound to another flow's state", async () => {
    stubIdp("x");
    await oidcStart.POST(post("http://localhost/api/auth/oidc/start", { invitationToken: TOKEN }));
    const sealed = mocks.cookies.get("oidc_invite");
    // Second flow: fresh state, replayed invite cookie from the first.
    await oidcStart.GET(new Request("http://localhost/api/auth/oidc/start"));
    mocks.cookies.set("oidc_invite", sealed);
    const state = mocks.cookies.get("oidc_state");
    mocks.cookies.set("oidc_nonce", NONCE);
    stubIdp(await hsToken());
    const res = await oidcCb.GET(
      new Request(`http://localhost/api/auth/oidc/callback?code=c&state=${state}`),
    );
    expect(res.location).toBe("http://localhost/login?error=sso_group_denied");
    expect(mocks.ssoAdmit).not.toHaveBeenCalled();
    expect(mocks.cookies.has("oidc_invite")).toBe(false);
  });

  it("fails closed on a garbage invite cookie", async () => {
    const res = await startThenCallback({ tamper: () => mocks.cookies.set("oidc_invite", "junk") });
    expect(res.location).toBe("http://localhost/login?error=sso_group_denied");
    expect(mocks.ssoAdmit).not.toHaveBeenCalled();
  });

  it("clears the invite cookie on provider error", async () => {
    mocks.cookies.set("oidc_invite", "whatever");
    await oidcCb.GET(new Request("http://localhost/api/auth/oidc/callback?error=access_denied"));
    expect(mocks.cookies.has("oidc_invite")).toBe(false);
  });

  it("regular login passes no invitationToken", async () => {
    stubIdp("x");
    await oidcStart.GET(new Request("http://localhost/api/auth/oidc/start"));
    const state = mocks.cookies.get("oidc_state");
    mocks.cookies.set("oidc_nonce", NONCE);
    stubIdp(await hsToken());
    await oidcCb.GET(new Request(`http://localhost/api/auth/oidc/callback?code=c&state=${state}`));
    expect(mocks.ssoAdmit.mock.calls[0][2]).not.toHaveProperty("invitationToken");
  });
});

describe("SAML invitation start + ACS", () => {
  const acs = () =>
    samlAcs.POST(
      new Request("http://localhost/api/auth/saml/acs", {
        method: "POST",
        body: new URLSearchParams({ SAMLResponse: "signed" }),
      }),
    );
  const profile = () => ({
    issuer: SAML_ISSUER,
    nameID: "n1",
    nameIDFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
    email: "m@example.test",
    groups: ["eng"],
  });

  beforeEach(() => {
    mocks.validateSamlResponse.mockReset().mockResolvedValue(profile());
    // Start/ACS gate on resolveAuthModes(settings).saml: needs ssoType saml
    // (outer default is oidc). samlAttributeGroups must match profile.groups.
    mocks.getSettings.mockResolvedValue({
      baseUrl: "http://localhost",
      authMode: "sso",
      ssoType: "saml",
      samlEntryPoint: `${SAML_ISSUER}/sso`,
      samlCert: "cert",
      samlAttributeGroups: "groups",
    });
  });

  it("start: token never in IdP URL; sealed cookie bound to request id; 404 when off", async () => {
    const res = await samlStart.POST(
      post("http://localhost/api/auth/saml/start", { invitationToken: TOKEN }),
    );
    expect(res.status).toBe(307);
    expect(res.location).not.toContain(TOKEN);
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(mocks.cookies.get("saml_state")).toBe("req-1");
    expect(mocks.cookies.get("saml_invite")).toBeTruthy();

    mocks.cookies = new Map();
    mocks.multiUser.mockResolvedValue(false);
    const off = await samlStart.POST(
      post("http://localhost/api/auth/saml/start", { invitationToken: TOKEN }),
    );
    expect(off.status).toBe(404);
    expect(mocks.cookies.size).toBe(0);
  });

  it("ACS: passes the server-held token after assertion validation; clears cookies", async () => {
    await samlStart.POST(post("http://localhost/api/auth/saml/start", { invitationToken: TOKEN }));
    const res = await acs();
    expect(res.location).toBe("http://localhost/dashboard");
    expect(mocks.ssoAdmit).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "saml", emailVerified: true }),
      ["eng"],
      expect.objectContaining({ invitationToken: TOKEN }),
    );
    expect(mocks.cookies.has("saml_invite")).toBe(false);
    expect(mocks.cookies.has("saml_state")).toBe(false);
  });

  it("ACS: invite cookie from a different request id fails closed", async () => {
    await samlStart.POST(post("http://localhost/api/auth/saml/start", { invitationToken: TOKEN }));
    mocks.cookies.set("saml_state", "req-other");
    const res = await acs();
    expect(res.location).toBe("http://localhost/login?error=sso_group_denied");
    expect(mocks.ssoAdmit).not.toHaveBeenCalled();
    expect(mocks.cookies.has("saml_invite")).toBe(false);
  });

  it("ACS: invalid assertion never opens the invite and clears the cookie", async () => {
    await samlStart.POST(post("http://localhost/api/auth/saml/start", { invitationToken: TOKEN }));
    mocks.validateSamlResponse.mockRejectedValue(new Error("bad sig"));
    await acs();
    expect(mocks.ssoAdmit).not.toHaveBeenCalled();
    expect(mocks.cookies.has("saml_invite")).toBe(false);
  });

  it("ACS: regular login passes no invitationToken", async () => {
    mocks.cookies.set("saml_state", "req-1");
    await acs();
    expect(mocks.ssoAdmit.mock.calls[0][2]).not.toHaveProperty("invitationToken");
  });
});
