// YAN-1066 route-level regression: the PATCH /api/users/[id] origin gate must
// use the configured BASE_URL (read at request time), not nextUrl (which
// reflects the bind host behind a proxy). Real NextRequest on the internal
// URL, real sameOrigin module; switch/session/capability/repo mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/users/featureSwitch", () => ({ requireMultiUser: vi.fn() }));
vi.mock("@/lib/users/session", () => ({ authorize: vi.fn(), getPrincipal: vi.fn() }));
vi.mock("@/lib/users/audit.js", () => ({ audit: vi.fn() }));
vi.mock("@/lib/db/repos/usersRepo.js", () => ({
  getUserUnscoped: vi.fn(),
  getUserDetailUnscoped: vi.fn(),
  updateUserUnscoped: vi.fn(),
  deleteUserUnscoped: vi.fn(),
}));

const { requireMultiUser } = await import("@/lib/users/featureSwitch");
const repo = await import("@/lib/db/repos/usersRepo.js");
const { PATCH } = await import("@/app/api/users/[id]/route.js");

const OWNER = { via: "session", userId: "owner-1" };
const PARAMS = { params: Promise.resolve({ id: "user-1" }) };

// Browser hits the public URL; proxy forwards to the app's internal bind URL,
// so the request object only ever sees 0.0.0.0:20127.
const patchReq = (headers = {}) =>
  new NextRequest("http://0.0.0.0:20127/api/users/user-1", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ status: "disabled" }),
    duplex: "half",
  });

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("BASE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_BASE_URL", "");
  requireMultiUser.mockResolvedValue(null);
  const { getPrincipal, authorize } = await import("@/lib/users/session");
  getPrincipal.mockResolvedValue(OWNER);
  authorize.mockResolvedValue(null);
  repo.updateUserUnscoped.mockResolvedValue({
    id: "user-1",
    instanceRole: "user",
    status: "disabled",
  });
});

afterEach(() => vi.unstubAllEnvs());

describe("PATCH /api/users/[id] origin gate behind a proxy (internal URL)", () => {
  it("BASE_URL set: matching public Origin passes; mismatching Origins get 403 forbidden_origin, repo untouched", async () => {
    vi.stubEnv("BASE_URL", "https://pub.example:20128");
    const ok = await PATCH(patchReq({ origin: "https://pub.example:20128" }), PARAMS);
    expect(ok.status).toBe(200);
    expect(repo.updateUserUnscoped).toHaveBeenCalledTimes(1);

    for (const origin of [
      "https://pub.example", // wrong port
      "http://pub.example:20128", // wrong scheme
      "https://evil.example:20128",
      "http://localhost:20127", // no loopback exception
    ]) {
      repo.updateUserUnscoped.mockClear();
      const res = await PATCH(patchReq({ origin }), PARAMS);
      expect(res.status, origin).toBe(403);
      expect(await res.json()).toMatchObject({ code: "forbidden_origin" });
      expect(repo.updateUserUnscoped).not.toHaveBeenCalled();
    }
  });

  it("BASE_URL unset: Host header decides; forwarded headers never rescue a mismatch", async () => {
    const ok = await PATCH(
      patchReq({ origin: "https://pub.example:20128", host: "pub.example:20128" }),
      PARAMS,
    );
    expect(ok.status).toBe(200);

    const res = await PATCH(
      patchReq({
        origin: "https://evil.example",
        host: "pub.example:20128",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      }),
      PARAMS,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "forbidden_origin" });
    expect(repo.updateUserUnscoped).toHaveBeenCalledTimes(1);
  });

  it("non-browser (no Origin) request still reaches the session check", async () => {
    const res = await PATCH(patchReq(), PARAMS);
    expect(res.status).toBe(200);
  });
});
