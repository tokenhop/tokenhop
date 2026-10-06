// YAN-360: SAML ACS ownership-transfer branch. A transfer cookie claims the
// ACS only when it opens as a SAML flow and no normal login is in flight; a
// claimed flow never mints a session, and a stale cookie never blocks login.
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ISSUER = "https://saml-idp.test";
const SUBJECT = "owner-subject";
const FAILED = "http://localhost/login?error=ownership_reauth_failed";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  enforced: vi.fn(),
  ssoAdmit: vi.fn(),
  sessionClaims: vi.fn(),
  audit: vi.fn(),
  validateSamlResponse: vi.fn(),
  verifyFresh: vi.fn(),
  setDashboardAuthCookie: vi.fn(),
  complete: vi.fn(),
  multiUser: vi.fn(),
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
vi.mock("@/lib/users/securityState", () => ({ isUserSecurityEnforced: mocks.enforced }));
vi.mock("@/lib/users/ssoProvisioning", async (importOriginal) => ({
  ...(await importOriginal()),
  ssoAdmit: mocks.ssoAdmit,
}));
vi.mock("@/lib/auth/saml.js", async (importOriginal) => ({
  ...(await importOriginal()),
  validateSamlResponse: mocks.validateSamlResponse,
  verifyFreshSamlAuthnInstant: mocks.verifyFresh,
}));
vi.mock("@/lib/users/session", () => ({ sessionClaims: mocks.sessionClaims }));
vi.mock("@/lib/users/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/users/featureSwitch.js", () => ({ isMultiUserEnabled: mocks.multiUser }));
vi.mock("@/lib/users/ssoOwnershipTransfer.js", () => ({
  completeSsoOwnershipTransfer: mocks.complete,
}));
// Real JWE seal/open for the transfer state; only the key source is stubbed.
vi.mock("@/lib/auth/dashboardSession", () => ({
  setDashboardAuthCookie: mocks.setDashboardAuthCookie,
  deriveSecretKey: (p) => createHmac("sha256", "test-key").update(`tokenhop:${p}`).digest(),
}));

const { POST } = await import("@/app/api/auth/saml/acs/route.js");
const { sealOwnerTransferState, OWNER_TRANSFER_COOKIE } = await import(
  "@/lib/auth/ownershipTransferState.js"
);

const seal = (overrides = {}) =>
  sealOwnerTransferState({
    ownerId: "owner-1",
    sessionVersion: 3,
    toUserId: "11111111-1111-4111-8111-111111111111",
    provider: "saml",
    issuer: ISSUER,
    subject: SUBJECT,
    requestId: "transfer-req",
    ...overrides,
  });

const acs = () =>
  POST(
    new Request("http://localhost/api/auth/saml/acs", {
      method: "POST",
      body: new URLSearchParams({ SAMLResponse: "signed-response-fixture" }),
    }),
  );

beforeEach(() => {
  vi.stubEnv("BASE_URL", "http://localhost");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.enforced.mockReset().mockResolvedValue(false);
  mocks.multiUser.mockReset().mockResolvedValue(true);
  mocks.ssoAdmit.mockReset();
  mocks.sessionClaims.mockReset().mockResolvedValue({ sub: "u", sv: 1 });
  mocks.setDashboardAuthCookie.mockReset();
  mocks.complete.mockReset().mockResolvedValue({});
  mocks.verifyFresh.mockReset().mockReturnValue({ authnInstant: Date.now() });
  mocks.validateSamlResponse
    .mockReset()
    .mockResolvedValue({ issuer: ISSUER, nameID: SUBJECT, email: "owner@example.test" });
  mocks.getSettings.mockReset().mockResolvedValue({
    baseUrl: "http://localhost",
    authMode: "sso",
    ssoType: "saml",
    samlEntryPoint: `${ISSUER}/sso`,
    samlCert: "configured-cert",
  });
});

describe("SAML ACS ownership-transfer re-auth (YAN-360)", () => {
  it("completes a fresh, request-bound transfer and never mints a session", async () => {
    mocks.cookies = new Map([
      [OWNER_TRANSFER_COOKIE, await seal()],
      ["auth_token", "old-session"],
    ]);
    const res = await acs();
    expect(res.location).toBe("http://localhost/login?transferred=1");
    expect(mocks.validateSamlResponse.mock.calls[0][2]).toBe("transfer-req");
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "saml", issuer: ISSUER, subject: SUBJECT }),
    );
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
    expect(mocks.ssoAdmit).not.toHaveBeenCalled();
    expect(mocks.cookies.has(OWNER_TRANSFER_COOKIE)).toBe(false);
    expect(mocks.cookies.has("auth_token")).toBe(false);
  });

  it("a stale freshness proof fails closed with no login fallback", async () => {
    mocks.cookies = new Map([[OWNER_TRANSFER_COOKIE, await seal()]]);
    mocks.verifyFresh.mockImplementation(() => {
      throw new Error("stale");
    });
    const res = await acs();
    expect(res.location).toBe(FAILED);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
    expect(mocks.cookies.has(OWNER_TRANSFER_COOKIE)).toBe(false);
  });

  it("a leftover transfer cookie never hijacks an in-flight normal login", async () => {
    mocks.cookies = new Map([
      [OWNER_TRANSFER_COOKIE, await seal()],
      ["saml_state", "login-req"],
    ]);
    const res = await acs();
    expect(res.location).not.toBe(FAILED);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.validateSamlResponse.mock.calls[0][2]).toBe("login-req");
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalled();
    expect(mocks.cookies.has(OWNER_TRANSFER_COOKIE)).toBe(false);
  });

  it("a tampered or OIDC transfer cookie is dropped and claims nothing", async () => {
    for (const sealed of [`${(await seal()).slice(0, -4)}AAAA`, await seal({ provider: "oidc" })]) {
      mocks.complete.mockClear();
      mocks.cookies = new Map([
        [OWNER_TRANSFER_COOKIE, sealed],
        ["saml_state", "login-req"],
      ]);
      const res = await acs();
      expect(res.location).not.toBe(FAILED);
      expect(mocks.complete).not.toHaveBeenCalled();
      expect(mocks.cookies.has(OWNER_TRANSFER_COOKIE)).toBe(false);
    }
  });
});
