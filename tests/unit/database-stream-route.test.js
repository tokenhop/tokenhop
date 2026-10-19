// YAN-1013: streamed instance snapshot transfer on /api/settings/database.
// Raw upload (x-tokenhop-snapshot-upload: raw) must finish ALL authentication
// from headers before a single body byte is read; GET streams the staged file.
// The core snapshot layer is mocked; databaseTransfer.js runs for real.
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/localDb", () => ({
  exportDbToFile: vi.fn(),
  getSettings: vi.fn(async () => ({})),
  importDb: vi.fn(),
  importDbStream: vi.fn(),
}));
vi.mock("@/lib/auth/cliToken", () => ({ hasValidCliToken: () => false }));
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("@/lib/users/audit.js", () => ({ audit: vi.fn() }));
vi.mock("@/lib/auth/loginLimiter.js", async (orig) => ({
  ...(await orig()),
  checkLoginLocks: vi.fn(() => ({ locked: false })),
  recordLoginFail: vi.fn(),
  clearAccount: vi.fn(),
}));
vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardPassword: vi.fn(async (pw) => pw === "legacy-pw"),
  getDashboardAuthSession: vi.fn(async () => null),
}));
vi.mock("@/lib/auth/sameOrigin.js", () => ({
  isCrossSite: vi.fn(() => false),
  isJson: vi.fn(() => true),
}));
vi.mock("@/lib/users/featureSwitch", () => ({
  requireMultiUser: vi.fn(),
  isMultiUserEnabled: vi.fn(),
}));
vi.mock("@/lib/users/userManagement.js", async () => {
  const { NextResponse } = await import("next/server");
  class PayloadTooLarge extends Error {}
  return {
    PayloadTooLarge,
    json: (body, status = 200, headers = {}) => NextResponse.json(body, { status, headers }),
    payloadTooLarge: () => NextResponse.json({ error: "Payload too large" }, { status: 413 }),
    readJsonBody: async (request) => {
      try {
        return JSON.parse(await request.text());
      } catch {
        return null;
      }
    },
  };
});
vi.mock("@/lib/users/session", () => ({ getPrincipal: vi.fn(async () => null) }));
vi.mock("@/lib/db/repos/usersRepo.js", () => ({
  getUserUnscoped: vi.fn(),
  getUserPasswordHashUnscoped: vi.fn(),
}));

const db = await import("@/lib/localDb");
const featureSwitch = await import("@/lib/users/featureSwitch");
const audit = await import("@/lib/users/audit.js");
const session = await import("@/lib/users/session");
const userRepo = await import("@/lib/db/repos/usersRepo.js");
const dash = await import("@/lib/auth/dashboardSession");
const route = await import("@/app/api/settings/database/route.js");

const RAW = { "x-tokenhop-snapshot-upload": "raw" };
const TOKEN = "tok";
const withToken = (req) =>
  Object.assign(req, {
    cookies: { get: (n) => (n === "auth_token" ? { value: TOKEN } : undefined) },
  });

/** A raw upload whose body stream records whether anything ever pulled from it. */
function rawRequest(headers = {}, text = '{"settings":{"multiUserEnabled":true}}') {
  const state = { pulled: false };
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream(
    {
      pull(controller) {
        state.pulled = true;
        controller.enqueue(bytes);
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request("http://localhost/api/settings/database", {
    method: "POST",
    headers: { "content-type": "application/json", ...RAW, ...headers },
    body,
    duplex: "half",
  });
  return { request: withToken(request), state };
}

const legacyJson = (body) =>
  withToken(
    new Request("http://localhost/api/settings/database", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const asPrincipal = (instanceRole) => {
  featureSwitch.isMultiUserEnabled.mockResolvedValue(true);
  session.getPrincipal.mockResolvedValue({
    userId: "actor-1",
    instanceRole,
    via: "session",
    workspaceIds: [],
    workspaceRoles: {},
  });
  userRepo.getUserUnscoped.mockImplementation(async () => ({
    id: "actor-1",
    instanceRole,
    status: "active",
    sessionVersion: 3,
  }));
  userRepo.getUserPasswordHashUnscoped.mockImplementation(async () => {
    const bcrypt = await import("bcryptjs");
    return bcrypt.hash("actor-pw", 4);
  });
  dash.getDashboardAuthSession.mockImplementation(async (tok) =>
    tok === TOKEN ? { sub: "actor-1", sv: 3 } : null,
  );
};

const savedCap = process.env.TOKENHOP_INSTANCE_IMPORT_MAX_BODY_SIZE;

beforeEach(() => {
  vi.clearAllMocks();
  featureSwitch.isMultiUserEnabled.mockResolvedValue(false);
  session.getPrincipal.mockImplementation(async () => null);
  db.importDbStream.mockReset().mockResolvedValue(undefined);
  db.importDb.mockReset().mockResolvedValue(undefined);
  db.exportDbToFile.mockReset();
  delete process.env.TOKENHOP_INSTANCE_IMPORT_MAX_BODY_SIZE;
});
afterEach(() => {
  if (savedCap === undefined) delete process.env.TOKENHOP_INSTANCE_IMPORT_MAX_BODY_SIZE;
  else process.env.TOKENHOP_INSTANCE_IMPORT_MAX_BODY_SIZE = savedCap;
});

describe("raw POST authenticates before reading the body", () => {
  it("legacy: missing or wrong password is 401 and the body is never pulled", async () => {
    for (const headers of [{}, { "x-9r-password": "nope" }]) {
      const { request, state } = rawRequest(headers);
      const res = await route.POST(request);
      expect(res.status).toBe(401);
      expect(state.pulled).toBe(false);
    }
    expect(db.importDbStream).not.toHaveBeenCalled();
    expect(db.importDb).not.toHaveBeenCalled();
  });

  it("invalid force header or oversized passphrase header is 400 with no read", async () => {
    const badForce = rawRequest({ "x-9r-password": "legacy-pw", "x-tokenhop-import-force": "1" });
    expect((await route.POST(badForce.request)).status).toBe(400);
    expect(badForce.state.pulled).toBe(false);
    const bigPass = rawRequest({
      "x-9r-password": "legacy-pw",
      "x-tokenhop-backup-passphrase": "x".repeat(2048),
    });
    expect((await route.POST(bigPass.request)).status).toBe(400);
    expect(bigPass.state.pulled).toBe(false);
    expect(db.importDbStream).not.toHaveBeenCalled();
  });

  it("switch on: force without the owner role is 403 before re-auth, no read", async () => {
    asPrincipal("admin");
    const { request, state } = rawRequest({
      "x-9r-password": "actor-pw",
      "x-tokenhop-import-force": "true",
    });
    const res = await route.POST(request);
    expect(res.status).toBe(403);
    expect(state.pulled).toBe(false);
    expect(db.importDbStream).not.toHaveBeenCalled();
    expect(audit.audit).toHaveBeenCalledWith(
      expect.anything(),
      "db.import",
      { type: "database" },
      { result: "denied", after: { reason: "force_forbidden" } },
    );
  });

  it("switch on: wrong or missing re-auth is rejected with no read", async () => {
    asPrincipal("owner");
    for (const headers of [{ "x-9r-password": "wrong" }, {}]) {
      const { request, state } = rawRequest(headers);
      const res = await route.POST(request);
      expect(res.status).toBe(401);
      expect(state.pulled).toBe(false);
    }
    // Password AND proof together: exactly-one rule, still before any read.
    const both = rawRequest({ "x-9r-password": "actor-pw", "x-tokenhop-sso-proof": "p" });
    expect((await route.POST(both.request)).status).toBe(400);
    expect(both.state.pulled).toBe(false);
    expect(db.importDbStream).not.toHaveBeenCalled();
  });

  it("switch on: a non-admin principal is 403 with no read", async () => {
    asPrincipal("user");
    const { request, state } = rawRequest({ "x-9r-password": "actor-pw" });
    expect((await route.POST(request)).status).toBe(403);
    expect(state.pulled).toBe(false);
  });

  it("Content-Length over the cap is 413 without reading (even when authenticated)", async () => {
    process.env.TOKENHOP_INSTANCE_IMPORT_MAX_BODY_SIZE = "1kb";
    const { request, state } = rawRequest({
      "x-9r-password": "legacy-pw",
      "content-length": "2048",
    });
    const res = await route.POST(request);
    expect(res.status).toBe(413);
    expect(state.pulled).toBe(false);
    expect(db.importDbStream).not.toHaveBeenCalled();
  });
});

describe("raw POST success path", () => {
  it("streams the body to importDbStream with header auth and the YAN-351 strip", async () => {
    process.env.TOKENHOP_INSTANCE_IMPORT_MAX_BODY_SIZE = "1mb";
    const { request } = rawRequest({
      "x-9r-password": "legacy-pw",
      "x-tokenhop-backup-passphrase": "top-secret",
      "x-tokenhop-import-force": "true",
      "content-length": "100",
    });
    const res = await route.POST(request);
    expect(res.status).toBe(200);
    const [body, opts] = db.importDbStream.mock.calls[0];
    expect(body).toBe(request.body);
    expect(opts).toMatchObject({
      maxBytes: 1024 * 1024,
      declaredBytes: 100,
      passphrase: "top-secret",
      force: true,
      actor: { owner: true, via: "legacy" },
    });
    expect(opts).not.toHaveProperty("password");
    // The head transform drops the multi-user switch from plain settings only.
    expect(opts.transformHead({ settings: { multiUserEnabled: true, a: 1 } })).toEqual({
      settings: { a: 1 },
    });
    const sealed = { settings: { ct: "x", iv: "y", multiUserEnabled: true } };
    expect(opts.transformHead(sealed).settings.multiUserEnabled).toBe(true);
    expect(db.importDb).not.toHaveBeenCalled();
  });

  it("audit rows never carry the password, passphrase or proof", async () => {
    const { request } = rawRequest({
      "x-9r-password": "legacy-pw",
      "x-tokenhop-backup-passphrase": "top-secret",
    });
    expect((await route.POST(request)).status).toBe(200);
    db.importDbStream.mockRejectedValueOnce(
      Object.assign(new Error("top-secret legacy-pw"), { code: "PASSPHRASE_INVALID" }),
    );
    const failed = rawRequest({
      "x-9r-password": "legacy-pw",
      "x-tokenhop-backup-passphrase": "top-secret",
    });
    expect((await route.POST(failed.request)).status).toBe(400);
    expect(audit.audit).toHaveBeenCalled();
    expect(JSON.stringify(audit.audit.mock.calls)).not.toMatch(/top-secret|legacy-pw/);
  });

  it("maps IMPORT_DISK_INSUFFICIENT to 507 with the server message", async () => {
    const message = "Not enough free disk space (old pre-import-* backups can be removed)";
    db.importDbStream.mockRejectedValueOnce(
      Object.assign(new Error(message), { code: "IMPORT_DISK_INSUFFICIENT" }),
    );
    const { request } = rawRequest({ "x-9r-password": "legacy-pw" });
    const res = await route.POST(request);
    expect(res.status).toBe(507);
    const body = await res.json();
    expect(body).toEqual({ error: message, code: "IMPORT_DISK_INSUFFICIENT" });
    expect(body.error).toContain("pre-import-");
  });

  it("maps IMPORT_PAYLOAD_TOO_LARGE to 413 and IMPORT_JSON_INVALID to a 400 + failure audit", async () => {
    db.importDbStream.mockRejectedValueOnce(
      Object.assign(new Error("too big"), { code: "IMPORT_PAYLOAD_TOO_LARGE" }),
    );
    const big = rawRequest({ "x-9r-password": "legacy-pw" });
    expect((await route.POST(big.request)).status).toBe(413);

    audit.audit.mockClear();
    db.importDbStream.mockRejectedValueOnce(
      Object.assign(new Error("Unexpected token"), { code: "IMPORT_JSON_INVALID" }),
    );
    const bad = rawRequest({ "x-9r-password": "legacy-pw" });
    const res = await route.POST(bad.request);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request", code: "invalid_request" });
    expect(audit.audit).toHaveBeenCalledWith(
      expect.anything(),
      "db.import",
      { type: "database" },
      { result: "failure", after: { reason: "IMPORT_JSON_INVALID" } },
    );
  });
});

describe("legacy JSON POST is unchanged", () => {
  it("still reads the JSON body, strips control keys and calls importDb", async () => {
    const res = await route.POST(
      legacyJson({ password: "legacy-pw", marker: 1, settings: { multiUserEnabled: true } }),
    );
    expect(res.status).toBe(200);
    const [payload, opts] = db.importDb.mock.calls[0];
    expect(payload).toEqual({ marker: 1, settings: {} });
    expect(opts.actor).toEqual({ owner: true, via: "legacy" });
    expect(db.importDbStream).not.toHaveBeenCalled();
  });

  it("a wrong password is still 401", async () => {
    expect((await route.POST(legacyJson({ password: "nope" }))).status).toBe(401);
    expect(db.importDb).not.toHaveBeenCalled();
  });
});

describe("GET streams the staged export", () => {
  const handleOf = (text = '{"schemaVersion":9}') => ({
    size: Buffer.byteLength(text),
    openStream: vi.fn(() => Readable.from([Buffer.from(text)])),
    cleanup: vi.fn(async () => {}),
  });
  const get = (headers = { "x-9r-password": "legacy-pw" }) =>
    route.GET(
      withToken(new Request("http://localhost/api/settings/database", { headers: { ...headers } })),
    );

  it("returns Content-Length, no-store, JSON content type and the file bytes", async () => {
    const handle = handleOf();
    db.exportDbToFile.mockResolvedValueOnce(handle);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(handle.size));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.text()).toBe('{"schemaVersion":9}');
    expect(handle.cleanup).not.toHaveBeenCalled();
    expect(audit.audit).toHaveBeenCalledWith(
      expect.anything(),
      "db.export",
      { type: "database" },
      { after: { method: "plain" } },
    );
  });

  it("an audit failure cleans up the staged file and answers 500", async () => {
    const handle = handleOf();
    db.exportDbToFile.mockResolvedValueOnce(handle);
    audit.audit.mockRejectedValueOnce(new Error("audit down"));
    const res = await get();
    expect(res.status).toBe(500);
    expect(handle.cleanup).toHaveBeenCalledTimes(1);
    expect(handle.openStream).not.toHaveBeenCalled();
  });

  it("denies a bad password without exporting", async () => {
    const res = await get({ "x-9r-password": "nope" });
    expect(res.status).toBe(401);
    expect(db.exportDbToFile).not.toHaveBeenCalled();
    expect(res).toBeInstanceOf(NextResponse);
  });
});
