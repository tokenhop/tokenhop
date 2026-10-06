// POST /api/workspaces/[id]/members: adding an existing member is an ordinary
// conflict (409), never a 500. Pure-mock route contract, no DB.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/users/featureSwitch.js", () => ({ requireMultiUser: vi.fn(async () => null) }));
vi.mock("@/lib/users/session", () => ({
  authorize: vi.fn(async () => null),
  getPrincipal: vi.fn(async () => ({ via: "session", userId: "owner-1" })),
}));
vi.mock("@/lib/auth/sameOrigin.js", () => ({
  isCrossSite: vi.fn(() => false),
  isJson: vi.fn(() => true),
}));
vi.mock("@/lib/db/repos/membershipsRepo.js", () => ({
  addMembership: vi.fn(),
  listManagedMemberships: vi.fn(),
}));

const repo = await import("@/lib/db/repos/membershipsRepo.js");
const { POST } = await import("@/app/api/workspaces/[id]/members/route.js");

const PARAMS = { params: Promise.resolve({ id: "ws-1" }) };
const req = () =>
  new Request("http://localhost/api/workspaces/ws-1/members", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "u-2", role: "member" }),
  });

beforeEach(() => vi.clearAllMocks());

describe("membership add route", () => {
  it("MEMBERSHIP_EXISTS -> 409 membership_exists without repo text", async () => {
    repo.addMembership.mockRejectedValue(
      Object.assign(new Error("secret repo text"), { code: "MEMBERSHIP_EXISTS" }),
    );
    const res = await POST(req(), PARAMS);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("membership_exists");
    expect(JSON.stringify(body)).not.toContain("secret");
  });
});
