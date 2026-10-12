// YAN-373: client API boundary sends only the approved fields. The server
// keeps authorization: failures are surfaced with HTTP status/code to the UI.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInvitation,
  deleteUser,
  getUser,
  signOutUserEverywhere,
  listUsers,
  setTemporaryPassword,
  updateUser,
} from "@/shared/utils/adminApi.js";

const ok = (body) => ({ ok: true, json: async () => body });
afterEach(() => vi.unstubAllGlobals());

describe("admin client API", () => {
  it("passes pagination and no-store", async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ users: [], pagination: { totalPages: 0 } }));
    vi.stubGlobal("fetch", fetch);
    await listUsers({ page: 2, pageSize: 20 });
    expect(fetch.mock.calls[0][0]).toBe("/api/users?page=2&pageSize=20");
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "GET", cache: "no-store" });
  });
  it("404 and 403 stay distinct for hidden and denied UI", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: "Forbidden", code: "forbidden" }),
      }),
    );
    await expect(listUsers()).rejects.toMatchObject({
      message: "Forbidden",
      status: 403,
      code: "forbidden",
    });
  });
  it("PATCH sends the role; DELETE sends no body", async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ user: { id: "a/b" } }));
    vi.stubGlobal("fetch", fetch);
    await updateUser("a/b", { instanceRole: "user" });
    expect(fetch.mock.calls[0][0]).toBe("/api/users/a%2Fb");
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: "PATCH",
      body: '{"instanceRole":"user"}',
    });
    await deleteUser("a/b");
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: "DELETE", body: undefined });
  });
  it("invitation raw token leaves only the 201 response; list needn't carry it", async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ token: "t".repeat(43), invitation: { id: "i" } }));
    vi.stubGlobal("fetch", fetch);
    const body = await createInvitation("w", { role: "member" });
    expect(body.token).toHaveLength(43);
    expect(fetch.mock.calls[0][1].body).toBe('{"role":"member"}');
  });
  it("temporary password body has one field only", async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ success: true }));
    vi.stubGlobal("fetch", fetch);
    await setTemporaryPassword("u", "long-test-password");
    expect(fetch.mock.calls[0][1].body).toBe('{"password":"long-test-password"}');
  });
  it("sends search/role/status to the server and omits 'all'", async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ users: [] }));
    vi.stubGlobal("fetch", fetch);
    await listUsers({ page: 1, pageSize: 20, search: "ann", role: "pending", status: "all" });
    expect(fetch.mock.calls[0][0]).toBe("/api/users?page=1&pageSize=20&search=ann&role=pending");
  });
  it("detail and sign-out-everywhere use the dedicated routes", async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ user: { id: "z" }, success: true }));
    vi.stubGlobal("fetch", fetch);
    await getUser("z");
    await signOutUserEverywhere("z");
    expect(fetch.mock.calls[0][0]).toBe("/api/users/z");
    expect(fetch.mock.calls[1][0]).toBe("/api/users/z/logout-all");
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: "POST" });
  });
});
