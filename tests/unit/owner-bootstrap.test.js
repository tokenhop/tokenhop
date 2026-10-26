// YAN-356: owner bootstrap, Default workspace, SSO owner linking (setup token,
// TOKENHOP_OWNER_EMAIL), single-user mode refusals and the multiUserActive gate.
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const ENV = "TOKENHOP_MULTI_USER";
const saved = { switch: process.env[ENV], email: process.env.TOKENHOP_OWNER_EMAIL };

let b; // @/lib/users/bootstrap
let s; // @/lib/users/session
let db; // @/lib/db/index.js
let adapter;

async function load(state) {
  vi.resetModules();
  process.env[ENV] = state;
  globalThis.__tokenhopOwnerBootstrap = { done: false, failedAt: 0, running: null };
  b = await import("@/lib/users/bootstrap");
  s = await import("@/lib/users/session");
  db = await import("@/lib/db/index.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
}

// A v1.0.x install: no users, settings as given.
async function legacy(settings) {
  for (const t of ["memberships", "identities", "workspaces", "users"]) {
    adapter.run(`DELETE FROM ${t}`);
  }
  adapter.run(
    `DELETE FROM _meta WHERE key LIKE 'owner%' OR key IN ('defaultWorkspaceId', 'usageAdoptedAt')`,
  );
  await db.updateSettings({
    password: null,
    requireLogin: true,
    oidcIssuerUrl: "",
    samlEntryPoint: "",
    samlCert: "",
    ...settings,
  });
}

const count = (sql) => adapter.get(sql).c;
const oidc = (subject, extra = {}) => ({
  provider: "oidc",
  issuer: "https://idp.test",
  subject,
  email: "owner@corp.test",
  emailVerified: true,
  ...extra,
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

describe("switch on", () => {
  let log;
  let out;
  beforeEach(async () => {
    delete process.env.TOKENHOP_OWNER_EMAIL;
    await load("on");
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("mints one owner with the settings password hash and a Default workspace, idempotently", async () => {
    const hash = await bcrypt.hash("s3cret", 4);
    await legacy({ password: hash });
    await b.ensureOwnerBootstrap();
    globalThis.__tokenhopOwnerBootstrap.done = false;
    await b.ensureOwnerBootstrap(); // re-run: no-op

    const owner = await db.getOwnerUnscoped();
    expect(await db.getUserPasswordHashUnscoped(owner.id)).toBe(hash);
    expect(count(`SELECT COUNT(*) AS c FROM users`)).toBe(1);
    expect(count(`SELECT COUNT(*) AS c FROM identities WHERE provider = 'password'`)).toBe(1);
    const ws = await db.listWorkspaces({ userId: owner.id });
    expect(ws.map((w) => [w.name, w.kind, w.role]).sort()).toEqual([
      ["Default", "shared", "owner"],
      ["Personal", "personal", "owner"],
    ]);
    expect(await db.getMeta("defaultWorkspaceId")).toBe(ws.find((w) => w.kind === "shared").id);
    expect(await db.getMeta("usageAdoptedAt")).toEqual(expect.any(String));
    const backups = fs.readdirSync(path.join(process.env.DATA_DIR, "db", "backups"));
    expect(backups.some((d) => d.startsWith("users-bootstrap-"))).toBe(true);
    // No SSO configured: no setup token.
    expect(await db.getMeta("ownerSetupTokenHash")).toBeNull();
  });

  it("aborts without rows when the backup fails, and retries later", async () => {
    await legacy({});
    const backup = await import("@/lib/db/backup.js");
    const spy = vi.spyOn(backup, "backupDbLite").mockImplementation(() => {
      throw new Error("disk full");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await b.ensureOwnerBootstrap();
    spy.mockRestore();
    expect(count(`SELECT COUNT(*) AS c FROM users`)).toBe(0);
    expect(globalThis.__tokenhopOwnerBootstrap.failedAt).toBeGreaterThan(0);
  });

  it("syncs a password change and reset to the owner and bumps sv", async () => {
    await legacy({});
    await b.ensureOwnerBootstrap();
    const owner = await db.getOwnerUnscoped();
    await s.revokeOwnerSessions(null, { passwordHash: "h2" });
    expect(await db.getUserPasswordHashUnscoped(owner.id)).toBe("h2");
    await s.revokeOwnerSessions(null, { passwordHash: null });
    expect(await db.getUserPasswordHashUnscoped(owner.id)).toBeNull();
    expect((await db.getOwnerUnscoped()).sessionVersion).toBe(owner.sessionVersion + 2);
  });

  it("keeps the default-password path when no hash is stored", async () => {
    await legacy({});
    await b.ensureOwnerBootstrap();
    const owner = await db.getOwnerUnscoped();
    expect(await db.getUserPasswordHashUnscoped(owner.id)).toBeNull();
    expect(owner.mustChangePassword).toBe(1);
    expect(await s.sessionClaims("pwd")).toBeNull();
  });

  it.each([
    ["OIDC", { oidcIssuerUrl: "https://idp.test", oidcClientId: "c", oidcClientSecret: "x" }],
    ["SAML", { samlEntryPoint: "https://idp.test/sso", samlCert: "MIIC" }],
  ])("%s configured: links nothing, prints one setup token", async (_name, settings) => {
    await legacy(settings);
    await b.ensureOwnerBootstrap();
    expect(count(`SELECT COUNT(*) AS c FROM identities WHERE provider != 'password'`)).toBe(0);
    // Printed to stdout only, never through console.* (the console-log buffer).
    expect(log.mock.calls.flat().join("\n")).not.toMatch(/setup token \(/);
    const printed = out.mock.calls
      .flat()
      .join("\n")
      .match(/setup token \(.*?\): (\S+)/);
    expect(printed).not.toBeNull();
    expect(await db.getMeta("ownerSetupTokenHash")).not.toContain(printed[1]);
  });

  it("never links the first SSO login without the token or owner email", async () => {
    await legacy({});
    await b.ensureOwnerBootstrap();
    expect(await b.resolveSsoUser(oidc("first"))).toBeNull();
    expect(count(`SELECT COUNT(*) AS c FROM identities WHERE provider = 'oidc'`)).toBe(0);
  });

  it("links the owner with a setup token once; reuse and expiry fail", async () => {
    await legacy({});
    await b.ensureOwnerBootstrap();
    const owner = await db.getOwnerUnscoped();
    const { token } = await b.mintSetupToken();
    expect(await b.resolveSsoUser(oidc("a"), { setupToken: "wrong" })).toBeNull();
    expect(await b.resolveSsoUser(oidc("a"), { setupToken: token })).toBe(owner.id);
    expect(await b.resolveSsoUser(oidc("b"), { setupToken: token })).toBeNull();
    expect(await b.resolveSsoUser(oidc("a"))).toBe(owner.id); // linked now

    const race = await b.mintSetupToken(); // single use under concurrency too
    const spent = await Promise.all([
      b.consumeSetupToken(race.token),
      b.consumeSetupToken(race.token),
    ]);
    expect(spent.filter(Boolean)).toHaveLength(1);

    const expired = await b.mintSetupToken();
    await db.setMeta("ownerSetupTokenExpiresAt", Date.now() - 1);
    expect(await b.resolveSsoUser(oidc("c"), { setupToken: expired.token })).toBeNull();
  });

  it("links by TOKENHOP_OWNER_EMAIL only for a verified match, once", async () => {
    process.env.TOKENHOP_OWNER_EMAIL = "Owner@Corp.test";
    await legacy({});
    await b.ensureOwnerBootstrap();
    const owner = await db.getOwnerUnscoped();
    expect(await b.resolveSsoUser(oidc("u", { emailVerified: false }))).toBeNull();
    expect(await b.resolveSsoUser(oidc("u", { email: "x@corp.test" }))).toBeNull();
    expect(await b.resolveSsoUser(oidc("u"))).toBe(owner.id);
    expect(await b.resolveSsoUser(oidc("other"))).toBeNull(); // consumed
  });

  // YAN-359: sessionClaims no longer links or falls back to the owner for SSO.
  // The setup-token proof links through resolveSsoUser (inside admission); the
  // session then needs the admitted user id and an identity linked to it.
  it("a linked owner identity signs in as the owner with two users; unlinked is refused", async () => {
    // A real password hash, so the owner isn't flagged for rotation: a flagged
    // owner never gets SSO claims either (YAN-358).
    await legacy({ password: bcrypt.hashSync("owner-pass", 4) });
    await b.ensureOwnerBootstrap();
    const owner = await db.getOwnerUnscoped();
    const { token } = await b.mintSetupToken();
    await db.createUserUnscoped({ email: "b@corp.test", instanceRole: "user" });
    expect(await s.sessionClaims("oidc", oidc("stranger"))).toBeNull();
    expect(await b.resolveSsoUser(oidc("a"), { setupToken: token })).toBe(owner.id);
    expect(await s.sessionClaims("oidc", oidc("a"), { admittedUserId: owner.id })).toMatchObject({
      sub: owner.id,
      amr: ["oidc"],
    });
    // An admitted id the identity isn't linked to never mints claims.
    expect(
      await s.sessionClaims("oidc", oidc("stranger"), { admittedUserId: owner.id }),
    ).toBeNull();
  });

  it("refuses login-off with two users, and a second user while login is off", async () => {
    await legacy({});
    await b.ensureOwnerBootstrap();
    expect(await b.multiUserActive()).toBe(false);

    await db.updateSettings({ requireLogin: false });
    await expect(db.createUserUnscoped({ email: "b@corp.test" })).rejects.toMatchObject({
      code: "SINGLE_USER_MODE",
    });
    await db.updateSettings({ requireLogin: true });
    await db.createUserUnscoped({ email: "b@corp.test", instanceRole: "user" });
    expect(await b.multiUserActive()).toBe(true);

    const { PATCH } = await import("@/app/api/settings/route.js");
    const res = await PATCH(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requireLogin: false }),
      }),
    );
    expect(res.status).toBe(409);
    expect((await db.getSettings()).requireLogin).toBe(true);
  });

  // YAN-1549: ownerless usage of every kind, as a deleted workspace leaves it.
  const ownerlessUsage = (tag) => {
    const now = new Date().toISOString();
    adapter.run(`INSERT INTO usageHistory(timestamp, provider) VALUES(?, ?)`, [now, tag]);
    adapter.run(`INSERT INTO requestDetails(id, timestamp, data) VALUES(?, ?, '{}')`, [tag, now]);
    adapter.run(`INSERT INTO usageRollup(dateKey, provider, requests) VALUES('2026-10-01', ?, 1)`, [
      tag,
    ]);
    adapter.run(`INSERT INTO usageBudgetCarry(day, apiKeyId, usd) VALUES('2026-10-01', ?, 1)`, [
      tag,
    ]);
  };
  const usageWorkspaces = (tag) => [
    adapter.get(`SELECT workspaceId FROM usageHistory WHERE provider = ?`, [tag])?.workspaceId,
    adapter.get(`SELECT workspaceId FROM requestDetails WHERE id = ?`, [tag])?.workspaceId,
    adapter.get(`SELECT workspaceId FROM usageRollup WHERE provider = ?`, [tag])?.workspaceId,
    adapter.get(`SELECT workspaceId FROM usageBudgetCarry WHERE apiKeyId = ?`, [tag])?.workspaceId,
  ];
  const clearUsage = () => {
    for (const t of [
      "usageHistory",
      "requestDetails",
      "usageRollup",
      "usageComboRollup",
      "usageBudgetCarry",
    ]) {
      adapter.run(`DELETE FROM ${t}`);
    }
  };

  it("first bootstrap attributes legacy (pre-users) usage to Default and the owner", async () => {
    await legacy({});
    clearUsage();
    ownerlessUsage("legacy");
    await b.ensureOwnerBootstrap();
    const owner = await db.getOwnerUnscoped();
    const defaultId = await db.getMeta("defaultWorkspaceId");
    expect(usageWorkspaces("legacy")).toEqual([defaultId, defaultId, defaultId, defaultId]);
    expect(adapter.get(`SELECT userId FROM usageHistory WHERE provider = 'legacy'`).userId).toBe(
      owner.id,
    );
    expect(adapter.get(`SELECT userId FROM usageRollup WHERE provider = 'legacy'`).userId).toBe(
      owner.id,
    );
    expect(await db.getMeta("usageAdoptedAt")).toEqual(expect.any(String));
  });

  // YAN-1553: failed adoption cannot commit the owner or consume the marker.
  it("rolls back usage adoption and its marker, then adopts on retry", async () => {
    await legacy({});
    clearUsage();
    ownerlessUsage("rollback");
    adapter.exec(
      `CREATE TRIGGER fail_usage_adopt BEFORE UPDATE OF workspaceId ON usageHistory
       BEGIN SELECT RAISE(ABORT, 'usage adopt failed'); END`,
    );
    try {
      await expect(db.bootstrapOwnerUnscoped()).rejects.toThrow("usage adopt failed");
      expect(count(`SELECT COUNT(*) AS c FROM users`)).toBe(0);
      expect(await db.getMeta("usageAdoptedAt")).toBeNull();
      expect(usageWorkspaces("rollback")).toEqual([null, null, "", ""]);
    } finally {
      adapter.exec(`DROP TRIGGER fail_usage_adopt`);
    }
    const owner = await db.bootstrapOwnerUnscoped();
    expect(usageWorkspaces("rollback")).toEqual(Array(4).fill(owner.defaultWorkspaceId));
    expect(await db.getMeta("usageAdoptedAt")).toEqual(expect.any(String));
  });

  it("keeps a deleted workspace's usage detached across restarts and switch toggles", async () => {
    await legacy({});
    clearUsage();
    await b.ensureOwnerBootstrap();
    const owner = await db.getOwnerUnscoped();
    const team = await db.createSharedWorkspace({ userId: owner.id }, { name: "Team" });
    const now = new Date().toISOString();
    adapter.run(`INSERT INTO usageHistory(timestamp, provider, workspaceId) VALUES(?, 'team', ?)`, [
      now,
      team.id,
    ]);
    adapter.run(
      `INSERT INTO requestDetails(id, timestamp, data, workspaceId) VALUES('team', ?, '{}', ?)`,
      [now, team.id],
    );
    adapter.run(
      `INSERT INTO usageRollup(dateKey, workspaceId, provider, requests) VALUES('2026-10-01', ?, 'team', 1)`,
      [team.id],
    );
    adapter.run(
      `INSERT INTO usageBudgetCarry(day, workspaceId, apiKeyId, usd) VALUES('2026-10-01', ?, 'team', 1)`,
      [team.id],
    );
    // The real deletion: history SET NULL, carry detached to ''. The rollup has
    // no FK and keeps the dead id, which no workspace scope can match.
    const { deleteWorkspaceSyncUnscoped } = await import("@/lib/db/repos/workspacesRepo.js");
    const { sessionVersion } = adapter.get(`SELECT sessionVersion FROM users WHERE id = ?`, [
      owner.id,
    ]);
    adapter.transaction(() =>
      deleteWorkspaceSyncUnscoped(adapter, team.id, { actorId: owner.id, sessionVersion }),
    );
    // Rollup rows of unknown attribution ('') arise the same way (no FK).
    adapter.run(`UPDATE usageRollup SET workspaceId = '' WHERE workspaceId = ?`, [team.id]);
    const detached = [null, null, "", ""];
    expect(usageWorkspaces("team")).toEqual(detached);
    // A connection written while the switch was off is still adopted.
    const now2 = new Date().toISOString();
    adapter.run(
      `INSERT INTO providerConnections(id, provider, authType, name, priority, isActive, data, createdAt, updatedAt)
       VALUES('pc-off', 'anthropic', 'apikey', 'off', 1, 1, '{}', ?, ?)`,
      [now2, now2],
    );

    // Restart with the switch on: a fresh process re-runs the bootstrap.
    await load("on");
    await b.ensureOwnerBootstrap({ throwOnError: true });
    expect(usageWorkspaces("team")).toEqual(detached);
    expect(
      adapter.get(`SELECT workspaceId FROM providerConnections WHERE id = 'pc-off'`).workspaceId,
    ).toBe(await db.getMeta("defaultWorkspaceId"));
    // Off, then on again (first request after the enable).
    await load("off");
    await b.ensureOwnerBootstrap();
    await load("on");
    await b.ensureOwnerBootstrap();
    expect(usageWorkspaces("team")).toEqual(detached);
    expect(await db.adoptOwnerlessUnscoped()).toBe(0);
    expect(usageWorkspaces("team")).toEqual(detached);
  });

  // YAN-768: shared workspaces no longer count towards the gate.
  it("one active user and two shared workspaces → multiUserActive false", async () => {
    await legacy({});
    await b.ensureOwnerBootstrap();
    const owner = await db.getOwnerUnscoped();
    await db.createSharedWorkspace({ userId: owner.id }, { name: "S1" });
    await db.createSharedWorkspace({ userId: owner.id }, { name: "S2" });
    expect(count(`SELECT COUNT(*) AS c FROM users`)).toBe(1);
    expect(count(`SELECT COUNT(*) AS c FROM workspaces WHERE kind = 'shared'`)).toBe(3); // + Default
    expect(await b.multiUserActive()).toBe(false);
  });

  // YAN-1553: config import on the existing-owner path preserves adoption.
  it("keeps detached usage and the install marker across config import and restart", async () => {
    await legacy({});
    clearUsage();
    await b.ensureOwnerBootstrap({ throwOnError: true });
    const marker = await db.getMeta("usageAdoptedAt");
    ownerlessUsage("config");
    const { applyConfig } = await import("@/lib/db/configExport.js");
    await applyConfig({
      settings: { requireLogin: true },
      combos: [{ name: "Imported", kind: "fallback", models: ["openai/gpt-4o"] }],
      pricingOverrides: {},
    });
    expect(usageWorkspaces("config")).toEqual([null, null, "", ""]);
    expect(await db.getMeta("usageAdoptedAt")).toBe(marker);
    await load("on");
    await b.ensureOwnerBootstrap({ throwOnError: true });
    expect(usageWorkspaces("config")).toEqual([null, null, "", ""]);
    expect(await db.getMeta("usageAdoptedAt")).toBe(marker);
  });

  // YAN-1553: the install's usage adoption survives an owner-forced restore
  // with no users; startup must not mistake retained telemetry for legacy data.
  it("keeps detached usage after a forced user-less instance restore and bootstrap", async () => {
    await legacy({});
    clearUsage();
    await b.ensureOwnerBootstrap({ throwOnError: true });
    await db.setMeta("usageAdoptedAt", "2026-10-01T00:00:00.000Z");
    ownerlessUsage("restored");
    const owner = await db.getOwnerUnscoped();
    const defaultId = await db.getMeta("defaultWorkspaceId");
    // The older snapshot omits usage sections: live attribution is detached
    // by the real restore path, rather than manually deleting the owner.
    adapter.run(`UPDATE usageHistory SET workspaceId = ?, userId = ? WHERE provider = 'restored'`, [
      defaultId,
      owner.id,
    ]);
    const masterKey = Buffer.alloc(32, 7);
    try {
      const { hashGatewayKeysSync } = await import("@/lib/db/migrations/hashGatewayKeys.js");
      hashGatewayKeysSync(adapter, {
        masterKey,
        defaultWorkspaceId: defaultId,
        backup: { completed: true, db: adapter },
      });
      const { masterKeyId } = await import("@/lib/security/masterKey.js");
      await db.importDb(
        {
          formatVersion: 2,
          apiKeyStorage: { storage: "hashed", version: 1, hashKid: masterKeyId(masterKey) },
          users: [],
          identities: [],
          workspaces: [],
          memberships: [],
          apiKeys: [],
          workspaceSettings: [],
          userPreferences: [],
          connectionGrants: [],
          budgets: [],
          invitations: [],
        },
        { masterKey, force: true, actor: { instanceRole: "owner" } },
      );
      expect(await db.getOwnerUnscoped()).toBeNull();
      expect(usageWorkspaces("restored")).toEqual([null, null, "", ""]);
      expect(await db.getMeta("usageAdoptedAt")).toBe("2026-10-01T00:00:00.000Z");
      // Config import also preserves the marker on the no-owner restore path.
      const { applyConfig } = await import("@/lib/db/configExport.js");
      await applyConfig({ settings: {}, combos: [], pricingOverrides: {} });
      expect(usageWorkspaces("restored")).toEqual([null, null, "", ""]);
      expect(await db.getMeta("usageAdoptedAt")).toBe("2026-10-01T00:00:00.000Z");

      await load("on");
      await b.ensureOwnerBootstrap({ throwOnError: true });
      expect(usageWorkspaces("restored")).toEqual([null, null, "", ""]);
      expect(await db.getMeta("usageAdoptedAt")).toBe("2026-10-01T00:00:00.000Z");
      expect(
        adapter.get(`SELECT userId FROM usageHistory WHERE provider = 'restored'`).userId,
      ).toBeNull();
      expect(adapter.get(`SELECT userId FROM usageRollup WHERE provider = 'restored'`).userId).toBe(
        "",
      );
    } finally {
      // Restore this file's pre-activation fixture for the switch-off cases.
      const { TABLES, buildCreateTableSql } = await import("@/lib/db/schema.js");
      adapter.exec(`DROP TABLE apiKeys`);
      adapter.exec(buildCreateTableSql("apiKeys", TABLES.apiKeys));
      adapter.run(`DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion', 'apiKeysHashKid')`);
    }
  });
});

describe("switch off", () => {
  beforeEach(async () => {
    await load("off");
  });

  it("bootstraps nothing and links nothing", async () => {
    await legacy({ oidcIssuerUrl: "https://idp.test", oidcClientId: "c", oidcClientSecret: "x" });
    await b.ensureOwnerBootstrap();
    expect(count(`SELECT COUNT(*) AS c FROM users`)).toBe(0);
    expect(await db.getMeta("ownerSetupTokenHash")).toBeNull();
    expect(await b.resolveSsoUser(oidc("a"))).toBeNull();
    expect(await b.multiUserActive()).toBe(false);
    expect(await s.sessionClaims("oidc", oidc("a"))).toEqual({});
  });
});
