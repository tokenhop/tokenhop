import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";

const ISSUER = "https://idp.test";
const SECRET = "client-secret-value-0123456789abcdef";
const NONCE = "nonce-abc";
const STATE = "st-1";
const AUTH_TIME = Math.floor(Date.now() / 1000);

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  setDashboardAuthCookie: vi.fn(),
  cookies: new Map(),
  sessionClaims: vi.fn(async () => ({})),
  ssoAdmit: vi.fn(),
  audit: vi.fn(),
  multiUser: vi.fn(async () => true),
  completeSsoOwnershipTransfer: vi.fn(),
  jwtSecret: "test-secret-for-owner-transfer-0123456789",
}));

vi.mock("next/server", () => ({
  NextResponse: { redirect: (url) => ({ status: 307, location: String(url) }) },
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
vi.mock("@/lib/users/securityState.js", () => ({
  isUserSecurityEnforced: vi.fn(async () => false),
}));
vi.mock("@/lib/users/featureSwitch.js", () => ({
  isMultiUserEnabled: mocks.multiUser,
}));
// Real readGroupsClaim / SsoAdmissionError; only the DB-backed admission is mocked.
vi.mock("@/lib/users/ssoProvisioning", async (importOriginal) => ({
  ...(await importOriginal()),
  ssoAdmit: mocks.ssoAdmit,
}));
vi.mock("@/lib/users/session", () => ({ sessionClaims: mocks.sessionClaims }));
vi.mock("@/lib/users/ssoOwnershipTransfer.js", () => ({
  completeSsoOwnershipTransfer: mocks.completeSsoOwnershipTransfer,
}));
// Real sign/verify for the sealed transfer state (JWE under deriveSecretKey);
// only cookie writing is stubbed.
vi.mock("@/lib/auth/dashboardSession", async () => {
  const key = new TextEncoder().encode(mocks.jwtSecret);
  const { createHmac } = await import("node:crypto");
  return {
    shouldUseSecureCookie: () => false,
    setDashboardAuthCookie: mocks.setDashboardAuthCookie,
    deriveSecretKey: (p) => createHmac("sha256", key).update(`tokenhop:${p}`).digest(),
  };
});

const { GET } = await import("@/app/api/auth/oidc/callback/route.js");
const { sealOwnerTransferState, OWNER_TRANSFER_COOKIE } = await import(
  "@/lib/auth/ownershipTransferState.js"
);

function stubIdp(idToken) {
  const fetchMock = vi.fn(async (url) => ({
    ok: true,
    json: async () => {
      const u = String(url);
      if (u.endsWith("/.well-known/openid-configuration")) {
        return {
          issuer: ISSUER,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
          id_token_signing_alg_values_supported: ["HS256"],
        };
      }
      return { id_token: idToken, access_token: "access-1" };
    },
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const hsToken = (extra = {}) =>
  new SignJWT({ nonce: NONCE, ...extra })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience("client")
    .setSubject("user-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(SECRET));

const sealTransfer = (overrides = {}) =>
  sealOwnerTransferState({
    ownerId: "owner-1",
    sessionVersion: 1,
    toUserId: "11111111-1111-4111-8111-111111111111",
    provider: "oidc",
    issuer: ISSUER,
    subject: "user-1",
    state: STATE,
    nonce: NONCE,
    verifier: "v-1",
    ...overrides,
  });

const callback = (state = STATE) =>
  GET(new Request(`http://localhost/api/auth/oidc/callback?code=c&state=${state}`));

const FAILED = "http://localhost/login?error=ownership_reauth_failed";

async function setup(sealed, extraCookies = {}) {
  mocks.cookies = new Map([
    [OWNER_TRANSFER_COOKIE, sealed],
    ["auth_token", "old-session"],
    ["oidc_state", STATE],
    ["oidc_nonce", NONCE],
    ["oidc_code_verifier", "v-1"],
    ...Object.entries(extraCookies),
  ]);
}

beforeEach(() => {
  vi.stubEnv("BASE_URL", "http://localhost");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.setDashboardAuthCookie.mockClear();
  mocks.sessionClaims.mockReset().mockResolvedValue({});
  mocks.ssoAdmit.mockReset();
  mocks.completeSsoOwnershipTransfer.mockReset().mockResolvedValue({});
  mocks.multiUser.mockReset().mockResolvedValue(true);
  mocks.getSettings.mockResolvedValue({
    authMode: "sso",
    ssoType: "oidc",
    oidcIssuerUrl: ISSUER,
    oidcClientId: "client",
    oidcClientSecret: SECRET,
  });
});

describe("OIDC callback ownership-transfer re-auth (YAN-360)", () => {
  it("completes the transfer from a fresh verified id_token; never mints a login", async () => {
    await setup(await sealTransfer());
    stubIdp(await hsToken({ auth_time: AUTH_TIME }));
    const res = await callback();
    expect(res.location).toBe("http://localhost/login?transferred=1");
    expect(mocks.completeSsoOwnershipTransfer).toHaveBeenCalledWith({
      state: expect.objectContaining({ ownerId: "owner-1", sessionVersion: 1, provider: "oidc" }),
      provider: "oidc",
      issuer: ISSUER,
      subject: "user-1",
      authenticatedAtMs: AUTH_TIME * 1000,
    });
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
    expect(mocks.ssoAdmit).not.toHaveBeenCalled();
    expect(mocks.sessionClaims).not.toHaveBeenCalled();
    expect(mocks.cookies.has(OWNER_TRANSFER_COOKIE)).toBe(false);
    expect(mocks.cookies.has("auth_token")).toBe(false);
  });

  it("missing auth_time fails closed without completing the transfer", async () => {
    await setup(await sealTransfer());
    stubIdp(await hsToken());
    const res = await callback();
    expect(res.location).toBe(FAILED);
    expect(mocks.completeSsoOwnershipTransfer).not.toHaveBeenCalled();
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
    expect(mocks.cookies.has(OWNER_TRANSFER_COOKIE)).toBe(false);
  });

  // A transfer cookie that doesn't open/match is dropped and the normal,
  // fully verified login runs untouched: an abandoned flow never blocks login.
  it("tampered transfer cookie is dropped; the normal login proceeds without a transfer", async () => {
    const sealed = await sealTransfer();
    await setup(`${sealed.slice(0, -4)}AAAA`);
    stubIdp(await hsToken({ auth_time: AUTH_TIME }));
    const res = await callback();
    expect(res.location).toBe("http://localhost/dashboard");
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalled();
    expect(mocks.completeSsoOwnershipTransfer).not.toHaveBeenCalled();
    expect(mocks.cookies.has(OWNER_TRANSFER_COOKIE)).toBe(false);
  });

  it("query state mismatch claims no transfer and the normal state check still rejects", async () => {
    await setup(await sealTransfer());
    const fetchMock = stubIdp(await hsToken({ auth_time: AUTH_TIME }));
    const res = await callback("attacker-state");
    expect(res.location).toBe("http://localhost/login?error=oidc_invalid_state");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.completeSsoOwnershipTransfer).not.toHaveBeenCalled();
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
    expect(mocks.cookies.has(OWNER_TRANSFER_COOKIE)).toBe(false);
  });

  it("a SAML-provider transfer cookie never completes a transfer in the OIDC callback", async () => {
    await setup(await sealTransfer({ provider: "saml", requestId: "req-1" }));
    stubIdp(await hsToken({ auth_time: AUTH_TIME }));
    const res = await callback();
    expect(res.location).toBe("http://localhost/dashboard");
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalled();
    expect(mocks.completeSsoOwnershipTransfer).not.toHaveBeenCalled();
    expect(mocks.cookies.has(OWNER_TRANSFER_COOKIE)).toBe(false);
  });

  it("multi-user switch off fails before exchange and service", async () => {
    await setup(await sealTransfer());
    mocks.multiUser.mockResolvedValue(false);
    const fetchMock = stubIdp(await hsToken({ auth_time: AUTH_TIME }));
    const res = await callback();
    expect(res.location).toBe(FAILED);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.completeSsoOwnershipTransfer).not.toHaveBeenCalled();
  });
});
