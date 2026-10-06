// Route contract for workspace invitation management (YAN-360): hidden while
// the switch is off, strict POST body, raw token shown once with no-store and
// no-referrer, revoke scoped to the URL workspace. Repo atomicity and live
// authority are covered in invitations-repo.test.js.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/users/featureSwitch", () => ({ requireMultiUser: vi.fn() }));
vi.mock("@/lib/users/session", () => ({ authorize: vi.fn(), getPrincipal: vi.fn() }));
vi.mock("@/lib/auth/sameOrigin.js", () => ({
  isCrossSite: vi.fn(() => false),
  isJson: vi.fn(() => true),
}));
vi.mock("@/lib/users/audit.js", () => ({ audit: vi.fn() }));
vi.mock("@/lib/db/repos/invitationsRepo.js", () => ({
  createInvitation: vi.fn(),
  listInvitations: vi.fn(),
  revokeInvitation: vi.fn(),
}));

const { requireMultiUser } = await import("@/lib/users/featureSwitch");
const { getPrincipal } = await import("@/lib/users/session");
const repo = await import("@/lib/db/repos/invitationsRepo.js");
const { GET, POST } = await import("@/app/api/workspaces/[id]/invitations/route.js");
const { DELETE } = await import("@/app/api/workspaces/[id]/invitations/[inviteId]/route.js");

const MANAGER = {
  via: "session",
  userId: "m1",
  instanceRole: "user",
  workspaceRoles: { w1: "manager" },
};
const PARAMS = { params: Promise.resolve({ id: "w1" }) };
const DEL_PARAMS = { params: Promise.resolve({ id: "w1", inviteId: "inv-1" }) };
const META = { id: "inv-1", workspaceId: "w1", role: "member", email: null, state: "live" };
const TOKEN = "t".repeat(43);

const req = (method, body) =>
  new Request("http://localhost/api/workspaces/w1/invitations", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  requireMultiUser.mockResolvedValue(null);
  getPrincipal.mockResolvedValue(MANAGER);
  repo.listInvitations.mockResolvedValue([META]);
  repo.createInvitation.mockResolvedValue({ invitation: META, token: TOKEN });
  repo.revokeInvitation.mockResolvedValue({ ...META, state: "revoked" });
});

describe("invitation management routes", () => {
  it("switch off hides every method (404, no auth, no repo)", async () => {
    requireMultiUser.mockResolvedValue(NextResponse.json({ error: "Not found" }, { status: 404 }));
    for (const res of [
      await GET(req("GET"), PARAMS),
      await POST(req("POST", { role: "member" }), PARAMS),
      await DELETE(req("DELETE"), DEL_PARAMS),
    ]) {
      expect(res.status).toBe(404);
    }
    expect(getPrincipal).not.toHaveBeenCalled();
    expect(repo.createInvitation).not.toHaveBeenCalled();
    expect(repo.revokeInvitation).not.toHaveBeenCalled();
  });

  it("plain member (no manage capability, not admin) gets 403 before the repo", async () => {
    getPrincipal.mockResolvedValue({ ...MANAGER, workspaceRoles: { w1: "member" } });
    expect((await POST(req("POST", { role: "member" }), PARAMS)).status).toBe(403);
    expect(repo.createInvitation).not.toHaveBeenCalled();
  });

  it("POST rejects injected fields and bad roles", async () => {
    for (const body of [
      { role: "member", source: "invite" },
      { role: "member", workspaceId: "w2" },
      { role: "owner" },
      [],
    ]) {
      const res = await POST(req("POST", body), PARAMS);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(repo.createInvitation).not.toHaveBeenCalled();
  });

  it("POST returns the raw token once, no-store and no-referrer; URL workspace wins", async () => {
    const res = await POST(req("POST", { role: "member" }), PARAMS);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const body = await res.json();
    expect(body.token).toBe(TOKEN);
    expect(JSON.stringify(body)).not.toMatch(/tokenHash/);
    expect(repo.createInvitation).toHaveBeenCalledWith(
      { userId: "m1" },
      { workspaceId: "w1", role: "member", email: null },
    );
    const list = await (await GET(req("GET"), PARAMS)).json();
    expect(JSON.stringify(list)).not.toMatch(/token/i);
  });

  it("DELETE scopes the revoke to the URL workspace; foreign invite is 404", async () => {
    expect((await DELETE(req("DELETE"), DEL_PARAMS)).status).toBe(200);
    expect(repo.revokeInvitation).toHaveBeenCalledWith({ userId: "m1" }, "inv-1", {
      expectedWorkspaceId: "w1",
    });
    repo.revokeInvitation.mockRejectedValue(Object.assign(new Error("x"), { code: "NOT_FOUND" }));
    expect((await DELETE(req("DELETE"), DEL_PARAMS)).status).toBe(404);
  });
});
