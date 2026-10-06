// YAN-360: POST /api/users/ownership-transfer/sso (start of SSO re-auth).
// Real route + real userManagement gate; auth/db/OIDC/SAML builders mocked.
// sealOwnerTransferState is mocked to capture the state (JWE crypto is covered
// by the ownershipTransferState tests).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  requireMultiUser: vi.fn(),
  authorize: vi.fn(),
  getPrincipal: vi.fn(),
  getDashboardAuthSession: vi.fn(),
  shouldUseSecureCookie: vi.fn(),
  getUserUnscoped: vi.fn(),
  listIdentitiesUnscoped: vi.fn(),
  getSettings: vi.fn(),
  getOidcRuntimeConfig: vi.fn(),
  fetchOidcDiscovery: vi.fn(),
  buildOidcAuthorizationUrl: vi.fn(),
  buildSamlReauthAuthorizeUrl: vi.fn(),
  isSamlConfigured: vi.fn(),
  resolveAuthModes: vi.fn(),
  sealOwnerTransferState: vi.fn(),
  checkLoginLocks: vi.fn(),
  recordLoginFail: vi.fn(),
  cookieStore: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
}));

vi.mock("@/lib/users/featureSwitch", () => ({ requireMultiUser: mocks.requireMultiUser }));
vi.mock("@/lib/users/session", () => ({
  authorize: mocks.authorize,
  getPrincipal: mocks.getPrincipal,
}));
vi.mock("@/lib/auth/sameOrigin.js", () => ({
  isCrossSite: vi.fn(() => false),
  isJson: vi.fn(() => true),
}));
vi.mock("@/lib/auth/dashboardSession.js", () => ({
  getDashboardAuthSession: mocks.getDashboardAuthSession,
  shouldUseSecureCookie: mocks.shouldUseSecureCookie,
}));
vi.mock("next/headers", () => ({ cookies: async () => mocks.cookieStore }));
vi.mock("@/lib/db/repos/usersRepo.js", () => ({ getUserUnscoped: mocks.getUserUnscoped }));
vi.mock("@/lib/db/repos/identitiesRepo.js", () => ({
  listIdentitiesUnscoped: mocks.listIdentitiesUnscoped,
}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/lib/auth/authModes", () => ({ resolveAuthModes: mocks.resolveAuthModes }));
vi.mock("@/lib/auth/loginLimiter.js", () => ({
  accountKey: ({ userId }) => `acct:${userId}`,
  checkLoginLocks: mocks.checkLoginLocks,
  getClientIp: () => "1.2.3.4",
  recordLoginFail: mocks.recordLoginFail,
}));
vi.mock("@/lib/auth/oidc", () => ({
  buildOidcAuthorizationUrl: mocks.buildOidcAuthorizationUrl,
  createOidcNonce: () => "nonce-1",
  createOidcState: () => "state-1",
  createPkcePair: () => ({ verifier: "verifier-1", challenge: "challenge-1" }),
  fetchOidcDiscovery: mocks.fetchOidcDiscovery,
  getOidcRuntimeConfig: mocks.getOidcRuntimeConfig,
  getPublicOrigin: () => "https://tokenhop.example",
}));
vi.mock("@/lib/auth/saml.js", () => ({
  buildSamlReauthAuthorizeUrl: mocks.buildSamlReauthAuthorizeUrl,
  isSamlConfigured: mocks.isSamlConfigured,
}));
vi.mock("@/lib/auth/ownershipTransferState.js", async (importActual) => ({
  ...(await importActual()),
  sealOwnerTransferState: mocks.sealOwnerTransferState,
}));

const { POST } = await import("@/app/api/users/ownership-transfer/sso/route.js");

const OWNER = {
  id: OWNER_ID,
  instanceRole: "owner",
  status: "active",
  sessionVersion: 3,
};
const TARGET = { id: TARGET_ID, instanceRole: "user", status: "active", sessionVersion: 1 };

const post = (body = { toUserId: TARGET_ID, provider: "oidc" }) =>
  new Request("https://tokenhop.example/api/users/ownership-transfer/sso", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireMultiUser.mockResolvedValue(null);
  mocks.getPrincipal.mockResolvedValue({ via: "session", userId: OWNER_ID });
  mocks.authorize.mockResolvedValue(null);
  mocks.cookieStore.get.mockReturnValue({ value: "jws" });
  mocks.getDashboardAuthSession.mockResolvedValue({ sub: OWNER_ID, sv: 3 });
  mocks.shouldUseSecureCookie.mockReturnValue(true);
  mocks.checkLoginLocks.mockReturnValue({ locked: false });
  mocks.getUserUnscoped.mockImplementation(async (id) =>
    id === OWNER_ID ? OWNER : id === TARGET_ID ? TARGET : null,
  );
  mocks.listIdentitiesUnscoped.mockResolvedValue([
    { provider: "oidc", issuer: "https://idp.example", subject: "sub-oidc" },
    { provider: "saml", issuer: "https://saml.example", subject: "sub-saml" },
  ]);
  mocks.getSettings.mockResolvedValue({});
  mocks.resolveAuthModes.mockReturnValue({ saml: true });
  mocks.isSamlConfigured.mockReturnValue(true);
  mocks.getOidcRuntimeConfig.mockResolvedValue({
    issuerUrl: "https://idp.example",
    clientId: "client-1",
    scopes: "openid email",
  });
  mocks.fetchOidcDiscovery.mockResolvedValue({
    issuer: "https://idp.example",
    authorization_endpoint: "https://idp.example/authorize",
  });
  mocks.buildOidcAuthorizationUrl.mockReturnValue(
    "https://idp.example/authorize?client_id=client-1&state=state-1",
  );
  mocks.buildSamlReauthAuthorizeUrl.mockResolvedValue({
    authorizeUrl: "https://saml.example/sso?SAMLRequest=abc",
    requestId: "req-1",
  });
  mocks.sealOwnerTransferState.mockResolvedValue("sealed-jwe");
});

describe("gates", () => {
  it("multi-user switch off -> 404 before principal lookup", async () => {
    mocks.requireMultiUser.mockResolvedValue(
      NextResponse.json({ error: "Not found" }, { status: 404 }),
    );
    const res = await POST(post());
    expect(res.status).toBe(404);
    expect(mocks.getPrincipal).not.toHaveBeenCalled();
    expect(mocks.sealOwnerTransferState).not.toHaveBeenCalled();
  });

  it("non-session principal -> 401, no state sealed", async () => {
    mocks.getPrincipal.mockResolvedValue({ via: "cli", userId: OWNER_ID });
    const res = await POST(post());
    expect(res.status).toBe(401);
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.cookieStore.set).not.toHaveBeenCalled();
  });

  it("stale session version -> 403 and failed attempt recorded", async () => {
    mocks.getDashboardAuthSession.mockResolvedValue({ sub: OWNER_ID, sv: 2 });
    const res = await POST(post());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "forbidden" });
    expect(mocks.recordLoginFail).toHaveBeenCalledOnce();
    expect(mocks.sealOwnerTransferState).not.toHaveBeenCalled();
    expect(mocks.cookieStore.set).not.toHaveBeenCalled();
  });
});

describe("OIDC start", () => {
  it("live owner + active target -> authorizeUrl with prompt=login & max_age=0, sealed state, no secrets in response", async () => {
    const res = await POST(post({ toUserId: TARGET_ID, provider: "oidc" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");

    const text = await res.text();
    const { authorizeUrl } = JSON.parse(text);
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://idp.example/authorize");
    expect(url.searchParams.get("prompt")).toBe("login");
    expect(url.searchParams.get("max_age")).toBe("0");

    expect(mocks.sealOwnerTransferState).toHaveBeenCalledOnce();
    expect(mocks.sealOwnerTransferState.mock.calls[0][0]).toMatchObject({
      ownerId: OWNER_ID,
      toUserId: TARGET_ID,
      sessionVersion: 3,
      provider: "oidc",
      issuer: "https://idp.example",
      subject: "sub-oidc",
      state: "state-1",
      nonce: "nonce-1",
      verifier: "verifier-1",
    });

    // verifier / nonce / sealed value stay out of the body.
    expect(Object.keys(JSON.parse(text))).toEqual(["authorizeUrl"]);
    expect(text).not.toContain("verifier-1");
    expect(text).not.toContain("nonce-1");
    expect(text).not.toContain("sealed-jwe");

    expect(mocks.cookieStore.set).toHaveBeenCalledOnce();
    const [name, value, options] = mocks.cookieStore.set.mock.calls[0];
    expect(name).toBe("owner_transfer_state");
    expect(value).toBe("sealed-jwe");
    expect(options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax" });
    expect(mocks.cookieStore.delete).not.toHaveBeenCalled();
  });
});

describe("SAML start", () => {
  const samlBody = { toUserId: TARGET_ID, provider: "saml" };

  it("insecure HTTP -> 409 before buildSamlReauthAuthorizeUrl", async () => {
    mocks.shouldUseSecureCookie.mockReturnValue(false);
    const res = await POST(post(samlBody));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "reauth_unavailable" });
    expect(mocks.buildSamlReauthAuthorizeUrl).not.toHaveBeenCalled();
    expect(mocks.cookieStore.set).not.toHaveBeenCalled();
  });

  it("secure settings -> HttpOnly Secure SameSite=None cookie and saml_state cleared", async () => {
    const res = await POST(post(samlBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorizeUrl: "https://saml.example/sso?SAMLRequest=abc" });

    expect(mocks.sealOwnerTransferState.mock.calls[0][0]).toMatchObject({
      ownerId: OWNER_ID,
      toUserId: TARGET_ID,
      sessionVersion: 3,
      provider: "saml",
      issuer: "https://saml.example",
      subject: "sub-saml",
      requestId: "req-1",
    });

    expect(mocks.cookieStore.delete).toHaveBeenCalledWith("saml_state");
    expect(mocks.cookieStore.set).toHaveBeenCalledOnce();
    const [name, value, options] = mocks.cookieStore.set.mock.calls[0];
    expect(name).toBe("owner_transfer_state");
    expect(value).toBe("sealed-jwe");
    expect(options).toMatchObject({ httpOnly: true, secure: true, sameSite: "none" });
  });
});
