import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn() }));

const { verifyOidcIdToken } = await import("../../src/lib/auth/oidc.js");

const ISSUER = "https://idp.example.test";
const AUDIENCE = "client-id";
const SECRET = "client-secret-value-0123456789abcdef";
const NONCE = "nonce-123";

let server;
let jwksUri;
let privateKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  jwksUri = `http://127.0.0.1:${server.address().port}/jwks`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

function sign(alg, key, claims = {}) {
  return new SignJWT({ nonce: NONCE, ...claims })
    .setProtectedHeader({ alg, kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject("user-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}

const hsKey = (secret = SECRET) => new TextEncoder().encode(secret);

const verify = (idToken, extra = {}) =>
  verifyOidcIdToken({
    idToken,
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUri,
    nonce: NONCE,
    clientSecret: SECRET,
    ...extra,
  });

describe("verifyOidcIdToken", () => {
  it("verifies RS256 via JWKS (alg list absent -> asymmetric default)", async () => {
    const payload = await verify(await sign("RS256", privateKey));
    expect(payload.sub).toBe("user-1");
  });

  it("verifies HS256 signed with the client secret when advertised", async () => {
    const payload = await verify(await sign("HS256", hsKey()), { allowedAlgs: ["HS256"] });
    expect(payload.sub).toBe("user-1");
  });

  it("rejects HS256 signed with the wrong secret", async () => {
    const token = await sign("HS256", hsKey("another-secret-another-secret-00000"));
    await expect(verify(token, { allowedAlgs: ["HS256"] })).rejects.toThrow();
  });

  it("rejects alg none", async () => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const token = `${b64({ alg: "none" })}.${b64({ iss: ISSUER, aud: AUDIENCE, nonce: NONCE })}.`;
    await expect(verify(token, { allowedAlgs: ["none", "RS256"] })).rejects.toThrow(/not allowed/);
  });

  it("rejects HS256 when the provider advertises only RS256", async () => {
    const token = await sign("HS256", hsKey());
    await expect(verify(token, { allowedAlgs: ["RS256"] })).rejects.toThrow(/not allowed/);
  });

  it("rejects HS256 when no algs are advertised (asymmetric default)", async () => {
    const token = await sign("HS256", hsKey());
    await expect(verify(token, { allowedAlgs: undefined })).rejects.toThrow(/not allowed/);
  });

  it("rejects a nonce mismatch", async () => {
    const token = await sign("RS256", privateKey, { nonce: "other" });
    await expect(verify(token)).rejects.toThrow(/nonce mismatch/);
  });
});
