import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn() }));

const { verifyOidcIdToken, fetchOidcUserInfo } = await import("../../src/lib/auth/oidc.js");
const { readGroupsClaim, normalizeGroups, resolveAssignments } = await import(
  "../../src/lib/users/ssoProvisioning.js"
);

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

  it("refuses to verify without the login nonce", async () => {
    const token = await sign("RS256", privateKey);
    await expect(verify(token, { nonce: "" })).rejects.toThrow(/requires the login nonce/);
  });
});

describe("readGroupsClaim", () => {
  it("reads nested dot paths; dotted literal key unreachable via walk", () => {
    const src = { realm: { access: { groups: ["a", "b"] } }, "a.b": ["lit"] };
    expect(readGroupsClaim(src, "realm.access.groups")).toEqual({
      present: true,
      groups: ["a", "b"],
      invalid: false,
    });
    expect(readGroupsClaim(src, "a.b").present).toBe(false);
  });

  it("reads a literal top-level key containing no dots", () => {
    expect(readGroupsClaim({ groups: ["x"] }, "groups").groups).toEqual(["x"]);
  });

  it("accepts scalar string and array", () => {
    expect(readGroupsClaim({ groups: "admins" }, "groups").groups).toEqual(["admins"]);
    expect(readGroupsClaim({ groups: ["x", "y"] }, "groups").groups).toEqual(["x", "y"]);
  });

  it("distinguishes absent from explicit empty array", () => {
    expect(readGroupsClaim({}, "groups")).toEqual({ present: false, groups: null, invalid: false });
    expect(readGroupsClaim({ groups: null }, "groups.deeper").present).toBe(false);
    expect(readGroupsClaim({ groups: [] }, "groups")).toEqual({
      present: true,
      groups: [],
      invalid: false,
    });
  });

  it("flags present claims with a bad top-level shape as invalid", () => {
    for (const bad of [42, true, null, { a: 1 }, 0]) {
      expect(readGroupsClaim({ groups: bad }, "groups")).toEqual({
        present: true,
        groups: null,
        invalid: true,
      });
    }
  });

  it("rejects malformed paths: empty, empty segments, non-string, too deep", () => {
    for (const path of ["", ".", "groups.", ".groups", "a..b", undefined, null, 5, "a.b.c.d.e.f"]) {
      expect(readGroupsClaim({ groups: ["x"] }, path)).toEqual({
        present: false,
        groups: null,
        invalid: true,
      });
    }
    expect(readGroupsClaim({ a: { b: { c: { d: { e: ["ok"] } } } } }, "a.b.c.d.e").groups).toEqual([
      "ok",
    ]);
  });

  it("rejects dangerous path segments", () => {
    const src = JSON.parse('{"__proto__":{"groups":["x"]},"a":{"constructor":["x"]}}');
    for (const path of ["__proto__.groups", "a.constructor", "a.prototype", "constructor"]) {
      expect(readGroupsClaim(src, path).invalid).toBe(true);
    }
  });

  it("only walks own properties", () => {
    expect(readGroupsClaim(Object.create({ groups: ["leak"] }), "groups").present).toBe(false);
    expect(readGroupsClaim({ a: "str" }, "a.length").present).toBe(false);
  });

  it("does not mutate the source", () => {
    const src = { realm: { groups: ["a", "a", 5, ""] } };
    const snapshot = structuredClone(src);
    readGroupsClaim(src, "realm.groups");
    expect(src).toEqual(snapshot);
  });
});

describe("normalizeGroups", () => {
  it("dedupes, keeps case-sensitive names, never CSV-splits", () => {
    expect(normalizeGroups(["A", "a", "A"]).groups).toEqual(["A", "a"]);
    expect(normalizeGroups("a,b").groups).toEqual(["a,b"]);
  });

  it("drops non-string, empty, oversize and unsafe-name entries", () => {
    const { groups, invalid } = normalizeGroups([
      "ok",
      "",
      5,
      null,
      { name: "obj" },
      ["nested"],
      "x".repeat(257),
      "__proto__",
      "constructor",
      "prototype",
      "x".repeat(256),
    ]);
    expect(invalid).toBe(false);
    expect(groups).toEqual(["ok", "x".repeat(256)]);
  });

  it("caps at 100 valid entries", () => {
    const many = Array.from({ length: 5000 }, (_, i) => `g${i}`);
    const { groups } = normalizeGroups(many);
    expect(groups).toHaveLength(100);
    expect(groups[99]).toBe("g99");
  });

  it("marks non-string/array top-level values invalid", () => {
    for (const bad of [undefined, null, 1, {}, true]) {
      expect(normalizeGroups(bad)).toEqual({ groups: null, invalid: true });
    }
  });

  it("does not mutate input arrays", () => {
    const input = ["a", "a", ""];
    normalizeGroups(input);
    expect(input).toEqual(["a", "a", ""]);
  });
});

describe("resolveAssignments", () => {
  const map = [
    { group: "eng", workspaceId: "ws1", role: "viewer" },
    { group: "leads", workspaceId: "ws1", role: "manager" },
    { group: "eng", workspaceId: "ws2", role: "member" },
    { group: "ops", workspaceId: "ws3", role: "manager" },
    { group: "eng", workspaceId: "ws4", role: "owner" },
    { group: "eng", workspaceId: 7, role: "member" },
    null,
  ];

  it("empty allow-list admits everyone; no admin match; no memberships", () => {
    expect(resolveAssignments([], {})).toEqual({ admit: true, adminMatch: false, memberships: [] });
    expect(resolveAssignments(undefined, undefined).admit).toBe(true);
  });

  it("non-empty allow-list requires a matching group", () => {
    const settings = { ssoAllowedGroups: ["staff"] };
    expect(resolveAssignments(["other"], settings).admit).toBe(false);
    expect(resolveAssignments([], settings).admit).toBe(false);
    expect(resolveAssignments(["other", "staff"], settings).admit).toBe(true);
  });

  it("matches are case-sensitive and flag admin groups", () => {
    const settings = { ssoAllowedGroups: ["Staff"], ssoAdminGroups: ["Admins"] };
    expect(resolveAssignments(["staff"], settings).admit).toBe(false);
    expect(resolveAssignments(["Staff", "Admins"], settings)).toMatchObject({
      admit: true,
      adminMatch: true,
    });
    expect(resolveAssignments(["Staff"], settings).adminMatch).toBe(false);
  });

  it("picks highest mapped role per workspace and ignores invalid rows", () => {
    const { memberships } = resolveAssignments(["eng", "leads", "ops"], {
      ssoGroupWorkspaceMap: map,
    });
    expect(memberships).toHaveLength(3);
    expect(memberships).toEqual(
      expect.arrayContaining([
        { workspaceId: "ws1", role: "manager" },
        { workspaceId: "ws2", role: "member" },
        { workspaceId: "ws3", role: "manager" },
      ]),
    );
  });

  it("uses the weaker role when only the weaker group matches", () => {
    const { memberships } = resolveAssignments(["eng"], { ssoGroupWorkspaceMap: map });
    expect(memberships).toContainEqual({ workspaceId: "ws1", role: "viewer" });
  });

  it("does not mutate groups or settings", () => {
    const groups = ["eng", "leads"];
    const settings = {
      ssoAllowedGroups: ["eng"],
      ssoAdminGroups: ["leads"],
      ssoGroupWorkspaceMap: structuredClone(map.slice(0, 4)),
    };
    const gs = structuredClone(groups);
    const ss = structuredClone(settings);
    resolveAssignments(groups, settings);
    expect(groups).toEqual(gs);
    expect(settings).toEqual(ss);
  });
});

describe("fetchOidcUserInfo", () => {
  const ENDPOINT = "https://idp.example.test/userinfo";
  const call = (extra = {}) =>
    fetchOidcUserInfo({
      userinfoEndpoint: ENDPOINT,
      accessToken: "at-secret",
      expectedSub: "user-1",
      expectedIssuer: ISSUER,
      ...extra,
    });
  const respond = (body, status = 200) =>
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (body instanceof Error) throw body;
        return body;
      },
    }));

  afterEach(() => vi.unstubAllGlobals());

  it("returns data; sends bearer/no-store/no-redirect with a timeout signal", async () => {
    const fetchMock = respond({ sub: "user-1", groups: ["a"] });
    vi.stubGlobal("fetch", fetchMock);
    await expect(call()).resolves.toEqual({ sub: "user-1", groups: ["a"] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(init.headers.Authorization).toBe("Bearer at-secret");
    expect(init.cache).toBe("no-store");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("accepts an absent iss", async () => {
    vi.stubGlobal("fetch", respond({ sub: "user-1" }));
    await expect(call()).resolves.toMatchObject({ sub: "user-1" });
  });

  it("accepts a matching present iss", async () => {
    vi.stubGlobal("fetch", respond({ sub: "user-1", iss: ISSUER }));
    await expect(call()).resolves.toMatchObject({ iss: ISSUER });
  });

  it("rejects a present mismatching, empty or non-string iss", async () => {
    for (const iss of ["https://evil.test", "", 5, null]) {
      vi.stubGlobal("fetch", respond({ sub: "user-1", iss }));
      await expect(call()).rejects.toThrow(/issuer mismatch/);
    }
  });

  it("rejects wrong, missing, empty and non-string sub", async () => {
    for (const sub of ["user-2", "User-1", "", undefined, 1]) {
      vi.stubGlobal("fetch", respond({ sub }));
      await expect(call()).rejects.toThrow(/subject mismatch/);
    }
  });

  it("requires a verified expectedSub, endpoint and access token before fetching", async () => {
    const fetchMock = respond({ sub: "user-1" });
    vi.stubGlobal("fetch", fetchMock);
    await expect(call({ expectedSub: "" })).rejects.toThrow(/verified subject/);
    await expect(call({ expectedSub: undefined })).rejects.toThrow(/verified subject/);
    await expect(call({ userinfoEndpoint: "" })).rejects.toThrow(/endpoint and access token/);
    await expect(call({ accessToken: "" })).rejects.toThrow(/endpoint and access token/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-2xx without leaking the token", async () => {
    vi.stubGlobal("fetch", respond({ error: "invalid_token" }, 401));
    const err = await call().catch((e) => e);
    expect(err.message).toMatch(/failed \(401\)/);
    expect(err.message).not.toContain("at-secret");
  });

  it("rejects non-JSON bodies", async () => {
    vi.stubGlobal("fetch", respond(new SyntaxError("bad json")));
    await expect(call()).rejects.toThrow(/not valid JSON/);
  });

  it("rejects unexpected JSON shapes", async () => {
    for (const body of [[], "str", 5]) {
      vi.stubGlobal("fetch", respond(body));
      await expect(call()).rejects.toThrow(/unexpected shape/);
    }
    vi.stubGlobal("fetch", respond(null));
    await expect(call()).rejects.toThrow(/unexpected shape/);
  });

  it("propagates fetch timeout and network failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("timed out", "TimeoutError");
      }),
    );
    await expect(call()).rejects.toMatchObject({ name: "TimeoutError" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(call()).rejects.toThrow(/fetch failed/);
  });
});
