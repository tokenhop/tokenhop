import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccount, recordSuccess } from "@/lib/auth/loginLimiter";

const ISSUER = "https://saml-idp.test";
const SUBJECT = "subject-1";
const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  enforced: vi.fn(),
  ssoAdmit: vi.fn(),
  sessionClaims: vi.fn(),
  audit: vi.fn(),
  validateSamlResponse: vi.fn(),
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
vi.mock("@/lib/users/securityState", () => ({ isUserSecurityEnforced: mocks.enforced }));
vi.mock("@/lib/users/ssoProvisioning", async (importOriginal) => ({
  ...(await importOriginal()),
  ssoAdmit: mocks.ssoAdmit,
}));
// Keep actual configured-attribute extraction; assertion verification belongs to protocol tests.
vi.mock("@/lib/auth/saml.js", async (importOriginal) => ({
  ...(await importOriginal()),
  validateSamlResponse: mocks.validateSamlResponse,
}));
vi.mock("@/lib/users/session", () => ({ sessionClaims: mocks.sessionClaims }));
vi.mock("@/lib/users/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/auth/dashboardSession", () => ({
  setDashboardAuthCookie: mocks.setDashboardAuthCookie,
}));

const { POST } = await import("@/app/api/auth/saml/acs/route.js");
const { SsoAdmissionError } = await import("@/lib/users/ssoProvisioning");
const profile = (extra = {}) => ({
  issuer: ISSUER,
  nameID: SUBJECT,
  nameIDFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
  email: "member@example.test",
  displayName: "Member",
  "urn:test:groups": ["eng"],
  ...extra,
});
const callback = () =>
  POST(
    new Request("http://localhost/api/auth/saml/acs", {
      method: "POST",
      body: new URLSearchParams({ SAMLResponse: "signed-response-fixture" }),
    }),
  );

describe("SAML ACS admission (YAN-359)", () => {
  beforeEach(() => {
    vi.stubEnv("BASE_URL", "http://localhost");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Actual limiter remains in use; reset both known buckets per test.
    recordSuccess("unknown");
    clearAccount(`sso:${JSON.stringify(["saml", ISSUER, SUBJECT])}`);
    mocks.enforced.mockReset().mockResolvedValue(true);
    mocks.ssoAdmit.mockReset().mockResolvedValue({ kind: "active", userId: "admitted-1" });
    mocks.sessionClaims.mockReset().mockResolvedValue({ sub: "admitted-1", sv: 1 });
    mocks.validateSamlResponse.mockReset().mockResolvedValue(profile());
    mocks.audit.mockReset();
    mocks.setDashboardAuthCookie.mockReset();
    mocks.getSettings.mockReset().mockResolvedValue({
      baseUrl: "http://localhost",
      authMode: "sso",
      ssoType: "saml",
      samlEntryPoint: `${ISSUER}/sso`,
      samlCert: "configured-cert",
      samlAttributeGroups: "urn:test:groups",
    });
    mocks.cookies = new Map([
      ["saml_state", "request-1"],
      ["setup_token", "proof-1"],
    ]);
  });

  it("denies transient NameID with sso_group_denied before admission", async () => {
    mocks.validateSamlResponse.mockResolvedValue(
      profile({ nameIDFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient" }),
    );
    const res = await callback();
    expect(res.location).toBe("http://localhost/login?error=sso_group_denied");
    expect(mocks.ssoAdmit).not.toHaveBeenCalled();
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
  });

  it("passes configured groups and peeked setup proof; denial retains the proof", async () => {
    mocks.ssoAdmit.mockRejectedValue(new SsoAdmissionError("denied"));
    const res = await callback();
    expect(res.location).toBe("http://localhost/login?error=sso_group_denied");
    expect(mocks.ssoAdmit).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "saml", issuer: ISSUER, subject: SUBJECT }),
      ["eng"],
      { setupToken: "proof-1" },
    );
    expect(mocks.cookies.get("setup_token")).toBe("proof-1");
    expect(mocks.sessionClaims).not.toHaveBeenCalled();
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
  });

  it("redirects pending admission without claims or an auth cookie", async () => {
    mocks.ssoAdmit.mockResolvedValue({ kind: "pending", userId: "pending-1" });
    const res = await callback();
    expect(res.location).toBe("http://localhost/login/pending");
    expect(mocks.sessionClaims).not.toHaveBeenCalled();
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
  });

  it("passes admitted user id to sessionClaims and sets the active cookie", async () => {
    const res = await callback();
    expect(res.location).toBe("http://localhost/dashboard");
    expect(mocks.sessionClaims).toHaveBeenCalledWith(
      "saml",
      expect.objectContaining({ issuer: ISSUER, subject: SUBJECT }),
      { admittedUserId: "admitted-1" },
    );
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalledOnce();
    expect(mocks.setDashboardAuthCookie.mock.calls[0][2]).toEqual(
      expect.objectContaining({ sub: "admitted-1", saml: true }),
    );
    expect(mocks.cookies.has("setup_token")).toBe(false);
  });

  it("denies missing configured groups with sso_groups_unavailable", async () => {
    const missing = profile();
    delete missing["urn:test:groups"];
    mocks.validateSamlResponse.mockResolvedValue(missing);
    const res = await callback();
    expect(res.location).toBe("http://localhost/login?error=sso_groups_unavailable");
    expect(mocks.ssoAdmit).not.toHaveBeenCalled();
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
    expect(mocks.cookies.get("setup_token")).toBe("proof-1");
  });

  it("preserves pristine sessionClaims setupToken call without admission", async () => {
    mocks.enforced.mockResolvedValue(false);
    mocks.sessionClaims.mockResolvedValue({});
    const res = await callback();
    expect(res.location).toBe("http://localhost/dashboard");
    expect(mocks.ssoAdmit).not.toHaveBeenCalled();
    expect(mocks.sessionClaims).toHaveBeenCalledWith(
      "saml",
      expect.objectContaining({ provider: "saml", subject: SUBJECT }),
      { setupToken: "proof-1" },
    );
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalledOnce();
    expect(mocks.cookies.has("setup_token")).toBe(false);
  });
});
