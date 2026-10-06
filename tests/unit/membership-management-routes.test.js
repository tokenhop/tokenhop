// Route contract for PATCH/DELETE /api/workspaces/[id]/members/[userId]:
// hidden (404) while switch off, body allow-list rejects injected `source`,
// repo IDP_MANAGED maps to fixed 409. Pure-mock style, no DB.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/users/featureSwitch.js", () => ({ requireMultiUser: vi.fn() }));
vi.mock("@/lib/users/session", () => ({ authorize: vi.fn(), getPrincipal: vi.fn() }));
vi.mock("@/lib/auth/sameOrigin.js", () => ({
  isCrossSite: vi.fn(() => false),
  isJson: vi.fn(() => true),
}));
vi.mock("@/lib/db/repos/membershipsRepo.js", () => ({
  updateMembershipRole: vi.fn(),
  removeMembership: vi.fn(),
}));

const { requireMultiUser } = await import("@/lib/users/featureSwitch.js");
const { authorize, getPrincipal } = await import("@/lib/users/session");
const repo = await import("@/lib/db/repos/membershipsRepo.js");
const { DELETE, PATCH } = await import("@/app/api/workspaces/[id]/members/[userId]/route.js");

const PARAMS = { params: Promise.resolve({ id: "ws-1", userId: "u-2" }) };
const patchReq = (body) =>
  new Request("http://localhost/api/workspaces/ws-1/members/u-2", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const delReq = () =>
  new Request("http://localhost/api/workspaces/ws-1/members/u-2", { method: "DELETE" });
const idpError = () => Object.assign(new Error("secret repo text"), { code: "IDP_MANAGED" });

beforeEach(() => {
  vi.clearAllMocks();
  requireMultiUser.mockResolvedValue(null);
  getPrincipal.mockResolvedValue({ via: "session", userId: "owner-1" });
  authorize.mockResolvedValue(null);
});

describe("membership [userId] route", () => {
  it("switch off -> 404, no auth, no repo", async () => {
    requireMultiUser.mockResolvedValue(NextResponse.json({ error: "Not found" }, { status: 404 }));
    expect((await PATCH(patchReq({ role: "member" }), PARAMS)).status).toBe(404);
    expect((await DELETE(delReq(), PARAMS)).status).toBe(404);
    expect(getPrincipal).not.toHaveBeenCalled();
    expect(repo.updateMembershipRole).not.toHaveBeenCalled();
    expect(repo.removeMembership).not.toHaveBeenCalled();
  });

  it("PATCH rejects injected source/unknown keys/bad role -> 400, repo untouched", async () => {
    for (const body of [{ role: "member", source: "idp" }, { role: "owner" }, {}, []]) {
      const res = await PATCH(patchReq(body), PARAMS);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(repo.updateMembershipRole).not.toHaveBeenCalled();
  });

  it("PATCH happy path passes principal/id/userId/role", async () => {
    repo.updateMembershipRole.mockResolvedValue({ userId: "u-2", role: "viewer" });
    const res = await PATCH(patchReq({ role: "viewer" }), PARAMS);
    expect(res.status).toBe(200);
    expect(repo.updateMembershipRole).toHaveBeenCalledWith(
      { via: "session", userId: "owner-1" },
      "ws-1",
      "u-2",
      "viewer",
    );
  });

  it("repo IDP_MANAGED -> fixed 409 on PATCH and DELETE", async () => {
    repo.updateMembershipRole.mockRejectedValue(idpError());
    repo.removeMembership.mockRejectedValue(idpError());
    for (const res of [
      await PATCH(patchReq({ role: "member" }), PARAMS),
      await DELETE(delReq(), PARAMS),
    ]) {
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toEqual({ error: "Membership is managed by SSO sync", code: "idp_managed" });
    }
  });
});
