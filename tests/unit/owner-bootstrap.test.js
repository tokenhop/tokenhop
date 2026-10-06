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
  adapter.run(`DELETE FROM _meta WHERE key LIKE 'owner%' OR key = 'defaultWorkspaceId'`);
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
