// YAN-359: transactional SSO admission (ssoAdmit) against real SQLite.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const ENV = "TOKENHOP_MULTI_USER";
const saved = { switch: process.env[ENV], email: process.env.TOKENHOP_OWNER_EMAIL };
let b;
let db;
let adapter;
let sso;
let owner;

const DEFAULTS = {
  password: null,
  requireLogin: true,
  oidcIssuerUrl: "",
  samlEntryPoint: "",
  samlCert: "",
  ssoAllowedGroups: [],
  ssoAdminGroups: [],
  ssoGroupWorkspaceMap: [],
  ssoDefaultRole: "pending",
};

const count = (sql, p = []) => adapter.get(sql, p).c;
const user = (id) => adapter.get(`SELECT * FROM users WHERE id = ?`, [id]);
const sv = (id) => user(id).sessionVersion;
const idp = (sub, extra = {}) => ({
  provider: "oidc",
  issuer: "https://idp.test",
  subject: sub,
  ...extra,
});
const members = (id) =>
  adapter.all(`SELECT workspaceId, role, source FROM memberships WHERE userId = ?`, [id]);
const shared = async (name) => (await db.createSharedWorkspace({ userId: owner.id }, { name })).id;

beforeEach(async () => {
  vi.resetModules();
  process.env[ENV] = "on";
  delete process.env.TOKENHOP_OWNER_EMAIL;
  globalThis.__tokenhopOwnerBootstrap = { done: false, failedAt: 0, running: null };
  b = await import("@/lib/users/bootstrap");
  db = await import("@/lib/db/index.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  sso = await import("@/lib/users/ssoProvisioning.js");
  for (const t of ["memberships", "identities", "workspaces", "users"])
    adapter.run(`DELETE FROM ${t}`);
  adapter.run(`DELETE FROM _meta WHERE key LIKE 'owner%' OR key = 'defaultWorkspaceId'`);
  await db.updateSettings(DEFAULTS);
  await b.ensureOwnerBootstrap({ throwOnError: true });
  owner = await db.getOwnerUnscoped();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(() => {
  for (const [k, v] of [
    [ENV, saved.switch],
    ["TOKENHOP_OWNER_EMAIL", saved.email],
  ]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("ssoAdmit JIT", () => {
  it("JITs a pending user with personal workspace, identity and idp membership", async () => {
    const ws = await shared("Eng");
    await db.updateSettings({
      ssoAllowedGroups: ["eng"],
      ssoGroupWorkspaceMap: [{ group: "eng", workspaceId: ws, role: "member" }],
    });
    const out = await sso.ssoAdmit(idp("p1", { email: "p1@corp.test" }), ["eng"]);
    expect(out.kind).toBe("pending");
    expect(user(out.userId)).toMatchObject({
      instanceRole: "pending",
      status: "active",
      email: "p1@corp.test",
    });
    expect(
      count(`SELECT COUNT(*) AS c FROM workspaces WHERE kind='personal' AND createdBy = ?`, [
        out.userId,
      ]),
    ).toBe(1);
    expect(
      count(`SELECT COUNT(*) AS c FROM identities WHERE userId = ? AND subject = 'p1'`, [
        out.userId,
      ]),
    ).toBe(1);
    expect(members(out.userId).filter((m) => m.source === "idp")).toEqual([
      { workspaceId: ws, role: "member", source: "idp" },
    ]);
  });

  it("promotes on admin group, demotes on loss with sv+1, keeps manual admin", async () => {
    await db.updateSettings({ ssoAdminGroups: ["adm"] });
    const a = await sso.ssoAdmit(idp("a1"), ["adm"]);
    expect(a.kind).toBe("active");
    expect(user(a.userId)).toMatchObject({ instanceRole: "admin", instanceRoleSource: "idp" });
    const v1 = sv(a.userId);
    await sso.ssoAdmit(idp("a1"), ["adm"]);
    expect(sv(a.userId)).toBe(v1); // no change, no bump
    await sso.ssoAdmit(idp("a1"), ["other"]);
    expect(user(a.userId)).toMatchObject({ instanceRole: "user", instanceRoleSource: null });
    expect(sv(a.userId)).toBe(v1 + 1);

    const m = await sso.ssoAdmit(idp("m1"), []);
    adapter.run(`UPDATE users SET instanceRole='admin', instanceRoleSource=NULL WHERE id = ?`, [
      m.userId,
    ]);
    const v2 = sv(m.userId);
    await sso.ssoAdmit(idp("m1"), ["other"]);
    expect(user(m.userId).instanceRole).toBe("admin");
    expect(sv(m.userId)).toBe(v2);
  });

  it("keys on stable subject; missing or duplicate email never links or merges", async () => {
    const n0 = count(`SELECT COUNT(*) AS c FROM users`);
    const s1 = await sso.ssoAdmit(idp("s1"), []);
    expect((await sso.ssoAdmit(idp("s1"), [])).userId).toBe(s1.userId);
    expect(user(s1.userId).email).toBeNull();
    const s2 = await sso.ssoAdmit(idp("s2", { email: "dup@corp.test" }), []);
    const s3 = await sso.ssoAdmit(idp("s3", { email: "DUP@corp.test" }), []);
    expect(new Set([s1.userId, s2.userId, s3.userId]).size).toBe(3);
    expect(user(s2.userId).email).toBe("dup@corp.test");
    expect(user(s3.userId).email).toBeNull();
    expect(count(`SELECT COUNT(*) AS c FROM users`)).toBe(n0 + 3);
  });

  it("denied by allow-list: no new identity, setup token not consumed", async () => {
    await db.updateSettings({ ssoAllowedGroups: ["ok"] });
    const { token } = await b.mintSetupToken();
    const before = [
      count(`SELECT COUNT(*) AS c FROM users`),
      count(`SELECT COUNT(*) AS c FROM identities`),
    ];
    await expect(sso.ssoAdmit(idp("d1"), ["no"], { setupToken: token })).rejects.toMatchObject({
      code: "denied",
    });
    expect([
      count(`SELECT COUNT(*) AS c FROM users`),
      count(`SELECT COUNT(*) AS c FROM identities`),
    ]).toEqual(before);
    expect(await db.getMeta("ownerSetupTokenHash")).not.toBeNull();
    const ok = await sso.ssoAdmit(idp("d1"), ["ok"], { setupToken: token }); // token still valid
    expect(ok).toEqual({ kind: "active", userId: owner.id });
  });

  it("bumps sv exactly once for a membership-only change; manual row remains", async () => {
    const [wa, wb, wc] = [await shared("A"), await shared("B"), await shared("C")];
    const u = await sso.ssoAdmit(idp("mm"), []);
    adapter.run(
      `INSERT INTO memberships(workspaceId,userId,role,source,createdAt) VALUES(?,?,?,?,?)`,
      [wc, u.userId, "member", "manual", new Date().toISOString()],
    );
    await db.updateSettings({
      ssoGroupWorkspaceMap: [
        { group: "a", workspaceId: wa, role: "member" },
        { group: "b", workspaceId: wb, role: "viewer" },
      ],
    });
    const v0 = sv(u.userId);
    await sso.ssoAdmit(idp("mm"), ["a", "b"]);
    expect(sv(u.userId)).toBe(v0 + 1);
    await sso.ssoAdmit(idp("mm"), ["a", "b"]);
    expect(sv(u.userId)).toBe(v0 + 1);
    const rows = members(u.userId); // includes the user's own Personal manual row
    expect(
      rows
        .filter((m) => m.source === "idp")
        .map((m) => m.workspaceId)
        .sort(),
    ).toEqual([wa, wb].sort());
    expect(rows.find((m) => m.workspaceId === wc)).toMatchObject({
      role: "member",
      source: "manual",
    });
  });

  it("fails and rolls back on missing configured target or last-manager removal", async () => {
    await db.updateSettings({
      ssoGroupWorkspaceMap: [{ group: "g", workspaceId: "missing", role: "member" }],
    });
    const n = [
      count(`SELECT COUNT(*) AS c FROM users`),
      count(`SELECT COUNT(*) AS c FROM workspaces`),
    ];
    await expect(sso.ssoAdmit(idp("x1"), ["other"])).rejects.toMatchObject({ code: "sync_failed" });
    expect([
      count(`SELECT COUNT(*) AS c FROM users`),
      count(`SELECT COUNT(*) AS c FROM workspaces`),
    ]).toEqual(n);
    expect(count(`SELECT COUNT(*) AS c FROM identities WHERE subject = 'x1'`)).toBe(0);

    const ws = await shared("M");
    await db.updateSettings({
      ssoGroupWorkspaceMap: [{ group: "m", workspaceId: ws, role: "manager" }],
    });
    const u = await sso.ssoAdmit(idp("lm"), ["m"]);
    adapter.run(`DELETE FROM memberships WHERE workspaceId = ? AND userId = ?`, [ws, owner.id]);
    await db.updateSettings({ ssoAdminGroups: ["adm"] });
    const v = sv(u.userId);
    await expect(sso.ssoAdmit(idp("lm"), ["adm"])).rejects.toMatchObject({ code: "sync_failed" });
    expect(user(u.userId)).toMatchObject({ instanceRole: "pending", instanceRoleSource: null });
    expect(members(u.userId).filter((m) => m.workspaceId === ws)).toEqual([
      { workspaceId: ws, role: "manager", source: "idp" },
    ]);
    expect(sv(u.userId)).toBe(v);
  });

  // Raw in-place settings patch, bypassing any read cache (mimics a concurrent
  // admin change landing between the pre-read getSettings and the write tx).
  const patchSettings = (patch) => {
    const row = adapter.get(`SELECT data FROM settings WHERE id = 1`);
    const data = { ...(row ? JSON.parse(row.data) : {}), ...patch };
    adapter.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [JSON.stringify(data)],
    );
  };
  const tightenBeforeTx = (patch) =>
    vi.spyOn(adapter, "transaction").mockImplementationOnce((fn) => {
      patchSettings(patch);
      return fn();
    });

  it("policy tightened mid-admission: denial rolls back, no stale admin grant", async () => {
    await db.updateSettings({ ssoAdminGroups: ["adm"] });
    // Allow-list added between pre-read and tx: the in-tx re-read must deny.
    tightenBeforeTx({ ssoAllowedGroups: ["ok"] });
    await expect(sso.ssoAdmit(idp("r1"), ["adm"])).rejects.toMatchObject({ code: "denied" });
    vi.restoreAllMocks();
    expect(count(`SELECT COUNT(*) AS c FROM users`)).toBe(1);
    expect(count(`SELECT COUNT(*) AS c FROM identities WHERE provider = 'oidc'`)).toBe(0);

    // Admin groups removed between pre-read and tx: admitted, but not promoted.
    tightenBeforeTx({ ssoAdminGroups: [] });
    const out = await sso.ssoAdmit(idp("r2"), ["ok", "adm"]);
    vi.restoreAllMocks();
    expect(out.kind).toBe("pending");
    expect(user(out.userId)).toMatchObject({ instanceRole: "pending", instanceRoleSource: null });
  });

  it("audits JIT and promotion with ids/roles/counts only", async () => {
    adapter.run(`DELETE FROM auditEvents`);
    const j = await sso.ssoAdmit(idp("au1", { email: "au1@corp.test" }), ["grp-secret"]);
    await db.updateSettings({ ssoAdminGroups: ["adm"] });
    await sso.ssoAdmit(idp("au1", { email: "au1@corp.test" }), ["adm", "grp-secret"]);
    await new Promise((r) => setTimeout(r, 0)); // audit is fire-and-forget
    const rows = adapter
      .all(`SELECT action, targetId, before, after, result FROM auditEvents`)
      .filter((r) => r.action === "auth.ssoSync" && r.targetId === j.userId);
    expect(rows).toHaveLength(2);
    const [created, promoted] = rows;
    expect(created.result).toBe("success");
    expect(created.before).toBeNull();
    expect(JSON.parse(created.after)).toEqual({
      provider: "oidc",
      role: "pending",
      reason: "provisioned",
      count: 0,
    });
    expect(JSON.parse(promoted.before)).toEqual({ role: "pending" });
    expect(JSON.parse(promoted.after)).toEqual({
      provider: "oidc",
      role: "admin",
      reason: "synced",
      count: 0,
    });
    const blob = rows.map((r) => `${r.before} ${r.after}`).join(" ");
    expect(blob).not.toMatch(/grp-secret|au1@corp\.test|token/i);
  });

  it("concurrent admission of the same identity converges to one user", async () => {
    const [x, y] = await Promise.all([
      sso.ssoAdmit(idp("cc", { email: "cc@corp.test" }), []),
      sso.ssoAdmit(idp("cc", { email: "cc@corp.test" }), []),
    ]);
    expect(x.userId).toBe(y.userId);
    expect(count(`SELECT COUNT(*) AS c FROM users`)).toBe(2); // owner + cc
    expect(count(`SELECT COUNT(*) AS c FROM identities WHERE subject = 'cc'`)).toBe(1);
  });
});

// Reviewer blocker: the service itself fails closed when security isn't
// enforced (pristine-off: switch off, no hashed-key marker), even for an
// already-linked identity that skips owner bootstrap.
describe("ssoAdmit with the switch off", () => {
  it("denies a linked identity and writes nothing", async () => {
    const linked = await sso.ssoAdmit(idp("off1"), []);
    const before = { sv: sv(linked.userId), users: count(`SELECT COUNT(*) AS c FROM users`) };

    vi.resetModules();
    process.env[ENV] = "off";
    const off = await import("@/lib/users/ssoProvisioning.js");
    await expect(off.ssoAdmit(idp("off1"), [])).rejects.toMatchObject({ code: "denied" });
    await expect(off.ssoAdmit(idp("off2"), [])).rejects.toMatchObject({ code: "denied" });

    expect(sv(linked.userId)).toBe(before.sv);
    expect(count(`SELECT COUNT(*) AS c FROM users`)).toBe(before.users);
  });
});

// Marker-latched off: hashed gateway-key storage was established, then the
// switch was turned off. Security stays enforced, so a linked identity is
// still admitted and synced, and an unlinked one never falls back to owner.
describe("ssoAdmit with the switch off but security latched", () => {
  it("admits the linked identity, keeps syncing, refuses new identities", async () => {
    const linked = await sso.ssoAdmit(idp("latch1"), []);
    adapter.run(
      `INSERT INTO _meta(key, value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid','0123456789abcdef')`,
    );
    try {
      vi.resetModules();
      process.env[ENV] = "off";
      const off = await import("@/lib/users/ssoProvisioning.js");
      await db.updateSettings({ ssoAdminGroups: ["adm"] });
      const out = await off.ssoAdmit(idp("latch1"), ["adm"]);
      expect(out).toEqual({ kind: "active", userId: linked.userId });
      expect(user(linked.userId).instanceRole).toBe("admin");
      const before = count(`SELECT COUNT(*) AS c FROM users`);
      await expect(off.ssoAdmit(idp("latch-new"), [])).rejects.toMatchObject({ code: "denied" });
      expect(count(`SELECT COUNT(*) AS c FROM users`)).toBe(before);
    } finally {
      adapter.run(`DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')`);
    }
  });
});
