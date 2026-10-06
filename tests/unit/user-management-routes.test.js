// Route-level contract for GET /api/users and PATCH/DELETE /api/users/[id]:
// hidden (404) while the multi-user switch is off, full-session-only principals,
// capability denial, PATCH body allow-list, and safe list DTO. Pure-mock style —
// no DB seeding; repos/session/switch mocked at module level.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/users/featureSwitch", () => ({ requireMultiUser: vi.fn() }));
vi.mock("@/lib/users/session", () => ({ authorize: vi.fn(), getPrincipal: vi.fn() }));
vi.mock("@/lib/auth/sameOrigin.js", () => ({
  isCrossSite: vi.fn(() => false),
  isJson: vi.fn(() => true),
}));
vi.mock("@/lib/users/audit.js", () => ({ audit: vi.fn() }));
vi.mock("@/lib/db/repos/usersRepo.js", () => ({
  listUsersPageUnscoped: vi.fn(),
  getUserUnscoped: vi.fn(),
  updateUserUnscoped: vi.fn(),
  deleteUserUnscoped: vi.fn(),
}));

const { requireMultiUser } = await import("@/lib/users/featureSwitch");
const { authorize, getPrincipal } = await import("@/lib/users/session");
const repo = await import("@/lib/db/repos/usersRepo.js");
const { GET } = await import("@/app/api/users/route.js");
const { DELETE, PATCH } = await import("@/app/api/users/[id]/route.js");

const hidden404 = () => NextResponse.json({ error: "Not found" }, { status: 404 });
const denied403 = () => NextResponse.json({ error: "Forbidden" }, { status: 403 });
const OWNER = { via: "session", userId: "owner-1" };
const PARAMS = { params: Promise.resolve({ id: "user-1" }) };

// PATCH reads a byte-limited body stream, so tests use real Request objects
// with stream bodies (no fake text()). Missing content-length works; only
// real streamed bytes past the cap are rejected.
const getReq = () => ({ url: "http://localhost/api/users?page=1", headers: new Headers() });
const patchReq = (body, headers = {}) =>
  new Request("http://localhost/api/users/user-1", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body,
    duplex: "half",
  });
// Chunked body with no declared length: forces streaming path.
const streamReq = (chunks) =>
  patchReq(
    new ReadableStream({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        c.close();
      },
    }),
  );
const delReq = () => ({ url: "http://localhost/api/users/user-1", headers: new Headers() });

const SAFE_USERS = [
  {
    id: "u1",
    email: "a@x.io",
    instanceRole: "user",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "u2",
    email: "b@x.io",
    instanceRole: "admin",
    status: "disabled",
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  requireMultiUser.mockResolvedValue(null);
  getPrincipal.mockResolvedValue(OWNER);
  authorize.mockResolvedValue(null);
  repo.listUsersPageUnscoped.mockResolvedValue({
    users: SAFE_USERS,
    pagination: { page: 1, pageSize: 50, totalItems: 2, totalPages: 1 },
  });
  repo.getUserUnscoped.mockResolvedValue({ id: "user-1", instanceRole: "user", status: "active" });
  repo.updateUserUnscoped.mockResolvedValue({
    id: "user-1",
    instanceRole: "admin",
    status: "active",
  });
  repo.deleteUserUnscoped.mockResolvedValue(true);
});

describe("multi-user switch off hides every route (404, no auth, no repo)", () => {
  beforeEach(() => {
    requireMultiUser.mockResolvedValue(hidden404());
  });

  it("GET /api/users -> 404", async () => {
    const res = await GET(getReq());
    expect(res.status).toBe(404);
    expect(getPrincipal).not.toHaveBeenCalled();
    expect(repo.listUsersPageUnscoped).not.toHaveBeenCalled();
  });

  it("PATCH /api/users/[id] -> 404", async () => {
    const res = await PATCH(patchReq(JSON.stringify({ status: "disabled" })), PARAMS);
    expect(res.status).toBe(404);
    expect(getPrincipal).not.toHaveBeenCalled();
    expect(repo.updateUserUnscoped).not.toHaveBeenCalled();
  });

  it("DELETE /api/users/[id] -> 404", async () => {
    const res = await DELETE(delReq(), PARAMS);
    expect(res.status).toBe(404);
    expect(getPrincipal).not.toHaveBeenCalled();
    expect(repo.deleteUserUnscoped).not.toHaveBeenCalled();
  });
});

describe("non-session principals -> 401 on all routes", () => {
  const principals = [null, { via: "api-key", userId: "k1" }, { via: "peer", userId: "p1" }];

  for (const principal of principals) {
    it(`principal ${JSON.stringify(principal)} -> 401 GET/PATCH/DELETE`, async () => {
      getPrincipal.mockResolvedValue(principal);
      expect((await GET(getReq())).status).toBe(401);
      expect((await PATCH(patchReq(JSON.stringify({ status: "disabled" })), PARAMS)).status).toBe(
        401,
      );
      expect((await DELETE(delReq(), PARAMS)).status).toBe(401);
      expect(authorize).not.toHaveBeenCalled();
      expect(repo.listUsersPageUnscoped).not.toHaveBeenCalled();
      expect(repo.updateUserUnscoped).not.toHaveBeenCalled();
      expect(repo.deleteUserUnscoped).not.toHaveBeenCalled();
    });
  }
});

describe("full session without instance.users.manage -> 403, repo untouched", () => {
  beforeEach(() => {
    authorize.mockResolvedValue(denied403());
  });

  it("GET/PATCH/DELETE all deny", async () => {
    expect((await GET(getReq())).status).toBe(403);
    expect((await PATCH(patchReq(JSON.stringify({ status: "disabled" })), PARAMS)).status).toBe(
      403,
    );
    expect((await DELETE(delReq(), PARAMS)).status).toBe(403);
    expect(repo.listUsersPageUnscoped).not.toHaveBeenCalled();
    expect(repo.updateUserUnscoped).not.toHaveBeenCalled();
    expect(repo.deleteUserUnscoped).not.toHaveBeenCalled();
  });
});

describe("PATCH body allow-list", () => {
  it("unknown keys -> 400 invalid_request, repo untouched", async () => {
    for (const body of [
      { instanceRole: "admin", passwordHash: "x" },
      { status: "disabled", sessionVersion: 9 },
      { evil: true },
      { status: 5 },
      {},
    ]) {
      const res = await PATCH(patchReq(JSON.stringify(body)), PARAMS);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_request" });
    }
    expect(repo.updateUserUnscoped).not.toHaveBeenCalled();
  });

  it("malformed JSON -> 400 invalid_request, repo untouched", async () => {
    const res = await PATCH(patchReq("{not json"), PARAMS);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_request" });
    expect(repo.updateUserUnscoped).not.toHaveBeenCalled();
  });

  it("missing content-length (chunked stream), small body -> 200", async () => {
    const res = await PATCH(streamReq([JSON.stringify({ status: "disabled" })]), PARAMS);
    expect(res.status).toBe(200);
    expect(repo.updateUserUnscoped).toHaveBeenCalledWith(
      "user-1",
      { status: "disabled" },
      { actorUserId: "owner-1" },
    );
  });

  it("streamed body over cap -> 413 payload_too_large, repo untouched", async () => {
    const res = await PATCH(streamReq(['{"a":"', "x".repeat(2000), '"}']), PARAMS);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "payload_too_large" });
    expect(repo.updateUserUnscoped).not.toHaveBeenCalled();
  });

  it("dishonest small content-length, oversized stream -> 413", async () => {
    // Lie via header: route must count real bytes, not the declared length.
    const req = patchReq(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`{"a":"${"x".repeat(2000)}"}`));
          c.close();
        },
      }),
      { "content-length": "10" },
    );
    expect((await PATCH(req, PARAMS)).status).toBe(413);
    expect(repo.updateUserUnscoped).not.toHaveBeenCalled();
  });

  it("declared oversized content-length -> 413 early, repo untouched", async () => {
    const res = await PATCH(
      patchReq(JSON.stringify({ status: "disabled" }), { "content-length": "5000" }),
      PARAMS,
    );
    expect(res.status).toBe(413);
    expect(repo.updateUserUnscoped).not.toHaveBeenCalled();
  });
});

describe("GET safe DTO", () => {
  it("list response projects no secrets, sessionVersion or role source", async () => {
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    const body = await res.json();
    expect(body.users).toHaveLength(2);
    for (const u of body.users) {
      expect(u).not.toHaveProperty("passwordHash");
      expect(u).not.toHaveProperty("sessionVersion");
      expect(u).not.toHaveProperty("instanceRoleSource");
    }
    expect(body.users[0]).toMatchObject({ id: "u1", instanceRole: "user", status: "active" });
    expect(body.pagination).toMatchObject({ totalItems: 2 });
  });
});
