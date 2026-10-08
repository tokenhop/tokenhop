// YAN-362: settings split at repo level. Default-row seeding from the legacy
// blob, per-workspace isolation of effective preferences, switch-off identity.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute, seedTenancy } from "../setup/tenancyHarness.js";

const jar = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name) => {
      const match = jar.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
      return match ? { name, value: match[1] } : undefined;
    },
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(jar.cookie ? { cookie: jar.cookie } : {}),
}));

async function as(user, handler, url, opts = {}) {
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  const token = await createDashboardAuthToken({
    sub: user.user.id,
    sv: user.user.sessionVersion,
    wid: user.personal,
  });
  jar.cookie = `auth_token=${token}`;
  try {
    return await callRoute(handler, url, { as: user, ...opts });
  } finally {
    jar.cookie = "";
  }
}

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];

let db;
let repo;
let adapter;

async function load(state) {
  vi.resetModules();
  process.env[ENV] = state;
  db = await import("@/lib/db/index.js");
  repo = await import("@/lib/db/repos/workspaceSettingsRepo.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
}

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("switch on", () => {
  let t;
  beforeEach(async () => {
    await load("on");
    t = await seedTenancy();
    adapter.run(`DELETE FROM workspaceSettings`);
    adapter.run(`DELETE FROM userPreferences`);
    adapter.run(`DELETE FROM _meta WHERE key = 'defaultWorkspaceId'`);
  });

  it("seeds Default from the legacy blob's workspace keys only, and never overwrites", async () => {
    await db.updateSettings({ comboStrategy: "round-robin", requireApiKey: true });
    adapter.run(`INSERT INTO _meta(key, value) VALUES('defaultWorkspaceId', ?)`, [t.shared.id]);
    adapter.run(`DELETE FROM workspaceSettings`); // updateSettings may have mirrored already

    expect(repo.seedDefaultWorkspaceSettingsUnscoped(adapter)).toBe(true);
    const row = await repo.getWorkspaceSettings(t.a.ctx, t.shared.id);
    expect(row.data.comboStrategy).toBe("round-robin");
    expect(row.data).not.toHaveProperty("requireApiKey"); // instance key stays in the blob

    // YAN-364: the blob→Default mirror converts names to Default combo ids, so
    // the combo must exist before the blob write (unknown names are dropped).
    const demo = await db.createComboUnscoped({ name: "demo", models: [] });
    await db.updateComboStrategies(() => ({ demo: { fallbackStrategy: "weighted" } }));
    expect((await repo.getWorkspaceSettings(t.a.ctx, t.shared.id)).data.comboStrategies).toEqual({
      [demo.id]: { fallbackStrategy: "weighted" },
    });

    // An override made after the seed survives a re-seed (INSERT OR IGNORE).
    await repo.updateWorkspaceSettings(t.a.ctx, t.shared.id, { comboStrategy: "fusion" });
    repo.seedDefaultWorkspaceSettingsUnscoped(adapter);
    expect((await repo.getWorkspaceSettings(t.a.ctx, t.shared.id)).data.comboStrategy).toBe(
      "fusion",
    );
  });

  it("workspace B's override does not reach A; A cannot read B's row", async () => {
    await repo.updateWorkspaceSettings(t.a.ctx, t.a.personal, { comboStrategy: "round-robin" });
    await repo.updateWorkspaceSettings(t.b.ctx, t.b.personal, { comboStrategy: "fusion" });

    await db.updateSettings({ fallbackStrategy: "weighted" });
    await repo.updateWorkspaceSettings(t.a.ctx, t.a.personal, { fallbackStrategy: "fill-first" });
    const views = await db.listEffectivePreferencesUnscoped();
    expect(views.some((view) => view.fallbackStrategy === "weighted")).toBe(true);
    expect(views.some((view) => view.fallbackStrategy === "fill-first")).toBe(true);

    const effA = await db.getEffectivePreferences(t.a.ctx);
    const effB = await db.getEffectivePreferences(t.b.ctx);
    expect(effA.comboStrategy).toBe("round-robin");
    expect(effB.comboStrategy).toBe("fusion");
    expect(effA.comboStrategy).not.toBe(effB.comboStrategy);

    await expect(repo.getWorkspaceSettings(t.a.ctx, t.b.personal)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("API boundaries", () => {
  it("rejects cross-workspace access, instance writes by members, and misplaced keys", async () => {
    await load("on");
    await db.updateSettings({ requireLogin: true });
    const t = await seedTenancy();
    const instance = await import("@/app/api/settings/route.js");
    const workspace = await import("@/app/api/workspaces/[id]/settings/route.js");
    const patch = (user, body) =>
      as(user, instance.PATCH, "/api/settings", { method: "PATCH", body });
    expect((await patch(t.b, { requireApiKey: true })).status).toBe(403);
    expect((await patch(t.a, { comboStrategy: "round-robin" })).status).toBe(400);
    expect((await patch(t.a, { unknownSetting: true })).status).toBe(400);
    expect(
      (
        await as(t.a, workspace.PATCH, `/api/workspaces/${t.b.personal}/settings`, {
          method: "PATCH",
          params: { id: t.b.personal },
          body: { comboStrategy: "round-robin" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await as(t.a, workspace.PATCH, `/api/workspaces/${t.a.personal}/settings`, {
          method: "PATCH",
          params: { id: t.a.personal },
          body: { requireApiKey: true },
        })
      ).status,
    ).toBe(400);
  });

  it("accepts an ordinary workspace PATCH without comboStrategies", async () => {
    await load("on");
    await db.updateSettings({ requireLogin: true });
    const t = await seedTenancy();
    const workspace = await import("@/app/api/workspaces/[id]/settings/route.js");
    const res = await as(t.a, workspace.PATCH, `/api/workspaces/${t.a.personal}/settings`, {
      method: "PATCH",
      params: { id: t.a.personal },
      body: { fallbackStrategy: "round-robin" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.fallbackStrategy).toBe("round-robin");
  });

  it("GET exposes the instance layer of map keys only (YAN-770)", async () => {
    await load("on");
    await db.updateSettings({ requireLogin: true, providerThinking: { claude: { mode: "high" } } });
    const t = await seedTenancy();
    const workspace = await import("@/app/api/workspaces/[id]/settings/route.js");
    const res = await as(t.b, workspace.GET, `/api/workspaces/${t.b.personal}/settings`, {
      params: { id: t.b.personal },
    });
    expect(res.status).toBe(200);
    const { inherited } = await res.json();
    expect(inherited.providerThinking).toEqual({ claude: { mode: "high" } });
    expect(inherited).not.toHaveProperty("requireLogin");
  });

  it("hides new routes with switch off", async () => {
    await load("off");
    const workspace = await import("@/app/api/workspaces/[id]/settings/route.js");
    expect(
      (
        await callRoute(workspace.GET, "/api/workspaces/missing/settings", {
          params: { id: "missing" },
        })
      ).status,
    ).toBe(404);
  });
});

describe("legacy password fallback", () => {
  it("login still checks the owner's real password after the blob key is removed", async () => {
    await load("off");
    const bcrypt = (await import("bcryptjs")).default;
    const hash = await bcrypt.hash("real-secret", 4);
    adapter.run(`DELETE FROM users`);
    await db.createUserUnscoped({ email: "o@test", instanceRole: "owner", passwordHash: hash });
    await db.updateSettings({ requireLogin: true });
    repo.removeLegacyPasswordUnscoped(adapter);
    expect((await db.getSettings()).password).toBeUndefined();
    const { POST } = await import("@/app/api/auth/login/route.js");
    const login = (password) =>
      callRoute(POST, "/api/auth/login", { method: "POST", body: { password } });
    expect((await login("123456")).status).not.toBe(200);
    expect((await login("real-secret")).status).toBe(200);
    const { GET } = await import("@/app/api/auth/status/route.js");
    expect(await (await GET()).json()).toMatchObject({ hasPassword: true });
  });
});

describe("switch off", () => {
  it("getEffectivePreferences(ctx) and (null) equal getSettings()", async () => {
    await load("off");
    const ctx = { userId: "u1", activeWorkspaceId: "w1", workspaceIds: ["w1"], via: "session" };
    const settings = await db.getSettings();
    expect(await db.getEffectivePreferences(ctx)).toEqual(settings);
    expect(await db.getEffectivePreferences(null)).toEqual(settings);
  });
});

// The Default row's comboStrategies is id-keyed (YAN-364): a rename keeps the
// combo.id entry (the blob's name-keyed rename never touches it), a delete
// drops it from the workspace row in the same transaction.
describe("combo rename/delete propagation to Default", () => {
  it("keeps the id entry through rename and drops it on delete", async () => {
    await load("on");
    const t = await seedTenancy();
    adapter.run(`INSERT INTO _meta(key, value) VALUES('defaultWorkspaceId', ?)`, [t.shared.id]);
    const combo = await db.createComboUnscoped({ name: "demo", models: [] });
    await db.updateComboStrategies(() => ({ demo: { fallbackStrategy: "weighted" } }));
    const sharedCtx = { ...t.a.ctx, activeWorkspaceId: t.shared.id };

    await db.updateComboUnscoped(combo.id, { name: "renamed" });
    const eff = await db.getEffectivePreferences(sharedCtx);
    expect(eff.comboStrategies).toEqual({ [combo.id]: { fallbackStrategy: "weighted" } });

    await db.deleteComboUnscoped(combo.id);
    const eff2 = await db.getEffectivePreferences(sharedCtx);
    expect(eff2.comboStrategies).toEqual({});
  });

  it("split mode: id-keyed entries survive rename; delete drops only that workspace's entry", async () => {
    await load("on");
    const t = await seedTenancy();
    adapter.run(`DELETE FROM workspaceSettings`);
    await db.updateSettings({ comboStrategies: {} });
    const solo = await db.createCombo(t.a.ctx, t.a.personal, { name: "solo", models: [] });
    const other = await db.createCombo(t.b.ctx, t.b.personal, { name: "other", models: [] });
    const weighted = { fallbackStrategy: "weighted" };
    await repo.updateWorkspaceComboStrategies(
      t.a.ctx,
      t.a.personal,
      (s) => ({ ...s, [solo.id]: weighted }),
      solo.id,
    );
    await repo.updateWorkspaceComboStrategies(
      t.b.ctx,
      t.b.personal,
      (s) => ({ ...s, [other.id]: weighted }),
      other.id,
    );
    const map = async (seeded, ws) =>
      (await repo.getWorkspaceSettings(seeded.ctx, ws)).data.comboStrategies;

    await db.updateCombo(t.a.ctx, solo.id, { name: "solo2" });
    expect(await map(t.a, t.a.personal)).toEqual({ [solo.id]: weighted });
    expect(await map(t.b, t.b.personal)).toEqual({ [other.id]: weighted });

    await db.deleteCombo(t.a.ctx, solo.id);
    expect(await map(t.a, t.a.personal)).toEqual({});
    expect(await map(t.b, t.b.personal)).toEqual({ [other.id]: weighted });
  });
});
