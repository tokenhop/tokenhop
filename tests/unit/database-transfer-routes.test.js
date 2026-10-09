// YAN-375 (API/auth lane): route contracts for instance DB export/import plus
// the workspace export/import routes. Switch-off 404/compat, principal gates
// (owner/admin vs user/pending; workspace owner vs manager/member/outsider),
// re-auth of the ACTING user, fresh sessionVersion binding (fail-closed when
// the claim is missing), admin force denial, structured IMPORT_USER_MISMATCH,
// request-shape rejection BEFORE any re-auth work, malformed bodies, and
// secret-free audit rows. `databaseTransfer.js` itself runs for real; the
// core snapshot layer and the multi-user plumbing are mocked.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const hidden404 = () => NextResponse.json({ error: "Not found" }, { status: 404 });

// The core transfer functions live in another lane — help the module graph
// compile before they land.
const transfer = vi.hoisted(() => ({ exportWorkspace: vi.fn(), importWorkspace: vi.fn() }));
vi.mock("@/lib/db/workspaceTransfer.js", () => transfer);

vi.mock("@/lib/localDb", () => ({
  exportDb: vi.fn(),
  getSettings: vi.fn(async () => ({})),
  importDb: vi.fn(),
}));
// Live workspace membership for the post-hash ownership re-check.
vi.mock("@/lib/db/index.js", () => ({ listWorkspaces: vi.fn() }));
vi.mock("@/lib/auth/cliToken", () => ({ hasValidCliToken: () => false }));
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("@/lib/users/audit.js", () => ({ audit: vi.fn() }));
// Re-auth plumbing this lane must NOT re-implement: keep the limiter's real
// accountKey/getClientIp shape, stub only the decision points.
vi.mock("@/lib/auth/loginLimiter.js", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    checkLoginLocks: vi.fn(() => ({ locked: false })),
    recordLoginFail: vi.fn(),
    clearAccount: vi.fn(),
  };
});
// Legacy password + sessionVersion claim source: both are decision points of
// this lane, so both are stubbed here (fail-closed sv by default).
vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardPassword: vi.fn(async (pw) => pw === "legacy-pw"),
  getDashboardAuthSession: vi.fn(async () => null),
}));
vi.mock("@/lib/auth/sameOrigin.js", () => ({
  isCrossSite: vi.fn(() => false),
  isJson: vi.fn((r) => (r.headers.get("content-type") || "").includes("application/json")),
}));
vi.mock("@/lib/users/featureSwitch", () => ({
  requireMultiUser: vi.fn(),
  isMultiUserEnabled: vi.fn(),
}));
// Shared HTTP/user-management helpers (json/payloadTooLarge/readJsonBody):
// stubbed so the prelude's error responses stay this lane's contract.
vi.mock("@/lib/users/userManagement.js", async () => {
  const { NextResponse } = await import("next/server");
  class PayloadTooLarge extends Error {}
  return {
    PayloadTooLarge,
    json: (body, status = 200, headers = {}) => NextResponse.json(body, { status, headers }),
    payloadTooLarge: () => NextResponse.json({ error: "Payload too large" }, { status: 413 }),
    // Faithful to the real reader: declared content-length is an early exit,
    // the stream itself is byte-counted, malformed JSON answers null.
    readJsonBody: async (request, { max = 1024 } = {}) => {
      const declared = Number(request.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > max) throw new PayloadTooLarge();
      let size = 0;
      const chunks = [];
      if (request.body) {
        const reader = request.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > max) {
            reader.cancel().catch(() => {});
            throw new PayloadTooLarge();
          }
          chunks.push(value);
        }
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
const dbIndex = await import("@/lib/db/index.js");
const featureSwitch = await import("@/lib/users/featureSwitch");
const sameOrigin = await import("@/lib/auth/sameOrigin.js");
const audit = await import("@/lib/users/audit.js");
const helper = await import("@/lib/users/databaseTransfer.js");
const session = await import("@/lib/users/session");
const userRepo = await import("@/lib/db/repos/usersRepo.js");
const dash = await import("@/lib/auth/dashboardSession");
const limiter = await import("@/lib/auth/loginLimiter.js");
const { checkLoginLocks, recordLoginFail } = limiter;
const auditLog = audit.audit;

const mkSessionCtx = (role, wsRole, userId = "actor-1", wid = "ws-1") => ({
  userId,
  instanceRole: role,
  via: "session",
  workspaceIds: ["ws-1"],
  workspaceRoles: { "ws-1": wsRole },
  activeWorkspaceId: wid,
});
const requestOf = ({ method = "POST", headers = {}, body = undefined } = {}) =>
  new Request("http://localhost/x", {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const TOKEN = "tok";
const withToken = (req, token = TOKEN) =>
  Object.assign(req, {
    cookies: { get: (n) => (n === "auth_token" ? { value: token } : undefined) },
  });
const get = async (headers = {}) =>
  (await import("@/app/api/settings/database/route.js")).GET(
    withToken(new Request("http://localhost/api/settings/database", { headers: { ...headers } })),
  );
const ownerRow = (over = {}) => ({
  id: "actor-1",
  instanceRole: "owner",
  status: "active",
  sessionVersion: 3,
  ...over,
});

beforeEach(async () => {
  vi.clearAllMocks();
  // Lock-shape tests override these; every suite starts unlocked.
  limiter.checkLoginLocks.mockImplementation(() => ({ locked: false }));
  limiter.recordLoginFail.mockImplementation(() => {});
  sameOrigin.isCrossSite.mockReturnValue(false);
  featureSwitch.requireMultiUser.mockResolvedValue(null);
  featureSwitch.isMultiUserEnabled.mockResolvedValue(false);
  session.getPrincipal.mockImplementation(async () => null);
  userRepo.getUserUnscoped.mockImplementation(async () => ownerRow());
  userRepo.getUserPasswordHashUnscoped.mockImplementation(async () => {
    const bcrypt = await import("bcryptjs");
    return bcrypt.hash("actor-pw", 4);
  });
  // Verified live sv claim bound to the acting user; wrong/absent token -> no
  // claim, so the stale check fails closed.
  dash.getDashboardAuthSession.mockImplementation(async (tok) =>
    tok === TOKEN ? { sub: "actor-1", sv: 3 } : null,
  );
  dbIndex.listWorkspaces.mockResolvedValue([{ id: "ws-1", role: "owner" }]);

  db.exportDb.mockReset().mockResolvedValue({ schemaVersion: 9, settings: {} });
  db.importDb.mockReset().mockResolvedValue(undefined);
  transfer.exportWorkspace.mockReset().mockResolvedValue({ workspaceId: "ws-1", sealed: "AES" });
  transfer.importWorkspace.mockReset().mockResolvedValue({ ok: true });
});

const database = async () => import("@/app/api/settings/database/route.js");
const wsExport = async () => import("@/app/api/workspaces/[id]/export/route.js");
const wsImport = async () => import("@/app/api/workspaces/[id]/import/route.js");
const params = { params: Promise.resolve({ id: "ws-1" }) };

// --- instance lane -----------------------------------------------------------

describe("instance database routes, switch off (legacy compat)", () => {
  it("GET keeps the x-9r-password header contract", async () => {
    expect((await get({ "x-9r-password": "legacy-pw" })).status).toBe(200);
    expect((await get({ "x-9r-password": "nope" })).status).toBe(401);
    expect(db.exportDb).toHaveBeenCalledTimes(1);
    // Off: exactly one export arg, no actor added.
    expect(db.exportDb.mock.calls[0].length).toBe(1);
  });

  it("POST keeps body { password, data } and strips multiUserEnabled", async () => {
    const { POST } = await database();
    const res = await POST(
      requestOf({ body: { password: "legacy-pw", foo: 1, settings: { multiUserEnabled: true } } }),
    );
    expect(res.status).toBe(200);
    const [payload, opts] = db.importDb.mock.calls[0];
    expect(payload).toEqual({ foo: 1, settings: {} });
    // Off: actor is the legacy single-owner stand-in, core arg shape unchanged.
    expect(opts.actor).toEqual({ owner: true, via: "legacy" });
  });

  it("optional passphrase flows through, never into audit rows", async () => {
    const { POST } = await database();
    const res = await get({
      "x-9r-password": "legacy-pw",
      "x-tokenhop-backup-passphrase": "top-secret",
    });
    expect(res.status).toBe(200);
    expect(db.exportDb).toHaveBeenCalledWith({ passphrase: "top-secret" });
    const wrote = await POST(
      requestOf({ body: { password: "legacy-pw", passphrase: "top-secret" } }),
    );
    expect(wrote.status).toBe(200);
    expect(db.importDb.mock.calls[0][1]).toMatchObject({ passphrase: "top-secret" });
    for (const call of auditLog.mock.calls) {
      expect(JSON.stringify(call)).not.toMatch(/top-secret|legacy-pw/);
    }
  });
});

describe("instance database routes, switch on", () => {
  beforeEach(() => {
    featureSwitch.isMultiUserEnabled.mockResolvedValue(true);
    session.getPrincipal.mockImplementation(async () => ({
      userId: "actor-1",
      instanceRole: "owner",
      via: "session",
      workspaceIds: [],
      workspaceRoles: {},
    }));
  });

  it("GET/POST re-auth the acting user, never the instance shared hash", async () => {
    const { POST } = await database();
    // Acting user knows their own password, not the legacy one.
    expect((await get({ "x-9r-password": "actor-pw" })).status).toBe(200);
    expect((await get({ "x-9r-password": "legacy-pw" })).status).toBe(401);
    // Missing re-auth password is rejected (no silent allow), fail-closed sv.
    expect((await POST(withToken(requestOf({ body: {} })))).status).toBe(401);
    // No session cookie means no verified sv claim: stale, never allowed.
    const noCookie = await POST(requestOf({ body: { password: "actor-pw" } }));
    expect(noCookie.status).toBe(409);
    expect(await noCookie.json()).toMatchObject({ code: "stale_session" });
    expect(db.importDb).not.toHaveBeenCalled();
    expect(db.exportDb).toHaveBeenCalledTimes(1);
  });

  it("active owner and admin pass; user and pending are forbidden", async () => {
    for (const role of ["owner", "admin"]) {
      session.getPrincipal.mockResolvedValue({
        userId: "actor-1",
        instanceRole: role,
        via: "session",
        workspaceIds: [],
        workspaceRoles: {},
      });
      userRepo.getUserUnscoped.mockImplementation(async () => ownerRow({ instanceRole: role }));
      expect((await get({ "x-9r-password": "actor-pw" })).status, role).toBe(200);
    }
    for (const role of ["user", "pending"]) {
      session.getPrincipal.mockResolvedValue({
        userId: "actor-1",
        instanceRole: role,
        via: "session",
        workspaceIds: [],
        workspaceRoles: {},
      });
      expect((await get({ "x-9r-password": "actor-pw" })).status, role).toBe(403);
    }
  });

  it("stale or missing sessionVersion rejects even with the right password", async () => {
    userRepo.getUserUnscoped.mockImplementation(async () => ownerRow({ sessionVersion: 99 }));
    const res = await get({ "x-9r-password": "actor-pw" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "stale_session" });

    // No verified sv claim on the session: fail closed, never open.
    dash.getDashboardAuthSession.mockImplementation(async () => ({ sub: "actor-1" }));
    const noClaim = await get({ "x-9r-password": "actor-pw" });
    expect(noClaim.status).toBe(409);
    expect(await noClaim.json()).toMatchObject({ code: "stale_session" });
  });

  it("SSO-only accounts fail closed (reauth_unsupported), admin force is denied", async () => {
    userRepo.getUserPasswordHashUnscoped.mockResolvedValue(null);
    const res = await get({ "x-9r-password": "anything" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "reauth_unsupported" });

    session.getPrincipal.mockResolvedValue({
      userId: "a",
      instanceRole: "admin",
      via: "session",
      workspaceIds: [],
      workspaceRoles: {},
    });
    userRepo.getUserUnscoped.mockImplementation(async () =>
      ownerRow({ id: "a", instanceRole: "admin" }),
    );
    dash.getDashboardAuthSession.mockImplementation(async (tok) =>
      tok === TOKEN ? { sub: "a", sv: 3 } : null,
    );
    userRepo.getUserPasswordHashUnscoped.mockImplementation(async () => {
      const bcrypt = await import("bcryptjs");
      return bcrypt.hash("actor-pw", 4);
    });
    const { POST } = await database();
    const forced = await POST(
      withToken(requestOf({ body: { password: "actor-pw", force: true } })),
    );
    expect(forced.status).toBe(403);
    expect(db.importDb).not.toHaveBeenCalled();
  });

  it("passes structured diff on IMPORT_USER_MISMATCH without secrets", async () => {
    const diff = { from: { userCount: 1 }, to: { userCount: 2 } };
    db.importDb.mockRejectedValueOnce(
      Object.assign(new Error("Users differ"), { code: "IMPORT_USER_MISMATCH", diff }),
    );
    const { POST } = await database();
    const res = await POST(withToken(requestOf({ body: { password: "actor-pw" } })));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Backup users differ from this instance",
      code: "IMPORT_USER_MISMATCH",
      diff,
    });
    expect(JSON.stringify(auditLog.mock.calls)).not.toMatch(/actor-pw/);
  });

  it("curated safe 400s for portable/passphrase/root codes, unknown codes stay generic", async () => {
    const cases = [
      ["INSTANCE_PORTABLE_INVALID", "Backup is not a valid instance snapshot"],
      ["TRANSFER_PASSPHRASE_REQUIRED", "A passphrase is required for this snapshot"],
      ["TRANSFER_ROOT_MISMATCH", "Snapshot does not match this instance"],
      ["TRANSFER_PORTABLE_UNSUPPORTED", "Snapshot format is not supported"],
    ];
    const { POST } = await database();
    for (const [code, error] of cases) {
      db.importDb.mockRejectedValueOnce(Object.assign(new Error(`LEAKED ${code}`), { code }));
      const res = await POST(withToken(requestOf({ body: { password: "actor-pw" } })));
      expect(res.status, code).toBe(400);
      expect(await res.json(), code).toEqual({ error, code });
    }
    // Unknown coded errors never leak the core message.
    db.importDb.mockRejectedValueOnce(
      Object.assign(new Error("LEAKED"), { code: "CORE_INTERNAL" }),
    );
    const res = await POST(withToken(requestOf({ body: { password: "actor-pw" } })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Failed to import database" });
  });

  it("refuses oversized passphrases and non-boolean force before any re-auth", async () => {
    const { POST } = await database();
    // Shape errors reject first: even a wrong password never wins the race.
    expect(
      (
        await POST(
          withToken(requestOf({ body: { password: "wrong", passphrase: "x".repeat(2048) } })),
        )
      ).status,
    ).toBe(400);
    expect(
      (await POST(withToken(requestOf({ body: { password: "wrong", force: "yes" } })))).status,
    ).toBe(400);
    expect(
      (
        await POST(
          withToken(requestOf({ body: { password: "actor-pw", passphrase: "x".repeat(2048) } })),
        )
      ).status,
    ).toBe(400);
    expect(
      (await POST(withToken(requestOf({ body: { password: "actor-pw", force: "yes" } })))).status,
    ).toBe(400);
    // Non-plain payload reaches the core lane (structured core error passes through).
    expect((await POST(withToken(requestOf({ body: { password: "actor-pw" } })))).status).toBe(200);
  });
});

describe("instance database hardening", () => {
  const OVER = String(64 * 1024 * 1024 + 1);
  // Per-IP passphrase bucket only: the password re-auth call carries an account.
  // Per-IP passphrase bucket only: the password re-auth call carries an account.
  const lockAfterTwoPassphraseFails = () => {
    let fails = 0;
    recordLoginFail.mockImplementation((a) => {
      if (!a.account) fails++;
    });
    checkLoginLocks.mockImplementation(({ account }) =>
      !account && fails >= 2 ? { locked: true, retryAfter: 60 } : { locked: false },
    );
  };
  const asOwner = () => {
    featureSwitch.isMultiUserEnabled.mockResolvedValue(true);
    session.getPrincipal.mockResolvedValue({
      userId: "actor-1",
      instanceRole: "owner",
      via: "session",
      workspaceIds: [],
      workspaceRoles: {},
    });
  };

  it("GET export (success and denial) is no-store", async () => {
    expect((await get({ "x-9r-password": "legacy-pw" })).headers.get("cache-control")).toBe(
      "no-store",
    );
    expect((await get({ "x-9r-password": "nope" })).headers.get("cache-control")).toBe("no-store");
  });

  it("oversized body is 413 before re-auth or core; non-object bodies are 400", async () => {
    asOwner();
    const { POST } = await database();
    const big = await POST(
      withToken(requestOf({ headers: { "content-length": OVER }, body: { password: "actor-pw" } })),
    );
    expect(big.status).toBe(413);
    for (const raw of ["[]", "null", "not json", "7"]) {
      const res = await POST(
        withToken(
          new Request("http://localhost/x", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: raw,
          }),
        ),
      );
      expect(res.status, raw).toBe(400);
    }
    expect(db.importDb).not.toHaveBeenCalled();
  });

  it("repeated invalid passphrases lock the IP without more unwraps", async () => {
    asOwner();
    lockAfterTwoPassphraseFails();
    db.importDb.mockRejectedValue(
      Object.assign(new Error("bad passphrase"), { code: "PASSPHRASE_INVALID" }),
    );
    const { POST } = await database();
    const call = () =>
      POST(withToken(requestOf({ body: { password: "actor-pw", passphrase: "wrong-secret" } })));
    expect((await call()).status).toBe(400);
    expect((await call()).status).toBe(400);
    const locked = await call();
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("60");
    expect(db.importDb).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(recordLoginFail.mock.calls)).not.toMatch(/wrong-secret/);
  });
});

// --- workspace lane ----------------------------------------------------------

describe("workspace transfer routes", () => {
  it("404 while the switch is off, never reaching auth or the core", async () => {
    featureSwitch.requireMultiUser
      .mockResolvedValueOnce(hidden404())
      .mockResolvedValueOnce(hidden404());
    const { POST: Export } = await wsExport();
    const { POST: Import } = await wsImport();
    const body = { password: "actor-pw", passphrase: "ph" };
    expect((await Export(requestOf({ body }), params)).status).toBe(404);
    expect((await Import(requestOf({ body: { ...body, data: {} } }), params)).status).toBe(404);
    expect(transfer.exportWorkspace).not.toHaveBeenCalled();
    expect(transfer.importWorkspace).not.toHaveBeenCalled();
  });

  it("owner succeeds; manager/member/outsider are denied; sessions only", async () => {
    const withRole = (wsRole, via = "session", workspaceIds = ["ws-1"]) =>
      session.getPrincipal.mockResolvedValue({
        ...mkSessionCtx("user", wsRole),
        via,
        workspaceIds,
        activeWorkspaceId: "ws-1",
      });
    const { POST: Export } = await wsExport();
    const ok = { password: "actor-pw", passphrase: "ph" };
    withRole("owner");
    const good = await Export(withToken(requestOf({ body: ok })), params);
    expect(good.status, "owner").toBe(200);
    expect(transfer.exportWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "actor-1" }),
      "ws-1",
      { passphrase: "ph" },
    );
    // Downloadable JSON filename header.
    expect(good.headers.get("content-disposition")).toMatch(
      /^attachment; filename="tokenhop-workspace-ws-1-.*\.json"$/,
    );
    expect(good.headers.get("cache-control")).toBe("no-store");

    withRole("manager");
    expect((await Export(withToken(requestOf({ body: ok })), params)).status, "manager").toBe(403);
    withRole("member");
    expect((await Export(withToken(requestOf({ body: ok })), params)).status, "member").toBe(403);
    withRole(null, "session", []);
    expect(
      (
        await Export(withToken(requestOf({ body: ok })), {
          params: Promise.resolve({ id: "other" }),
        })
      ).status,
      "outsider",
    ).toBe(404);
    withRole("owner", "cli");
    expect((await Export(requestOf({ body: ok }), params)).status, "cli").toBe(401);
  });

  it("wrong password, stale session, malformed bodies; import passes snapshot through verbatim", async () => {
    session.getPrincipal.mockResolvedValue(mkSessionCtx("user", "owner"));
    const { POST: Export } = await wsExport();
    const { POST: Import } = await wsImport();

    expect(
      (
        await Export(
          withToken(requestOf({ body: { password: "wrong", passphrase: "ph" } })),
          params,
        )
      ).status,
    ).toBe(401);

    userRepo.getUserUnscoped.mockImplementation(async () =>
      ownerRow({ instanceRole: "user", sessionVersion: 77 }),
    );
    expect(
      (
        await Export(
          withToken(requestOf({ body: { password: "actor-pw", passphrase: "ph" } })),
          params,
        )
      ).status,
    ).toBe(409);
    userRepo.getUserUnscoped.mockImplementation(async () => ownerRow({ instanceRole: "user" }));

    for (const body of [
      null,
      { password: "actor-pw" },
      { passphrase: "ph" },
      { password: "actor-pw", passphrase: "ph", actor: "spoofed" },
      { password: "actor-pw", passphrase: "ph", workspaceId: "evil" },
      { password: "actor-pw", passphrase: "" },
      { password: "actor-pw", passphrase: "x".repeat(2048) },
    ]) {
      expect(
        (await Export(withToken(requestOf({ body })), params)).status,
        JSON.stringify(body),
      ).toBe(400);
    }
    expect(
      (
        await Import(
          withToken(requestOf({ body: { password: "actor-pw", passphrase: "ph" } })),
          params,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await Import(
          withToken(
            requestOf({ method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }),
          ),
          params,
        )
      ).status,
    ).toBe(415);

    const sealed = { ct: "ENCRYPTED", iv: "v", users: [{ id: 1 }] };
    const ok = await Import(
      withToken(requestOf({ body: { password: "actor-pw", passphrase: "ph", data: sealed } })),
      params,
    );
    expect(ok.status).toBe(200);
    expect(transfer.importWorkspace.mock.calls[0][2]).toStrictEqual(sealed);
    // No silent alteration (deep-equal after JSON), and no ciphertext in audit rows.
    expect(JSON.stringify(auditLog.mock.calls)).not.toMatch(/ENCRYPTED|actor-pw/);

    // Ownership lost during the bcrypt window: 404, never a partial transfer.
    dbIndex.listWorkspaces.mockResolvedValue([{ id: "ws-1", role: "member" }]);
    expect(
      (
        await Export(
          withToken(requestOf({ body: { password: "actor-pw", passphrase: "ph" } })),
          params,
        )
      ).status,
    ).toBe(404);
  });

  it("SSO-only workspace owners fail closed with a clear code", async () => {
    session.getPrincipal.mockResolvedValue(mkSessionCtx("user", "owner"));
    userRepo.getUserPasswordHashUnscoped.mockResolvedValue(null);
    const { POST: Export } = await wsExport();
    const res = await Export(
      withToken(requestOf({ body: { password: "x", passphrase: "ph" } })),
      params,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "reauth_unsupported" });
  });

  it("TRANSFER_CONFLICT returns a fixed 409 with a bounded conflicts list", async () => {
    session.getPrincipal.mockResolvedValue(mkSessionCtx("user", "owner"));
    const { POST: Import } = await wsImport();
    const call = () =>
      Import(
        withToken(requestOf({ body: { password: "actor-pw", passphrase: "ph", data: {} } })),
        params,
      );
    const conflicts = Array.from({ length: 20 }, (_, i) =>
      i === 3 ? "x".repeat(300) : `conflict-${i}`,
    );
    transfer.importWorkspace.mockRejectedValueOnce(
      Object.assign(new Error("clash"), { code: "TRANSFER_CONFLICT", conflicts }),
    );
    const res = await call();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("Snapshot conflicts with existing data");
    expect(body.code).toBe("TRANSFER_CONFLICT");
    expect(body.conflicts).toHaveLength(16);
    expect(body.conflicts.every((c) => typeof c === "string" && c.length <= 200)).toBe(true);
    expect(body.conflicts[3]).toBe("x".repeat(200));

    // Non-array conflicts -> empty list; unknown codes stay generic.
    transfer.importWorkspace.mockRejectedValueOnce(
      Object.assign(new Error("clash"), { code: "TRANSFER_CONFLICT", conflicts: "nope" }),
    );
    expect((await (await call()).json()).conflicts).toEqual([]);
    transfer.importWorkspace.mockRejectedValueOnce(
      Object.assign(new Error("LEAKED"), { code: "CORE_INTERNAL" }),
    );
    const res3 = await call();
    expect(res3.status).toBe(400);
    expect(await res3.json()).toEqual({ error: "Transfer failed" });
  });

  it("workspace import: oversized 413 before core, repeated bad passphrase locks", async () => {
    session.getPrincipal.mockResolvedValue(mkSessionCtx("user", "owner"));
    const { POST: Import } = await wsImport();
    const body = { password: "actor-pw", passphrase: "wrong-secret", data: {} };
    const big = await Import(
      withToken(requestOf({ headers: { "content-length": String(64 * 1024 * 1024 + 1) }, body })),
      params,
    );
    expect(big.status).toBe(413);
    expect(transfer.importWorkspace).not.toHaveBeenCalled();

    let fails = 0;
    recordLoginFail.mockImplementation((a) => {
      if (!a.account) fails++;
    });
    checkLoginLocks.mockImplementation(({ account }) =>
      !account && fails >= 2 ? { locked: true, retryAfter: 30 } : { locked: false },
    );
    transfer.importWorkspace.mockRejectedValue(
      Object.assign(new Error("bad"), { code: "PASSPHRASE_INVALID" }),
    );
    const call = () => Import(withToken(requestOf({ body })), params);
    expect((await call()).status).toBe(400);
    expect((await call()).status).toBe(400);
    expect((await call()).status).toBe(429);
    expect(transfer.importWorkspace).toHaveBeenCalledTimes(2);
  });

  it("structured IMPORT_USER_MISMATCH diff survives the workspace import path", async () => {
    session.getPrincipal.mockResolvedValue(mkSessionCtx("user", "owner"));
    const diff = { from: { users: 1 }, to: { users: 2 } };
    transfer.importWorkspace.mockRejectedValueOnce(
      Object.assign(new Error("Users differ"), { code: "IMPORT_USER_MISMATCH", diff }),
    );
    const { POST: Import } = await wsImport();
    const res = await Import(
      withToken(requestOf({ body: { password: "actor-pw", passphrase: "ph", data: {} } })),
      params,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Backup users differ from this instance",
      code: "IMPORT_USER_MISMATCH",
      diff,
    });
  });
});

// --- helper units ------------------------------------------------------------

describe("helper units", () => {
  it("boundPassphrase: absent/empty -> undefined, non-string/oversized -> null", () => {
    expect(helper.boundPassphrase(undefined)).toBe(undefined);
    expect(helper.boundPassphrase("")).toBe(undefined);
    expect(helper.boundPassphrase("ph")).toBe("ph");
    expect(helper.boundPassphrase(42)).toBe(null);
    expect(helper.boundPassphrase("x".repeat(2048))).toBe(null);
  });

  it("forceAllowed: only explicit true from the instance owner", () => {
    expect(helper.forceAllowed({ instanceRole: "owner" }, true)).toBe(true);
    expect(helper.forceAllowed({ instanceRole: "admin" }, true)).toBe(false);
    expect(helper.forceAllowed({ instanceRole: "owner" }, "yes")).toBe(false);
    expect(helper.forceAllowed({ instanceRole: "owner" }, undefined)).toBe(false);
  });
});
