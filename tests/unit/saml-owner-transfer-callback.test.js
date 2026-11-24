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
vi.mock("@/lib/db/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: mocks.getSettings,
}));
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
vi.mock("@/lib/users/sessionMint", () => ({ mintSessionCookie: mocks.setDashboardAuthCookie }));

const { POST } = await import("@/app/api/auth/saml/acs/route.js");
const { sealOwnerTransferState, OWNER_TRANSFER_COOKIE } = await import(
  "@/lib/auth/ownershipTransferState.js"
);
const limiter = await import("@/lib/auth/loginLimiter.js");
const OWNER_ACCOUNT = limiter.accountKey({ userId: "owner-1" });

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
  limiter.resetLoginLimiter();
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

// YAN-1999: transfer re-auth is a fresh SSO proof, so it uses the proof buckets
// (YAN-1076), never the ordinary login ones.
describe("SAML ACS ownership-transfer limiter buckets (YAN-1999)", () => {
  it("failed transfer proofs lock the proof bucket, never password login", async () => {
    mocks.verifyFresh.mockImplementation(() => {
      throw new Error("stale");
    });
    for (let i = 0; i < 5; i++) {
      mocks.cookies = new Map([[OWNER_TRANSFER_COOKIE, await seal()]]);
      expect((await acs()).location).toBe(FAILED);
    }
    expect(limiter.checkLoginLocks({ ip: "unknown", account: OWNER_ACCOUNT }).locked).toBe(false);
    expect(limiter.checkProofLocks({ ip: "unknown", account: OWNER_ACCOUNT }).locked).toBe(true);

    // A proof-locked owner can't finish another transfer.
    mocks.verifyFresh.mockReset().mockReturnValue({ authnInstant: Date.now() });
    mocks.validateSamlResponse.mockClear();
    mocks.cookies = new Map([[OWNER_TRANSFER_COOKIE, await seal()]]);
    expect((await acs()).location).toBe(FAILED);
    expect(mocks.validateSamlResponse).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("a successful transfer keeps password failures and clears proof failures", async () => {
    for (let i = 0; i < 4; i++) {
      limiter.recordLoginFail({ ip: "pw-ip", account: OWNER_ACCOUNT });
      limiter.recordProofFail({ ip: "p-ip", account: OWNER_ACCOUNT });
    }
    mocks.cookies = new Map([[OWNER_TRANSFER_COOKIE, await seal()]]);
    expect((await acs()).location).toBe("http://localhost/login?transferred=1");
    // Proof count was cleared (checked first: proof checks also honor login locks).
    limiter.recordProofFail({ ip: "p-ip-2", account: OWNER_ACCOUNT });
    expect(limiter.checkProofLocks({ ip: "other", account: OWNER_ACCOUNT }).locked).toBe(false);
    // Password count survived: one more failure reaches the 5-failure lock.
    limiter.recordLoginFail({ ip: "pw-ip-2", account: OWNER_ACCOUNT });
    expect(limiter.checkLoginLocks({ ip: "other", account: OWNER_ACCOUNT }).locked).toBe(true);
  });
});
