import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSettings: vi.fn() }));

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => ({ status: init?.status || 200, body }) },
}));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));

const { POST } = await import("../../src/app/api/auth/oidc/test/route.js");

const ISSUER = "https://idp.example.test";
const JWKS = `${ISSUER}/jwks`;

function stubFetch({ algs, keys }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const json = (data, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => data });
      if (String(url).endsWith("/.well-known/openid-configuration")) {
        return json({
          issuer: ISSUER,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: JWKS,
          ...(algs ? { id_token_signing_alg_values_supported: algs } : {}),
        });
      }
      if (url === JWKS) return json({ keys });
      return json({ error: "invalid_grant" }, false); // token endpoint probe
    }),
  );
}

const call = () =>
  POST({
    url: "http://localhost/api/auth/oidc/test",
    headers: new Headers(),
    json: async () => ({ issuerUrl: ISSUER, clientId: "cid" }),
  });

describe("POST /api/auth/oidc/test signing report", () => {
  beforeEach(() => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("warns when the provider only signs with HS*", async () => {
    stubFetch({ algs: ["HS256"], keys: [] });
    const { body } = await call();
    expect(body.signingAlgs).toEqual(["HS256"]);
    expect(body.jwksKeyCount).toBe(0);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toMatch(/only with HS\*/);
  });

  it("warns about an empty JWKS when RS256 is advertised", async () => {
    stubFetch({ algs: ["RS256"], keys: [] });
    const { body } = await call();
    expect(body.jwksKeyCount).toBe(0);
    expect(body.warnings[0]).toMatch(/JWKS has no keys/);
  });

  it("reports no warnings for a healthy RS256 provider", async () => {
    stubFetch({ algs: ["RS256"], keys: [{ kty: "RSA" }] });
    const { body } = await call();
    expect(body.jwksKeyCount).toBe(1);
    expect(body.warnings).toEqual([]);
  });

  it("discovery failure returns redacted JSON 500 without leaking the body secret", async () => {
    const secret = "oidc-body-super-secret-123";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`discovery boom echoing ${secret}`);
      }),
    );
    const res = await POST({
      url: "http://localhost/api/auth/oidc/test",
      headers: new Headers(),
      json: async () => ({ issuerUrl: ISSUER, clientId: "cid", clientSecret: secret }),
    });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(res.body.error).toContain("[REDACTED]");
  });

  it("settings/decrypt failure still returns JSON 500 instead of throwing", async () => {
    mocks.getSettings.mockRejectedValueOnce(
      Object.assign(new Error("decrypt boom"), { code: "DECRYPT_FAILED" }),
    );
    mocks.getSettings.mockRejectedValue(
      Object.assign(new Error("decrypt boom"), { code: "DECRYPT_FAILED" }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("unreachable");
      }),
    );
    const res = await POST({
      url: "http://localhost/api/auth/oidc/test",
      headers: new Headers(),
      json: async () => ({ issuerUrl: ISSUER, clientId: "cid" }),
    });
    expect(res.status).toBe(500);
    expect(typeof res.body.error).toBe("string");
  });
});
