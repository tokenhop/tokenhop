// YAN-354: sample cross-workspace negative tests on the two-user harness.
// Later scoping issues copy this shape for their resources.
import { beforeEach, describe, expect, it } from "vitest";
import { callRoute, denied, seedTenancy } from "../setup/tenancyHarness.js";

let db;
let t;

beforeEach(async () => {
  db = await import("@/lib/db/index.js");
  t = await seedTenancy();
});

describe("workspaces: B cannot read, list, update or delete A's", () => {
  it("personal workspace", async () => {
    const { a, b } = t;
    expect(await denied(db.getWorkspace(b.ctx, a.personal))).toBe(true);
    expect((await db.listWorkspaces(b.ctx)).map((w) => w.id)).not.toContain(a.personal);
    expect(await denied(db.renameWorkspace(b.ctx, a.personal, "x"))).toBe(true);
    expect(await denied(db.deleteWorkspace(b.ctx, a.personal))).toBe(true);
    expect(await denied(db.listMemberships(b.ctx, a.personal))).toBe(true);
  });

  it("but both see the shared one", async () => {
    const { a, b, shared } = t;
    expect(await db.getWorkspace(b.ctx, shared.id)).toMatchObject({ role: "member" });
    expect(await db.getWorkspace(a.ctx, shared.id)).toMatchObject({ role: "owner" });
  });
});

describe("harness", () => {
  it("denied() rethrows unexpected errors", async () => {
    await expect(denied(Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await denied(Promise.resolve({ id: "x" }))).toBe(false);
  });

  it("callRoute() sends the user's session or the gateway key", async () => {
    const { getDashboardAuthSession } = await import("@/lib/auth/dashboardSession.js");
    const echo = async (req) => ({
      session: await getDashboardAuthSession(req.cookies.get("auth_token")?.value),
      auth: req.headers.get("authorization"),
      body: req.method === "POST" ? await req.json() : null,
    });
    const asB = await callRoute(echo, "/api/x", { as: t.b, method: "POST", body: { n: 1 } });
    expect(asB.session).toMatchObject({
      authenticated: true,
      sub: t.b.user.id,
      sv: 1,
      wid: t.b.personal,
    });
    expect(asB.body).toEqual({ n: 1 });
    expect(await callRoute(echo, "/api/x", { apiKey: "sk-test" })).toMatchObject({
      session: null,
      auth: "Bearer sk-test",
    });
  });
});
