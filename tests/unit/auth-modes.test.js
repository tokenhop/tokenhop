import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  cookieStore: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({ status: init?.status || 200, body }),
    redirect: (url) => ({ status: 307, location: String(url) }),
  },
}));
vi.mock("next/headers", () => ({ cookies: async () => mocks.cookieStore }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/lib/auth/dashboardSession", () => ({
  setDashboardAuthCookie: vi.fn(),
  shouldUseSecureCookie: () => false,
}));
vi.mock("@/lib/auth/loginLimiter", () => ({
  checkLock: () => ({ locked: false }),
  recordFail: () => ({ remainingBeforeLock: 4 }),
  recordSuccess: vi.fn(),
  getClientIp: () => "127.0.0.1",
}));
vi.mock("@/lib/auth/saml.js", async (importOriginal) => ({
  ...(await importOriginal()),
  buildSamlAuthorizeUrl: async () => ({ authorizeUrl: "https://idp.test/saml", requestId: "r1" }),
}));

const { resolveAuthModes } = await import("@/lib/auth/authModes");
const { describeLoginError } = await import("@/app/login/loginErrors");
const oidcStart = (await import("@/app/api/auth/oidc/start/route.js")).GET;
const samlStart = (await import("@/app/api/auth/saml/start/route.js")).GET;
const login = (await import("@/app/api/auth/login/route.js")).POST;

const OIDC = { oidcIssuerUrl: "https://idp.test", oidcClientId: "c", oidcClientSecret: "s" };
const SAML = { samlEntryPoint: "https://idp.test/saml", samlCert: "MIIC" };
const MODES = ["password", "both", "sso", "oidc", "saml", undefined];
const TYPES = ["oidc", "saml", undefined];
const MATRIX = MODES.flatMap((authMode) => TYPES.map((ssoType) => [authMode, ssoType]));

// Expected per the helper contract: legacy modes name the protocol, else ssoType (default oidc).
function expected(authMode, ssoType) {
  const ssoOnly = ["sso", "oidc", "saml"].includes(authMode);
  const sso = ssoOnly || authMode === "both";
  const protocol =
    authMode === "oidc" || authMode === "saml" ? authMode : ssoType === "saml" ? "saml" : "oidc";
  return {
    ssoOnly,
    password: !ssoOnly,
    oidc: sso && protocol === "oidc",
    saml: sso && protocol === "saml",
    protocol,
  };
}

beforeEach(() => {
  vi.stubEnv("BASE_URL", "http://localhost");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ authorization_endpoint: "https://idp.test/authorize" }),
    })),
  );
});

describe("resolveAuthModes", () => {
  it.each(MATRIX)("authMode=%s ssoType=%s", (authMode, ssoType) => {
    expect(resolveAuthModes({ authMode, ssoType })).toEqual(expected(authMode, ssoType));
  });

  it("treats unknown modes as password only", () => {
    expect(resolveAuthModes({ authMode: "weird" })).toMatchObject({
      password: true,
      oidc: false,
      saml: false,
    });
  });
});

describe("SSO start routes and password login honor every authMode × ssoType", () => {
  it.each(MATRIX)("authMode=%s ssoType=%s", async (authMode, ssoType) => {
    const exp = expected(authMode, ssoType);
    mocks.getSettings.mockResolvedValue({ authMode, ssoType, ...OIDC, ...SAML });
    const req = new Request("http://localhost/x", {
      method: "POST",
      body: JSON.stringify({ password: "wrong" }),
    });

    const o = await oidcStart(new Request("http://localhost/api/auth/oidc/start"));
    expect(o.location.startsWith("https://idp.test/authorize")).toBe(exp.oidc);
    if (!exp.oidc) expect(o.location).toContain("error=oidc_not_configured");

    const s = await samlStart(new Request("http://localhost/api/auth/saml/start"));
    expect(s.location === "https://idp.test/saml").toBe(exp.saml);

    const l = await login(req);
    // SSO-only with a configured protocol refuses passwords (403); otherwise the password is checked (401).
    expect(l.status).toBe(exp.ssoOnly ? 403 : 401);
  });

  it("SSO-only with an unconfigured protocol keeps password login as recovery", async () => {
    mocks.getSettings.mockResolvedValue({ authMode: "sso", ssoType: "oidc" });
    const l = await login(
      new Request("http://localhost/x", {
        method: "POST",
        body: JSON.stringify({ password: "wrong" }),
      }),
    );
    expect(l.status).toBe(401);
  });
});

describe("describeLoginError", () => {
  it("maps known codes, passes unknown text through truncated, ignores empty", () => {
    expect(describeLoginError("oidc_invalid_state")).toMatch(/expired/);
    expect(describeLoginError("")).toBe("");
    expect(describeLoginError(null)).toBe("");
    expect(describeLoginError("x".repeat(300))).toHaveLength(200);
  });
});
