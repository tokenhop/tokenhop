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

// Pin the users & teams switch off: featureSwitch captures the env override at
// module load, and this file asserts the legacy authMode × ssoType refusal
// matrix. Established (multi-user) login semantics live in password-login.test.js.
process.env.TOKENHOP_MULTI_USER = "off";

const { resolveAuthModes } = await import("@/lib/auth/authModes");
const { describeLoginError } = await import("@/app/login/loginErrors");
const oidcStart = (await import("@/app/api/auth/oidc/start/route.js")).GET;
const samlStart = (await import("@/app/api/auth/saml/start/route.js")).GET;
const login = (await import("@/app/api/auth/login/route.js")).POST;

const OIDC = { oidcIssuerUrl: "https://idp.test", oidcClientId: "c", oidcClientSecret: "s" };
const SAML = { samlEntryPoint: "https://idp.test/saml", samlCert: "MIIC" };
// Hand-written truth table: [authMode, ssoType, password, oidc, saml, protocol].
// Legacy "oidc"/"saml" modes name the protocol; otherwise ssoType decides (oidc by default).
const TABLE = [
  ["password", "oidc", true, false, false, "oidc"],
  ["password", "saml", true, false, false, "saml"],
  ["password", undefined, true, false, false, "oidc"],
  ["both", "oidc", true, true, false, "oidc"],
  ["both", "saml", true, false, true, "saml"],
  ["both", undefined, true, true, false, "oidc"],
  ["sso", "oidc", false, true, false, "oidc"],
  ["sso", "saml", false, false, true, "saml"],
  ["sso", undefined, false, true, false, "oidc"],
  ["oidc", "oidc", false, true, false, "oidc"],
  ["oidc", "saml", false, true, false, "oidc"],
  ["oidc", undefined, false, true, false, "oidc"],
  ["saml", "oidc", false, false, true, "saml"],
  ["saml", "saml", false, false, true, "saml"],
  ["saml", undefined, false, false, true, "saml"],
  [undefined, "oidc", true, false, false, "oidc"],
  [undefined, "saml", true, false, false, "saml"],
  [undefined, undefined, true, false, false, "oidc"],
];
const MATRIX = TABLE.map(([authMode, ssoType]) => [authMode, ssoType]);

function expected(authMode, ssoType) {
  const [, , password, oidc, saml, protocol] = TABLE.find(
    ([m, t]) => m === authMode && t === ssoType,
  );
  return { password, oidc, saml, protocol, ssoOnly: !password };
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
  it("maps known codes, never echoes unknown text, ignores empty", () => {
    expect(describeLoginError("oidc_invalid_state")).toMatch(/expired/);
    expect(describeLoginError("")).toBe("");
    expect(describeLoginError(null)).toBe("");
    expect(describeLoginError("<b>phishing</b> call +1-555")).toBe("Sign-in failed. Try again.");
    expect(describeLoginError("__proto__")).toBe("Sign-in failed. Try again.");
  });
});
