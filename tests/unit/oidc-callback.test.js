import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";

const ISSUER = "https://idp.test";
const SECRET = "client-secret-value-0123456789abcdef";
const NONCE = "nonce-abc";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  setDashboardAuthCookie: vi.fn(),
  cookies: new Map(),
  sessionClaims: vi.fn(async () => ({})),
  enforced: vi.fn(async () => false),
  ssoAdmit: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { redirect: (url) => ({ status: 307, location: String(url) }) },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name) => (mocks.cookies.has(name) ? { value: mocks.cookies.get(name) } : undefined),
    delete: (name) => mocks.cookies.delete(name),
  }),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/lib/db/index.js", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/lib/users/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/users/securityState", () => ({ isUserSecurityEnforced: mocks.enforced }));
// Real readGroupsClaim / SsoAdmissionError; only the DB-backed admission is mocked.
vi.mock("@/lib/users/ssoProvisioning", async (importOriginal) => ({
  ...(await importOriginal()),
  ssoAdmit: mocks.ssoAdmit,
}));
// Isolate id_token verification/callback wiring here. Real session admission
// is tested separately in principal-sessions.test.js, not through this callback.
vi.mock("@/lib/users/session", () => ({ sessionClaims: mocks.sessionClaims }));
vi.mock("@/lib/auth/dashboardSession", () => ({
  setDashboardAuthCookie: mocks.setDashboardAuthCookie,
}));

const { GET } = await import("@/app/api/auth/oidc/callback/route.js");

// Discovery advertises `algs`; the token endpoint returns an HS256 id_token.
// Optional `userinfo` body is served at the discovered userinfo_endpoint.
function stubIdp(algs, idToken, userinfo) {
  const fetchMock = vi.fn(async (url) => ({
    ok: true,
    json: async () => {
      const u = String(url);
      if (u.endsWith("/.well-known/openid-configuration")) {
        return {
          issuer: ISSUER,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
          userinfo_endpoint: `${ISSUER}/userinfo`,
          id_token_signing_alg_values_supported: algs,
        };
      }
      if (u === `${ISSUER}/userinfo`) return userinfo;
      return { id_token: idToken, access_token: "access-1" };
    },
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const userinfoCalls = (fetchMock) =>
  fetchMock.mock.calls.filter(([url]) => String(url) === `${ISSUER}/userinfo`);

const hsToken = (nonce = NONCE, extra = {}) =>
  new SignJWT({ nonce, ...extra })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience("client")
    .setSubject("user-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(SECRET));

const callback = () => GET(new Request("http://localhost/api/auth/oidc/callback?code=c&state=s"));

describe("OIDC callback wiring (YAN-604)", () => {
  beforeEach(() => {
    vi.stubEnv("BASE_URL", "http://localhost");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.setDashboardAuthCookie.mockClear();
    mocks.sessionClaims.mockReset().mockResolvedValue({});
    mocks.enforced.mockReset().mockResolvedValue(false);
    mocks.ssoAdmit.mockReset();
    mocks.cookies = new Map([
      ["oidc_state", "s"],
      ["oidc_nonce", NONCE],
      ["oidc_code_verifier", "v"],
    ]);
    mocks.getSettings.mockResolvedValue({
      authMode: "sso",
      ssoType: "oidc",
      oidcIssuerUrl: ISSUER,
      oidcClientId: "client",
      oidcClientSecret: SECRET,
    });
  });

  it("signs in with an HS256 id_token when discovery advertises only HS256", async () => {
    stubIdp(["HS256"], await hsToken());
    const res = await callback();
    expect(res.location).toBe("http://localhost/dashboard");
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalledOnce();
  });

  it("rejects an HS256 id_token when discovery advertises only RS256", async () => {
    stubIdp(["RS256"], await hsToken());
    const res = await callback();
    expect(res.location).toBe("http://localhost/login?error=oidc_callback_failed");
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
  });

  it("rejects an id_token whose nonce differs from the login cookie", async () => {
    stubIdp(["HS256"], await hsToken("attacker-nonce"));
    const res = await callback();
    expect(res.location).toBe("http://localhost/login?error=oidc_callback_failed");
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
  });
});

describe("OIDC callback enforced SSO admission (YAN-359)", () => {
  beforeEach(() => {
    vi.stubEnv("BASE_URL", "http://localhost");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.setDashboardAuthCookie.mockClear();
    mocks.sessionClaims.mockReset().mockResolvedValue({ sub: "u-active", sv: 1, amr: ["oidc"] });
    mocks.enforced.mockReset().mockResolvedValue(true);
    mocks.ssoAdmit.mockReset().mockResolvedValue({ kind: "active", userId: "u-active" });
    mocks.cookies = new Map([
      ["oidc_state", "s"],
      ["oidc_nonce", NONCE],
      ["oidc_code_verifier", "v"],
      ["setup_token", "proof-1"],
    ]);
    mocks.getSettings.mockResolvedValue({
      authMode: "sso",
      ssoType: "oidc",
      oidcIssuerUrl: ISSUER,
      oidcClientId: "client",
      oidcClientSecret: SECRET,
      ssoGroupsClaim: "groups",
    });
  });

  it("pending admission redirects to /login/pending without an auth cookie", async () => {
    mocks.ssoAdmit.mockResolvedValue({ kind: "pending", userId: "u-pending" });
    stubIdp(["HS256"], await hsToken(NONCE, { groups: ["eng"] }));
    const res = await callback();
    expect(res.location).toBe("http://localhost/login/pending");
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
    expect(mocks.sessionClaims).not.toHaveBeenCalled();
  });

  it("active admission passes the admitted user id to sessionClaims", async () => {
    stubIdp(["HS256"], await hsToken(NONCE, { groups: ["eng"] }));
    const res = await callback();
    expect(res.location).toBe("http://localhost/dashboard");
    expect(mocks.ssoAdmit).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "oidc", issuer: ISSUER, subject: "user-1" }),
      ["eng"],
      { setupToken: "proof-1" },
    );
    expect(mocks.sessionClaims).toHaveBeenCalledWith(
      "oidc",
      expect.objectContaining({ subject: "user-1" }),
      { admittedUserId: "u-active" },
    );
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalledOnce();
    expect(mocks.cookies.has("setup_token")).toBe(false);
  });

  it("denied admission keeps the setup_token cookie and maps sso_group_denied", async () => {
    const { SsoAdmissionError } = await import("@/lib/users/ssoProvisioning");
    mocks.ssoAdmit.mockRejectedValue(new SsoAdmissionError("denied"));
    stubIdp(["HS256"], await hsToken(NONCE, { groups: ["other"] }));
    const res = await callback();
    expect(res.location).toBe("http://localhost/login?error=sso_group_denied");
    expect(mocks.cookies.get("setup_token")).toBe("proof-1");
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
  });

  it("present empty groups claim suppresses the UserInfo fetch", async () => {
    const fetchMock = stubIdp(["HS256"], await hsToken(NONCE, { groups: [] }));
    await callback();
    expect(userinfoCalls(fetchMock)).toHaveLength(0);
    expect(mocks.ssoAdmit).toHaveBeenCalledWith(expect.anything(), [], expect.anything());
  });

  it("absent groups claim falls back to UserInfo bound to the verified sub", async () => {
    const fetchMock = stubIdp(["HS256"], await hsToken(), { sub: "user-1", groups: ["eng"] });
    const res = await callback();
    expect(res.location).toBe("http://localhost/dashboard");
    const calls = userinfoCalls(fetchMock);
    expect(calls).toHaveLength(1);
    expect(calls[0][1].headers.Authorization).toBe("Bearer access-1");
    expect(mocks.ssoAdmit).toHaveBeenCalledWith(expect.anything(), ["eng"], expect.anything());
  });

  it("UserInfo with a different sub denies sso_groups_unavailable before admission", async () => {
    stubIdp(["HS256"], await hsToken(), { sub: "someone-else", groups: ["admins"] });
    const res = await callback();
    expect(res.location).toBe("http://localhost/login?error=sso_groups_unavailable");
    expect(mocks.ssoAdmit).not.toHaveBeenCalled();
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
    expect(mocks.cookies.get("setup_token")).toBe("proof-1");
  });
});
