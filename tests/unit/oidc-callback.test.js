import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";

const ISSUER = "https://idp.test";
const SECRET = "client-secret-value-0123456789abcdef";
const NONCE = "nonce-abc";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  setDashboardAuthCookie: vi.fn(),
  cookies: new Map(),
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
// Isolate id_token verification/callback wiring here. Real session admission
// is tested separately in principal-sessions.test.js, not through this callback.
vi.mock("@/lib/users/session", () => ({ sessionClaims: async () => ({}) }));
vi.mock("@/lib/auth/dashboardSession", () => ({
  setDashboardAuthCookie: mocks.setDashboardAuthCookie,
}));

const { GET } = await import("@/app/api/auth/oidc/callback/route.js");

// Discovery advertises `algs`; the token endpoint returns an HS256 id_token.
function stubIdp(algs, idToken) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => ({
      ok: true,
      json: async () =>
        String(url).endsWith("/.well-known/openid-configuration")
          ? {
              issuer: ISSUER,
              token_endpoint: `${ISSUER}/token`,
              jwks_uri: `${ISSUER}/jwks`,
              id_token_signing_alg_values_supported: algs,
            }
          : { id_token: idToken },
    })),
  );
}

const hsToken = (nonce = NONCE) =>
  new SignJWT({ nonce })
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
