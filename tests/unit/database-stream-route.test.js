import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({})),
  importDb: vi.fn(),
}));
vi.mock("@/lib/db/index.js", async (orig) => ({
  ...(await orig()),
  exportDbToFile: vi.fn(),
  importDbStream: vi.fn(),
}));
vi.mock("@/lib/auth/cliToken", () => ({ hasValidCliToken: vi.fn(async () => false) }));
vi.mock("@/lib/users/ssoDataProof.js", () => ({ consumeDataTransferProof: vi.fn() }));
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

const db = { ...(await import("@/lib/db/index.js")), ...(await import("@/lib/localDb")) };
const cliToken = await import("@/lib/auth/cliToken");
const ssoData = await import("@/lib/users/ssoDataProof.js");
const limiter = await import("@/lib/auth/loginLimiter.js");
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
function rawRequest(headers = {}, text = '{"settings":{"multiUserEnabled":true}}', events = null) {
  const state = { pulled: false };
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream(
    {
      pull(controller) {
        state.pulled = true;
        events?.push("pull");
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

const _legacyJson = (body) =>
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
  cliToken.hasValidCliToken.mockReset().mockResolvedValue(false);
  ssoData.consumeDataTransferProof.mockReset();
  limiter.checkLoginLocks.mockReset().mockReturnValue({ locked: false });
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

  it("Content-Length over the cap is 413 BEFORE re-auth: a valid SSO proof is not consumed", async () => {
    process.env.TOKENHOP_INSTANCE_IMPORT_MAX_BODY_SIZE = "1kb";
    asPrincipal("owner");
    const { request, state } = rawRequest({
      "x-tokenhop-sso-proof": "good-proof",
      "content-length": "2048",
    });
    const res = await route.POST(request);
    expect(res.status).toBe(413);
    expect(ssoData.consumeDataTransferProof).not.toHaveBeenCalled();
    expect(limiter.checkLoginLocks).not.toHaveBeenCalled();
    expect(userRepo.getUserPasswordHashUnscoped).not.toHaveBeenCalled();
    expect(state.pulled).toBe(false);
    expect(db.importDbStream).not.toHaveBeenCalled();
  });

  it("switch on: an IP/passphrase lock is 429 with no re-auth and no read", async () => {
    asPrincipal("owner");
    limiter.checkLoginLocks.mockReturnValue({ locked: true, retryAfter: 30 });
    const { request, state } = rawRequest({ "x-9r-password": "actor-pw" });
    const res = await route.POST(request);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(state.pulled).toBe(false);
    expect(userRepo.getUserPasswordHashUnscoped).not.toHaveBeenCalled();
    expect(db.importDbStream).not.toHaveBeenCalled();
  });

  it("legacy: an IP/passphrase lock is 429 after the password check, no read", async () => {
    limiter.checkLoginLocks.mockReturnValue({ locked: true, retryAfter: 30 });
    const { request, state } = rawRequest({ "x-9r-password": "legacy-pw" });
    expect((await route.POST(request)).status).toBe(429);
    expect(state.pulled).toBe(false);
    expect(db.importDbStream).not.toHaveBeenCalled();
  });

  it("switch on: an invalid or replayed SSO proof is 401 with no read", async () => {
    asPrincipal("owner");
    const { TenancyError } = await import("@/lib/users/errors.js");
    ssoData.consumeDataTransferProof.mockImplementation(() => {
      throw new TenancyError("REAUTH_REQUIRED", "Fresh authentication required");
    });
    for (let i = 0; i < 2; i++) {
      const { request, state } = rawRequest({ "x-tokenhop-sso-proof": "replayed" });
      const res = await route.POST(request);
      expect(res.status).toBe(401);
      expect(state.pulled).toBe(false);
    }
    expect(ssoData.consumeDataTransferProof).toHaveBeenCalledTimes(2);
    expect(db.importDbStream).not.toHaveBeenCalled();
  });
});

describe("raw POST accepted auth paths read the body only afterwards", () => {
  const drain = async (stream) => {
    const reader = stream.getReader();
    while (!(await reader.read()).done);
  };

  it("switch on: a valid SSO proof is consumed, then the body is first pulled", async () => {
    asPrincipal("owner");
    const events = [];
    ssoData.consumeDataTransferProof.mockImplementation(() => {
      events.push("consume");
    });
    userRepo.getUserUnscoped.mockImplementation(async () => {
      events.push("live-reread");
      return { id: "actor-1", instanceRole: "owner", status: "active", sessionVersion: 3 };
    });
    db.importDbStream.mockImplementation(async (body) => {
      events.push("import");
      await drain(body);
    });
    const { request, state } = rawRequest(
      { "x-tokenhop-sso-proof": "good-proof" },
      undefined,
      events,
    );
    const res = await route.POST(request);
    expect(res.status).toBe(200);
    expect(ssoData.consumeDataTransferProof).toHaveBeenCalledTimes(1);
    expect(state.pulled).toBe(true);
    expect(events).toEqual(["consume", "live-reread", "import", "pull"]);
    expect(audit.audit).toHaveBeenCalledWith(
      expect.anything(),
      "db.import",
      { type: "database" },
      { after: { method: "plain", reauth: "sso" } },
    );
  });

  it("legacy: a valid CLI token is accepted without a password, body read after auth", async () => {
    const events = [];
    cliToken.hasValidCliToken.mockImplementation(async () => {
      events.push("cli-token");
      return true;
    });
    db.importDbStream.mockImplementation(async (body) => {
      events.push("import");
      await drain(body);
    });
    const { request, state } = rawRequest({}, undefined, events);
    const res = await route.POST(request);
    expect(res.status).toBe(200);
    expect(dash.verifyDashboardPassword).not.toHaveBeenCalled();
    expect(state.pulled).toBe(true);
    expect(events).toEqual(["cli-token", "import", "pull"]);
    expect(db.importDbStream.mock.calls[0][1].actor).toEqual({ owner: true, via: "legacy" });
  });
});
