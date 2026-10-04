// YAN-363: strict owner-bootstrap readiness. ensureOwnerBootstrap({throwOnError})
// rejects on a real DB backup/bootstrap failure, propagates an in-flight failure
// even when a permissive caller started it, resolves verified owner/Default/
// membership invariants on success, keeps the switch-off path inert, and never
// caches a failed completion as done.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const ENV = "TOKENHOP_MULTI_USER";
const saved = { switch: process.env[ENV] };

let b; // @/lib/users/bootstrap
let db; // @/lib/db/index.js
let adapter;

async function load(state) {
  vi.resetModules();
  process.env[ENV] = state;
  globalThis.__tokenhopOwnerBootstrap = { done: false, failedAt: 0, running: null };
  b = await import("@/lib/users/bootstrap");
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

afterAll(() => {
  if (saved.switch === undefined) delete process.env[ENV];
  else process.env[ENV] = saved.switch;
});

beforeEach(async () => {
  await load("on");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

describe("strict owner-bootstrap readiness", () => {
  it("resolves verified owner/Default/membership invariants on success", async () => {
    await legacy({});
    const out = await b.ensureOwnerBootstrap({ throwOnError: true });
    const owner = await db.getOwnerUnscoped();
    expect(out).toEqual({
      enabled: true,
      ownerId: owner.id,
      defaultWorkspaceId: await db.getMeta("defaultWorkspaceId"),
    });
    expect(globalThis.__tokenhopOwnerBootstrap.done).toBe(true);
  });

  it("rejects on a real backup failure, without rows, without caching done", async () => {
    await legacy({});
    const backup = await import("@/lib/db/backup.js");
    const spy = vi.spyOn(backup, "backupDbLite").mockImplementation(() => {
      throw new Error("disk full");
    });
    await expect(b.ensureOwnerBootstrap({ throwOnError: true })).rejects.toThrow(/disk full/);
    spy.mockRestore();
    expect(count(`SELECT COUNT(*) AS c FROM users`)).toBe(0);
    expect(globalThis.__tokenhopOwnerBootstrap.done).toBe(false);
    expect(globalThis.__tokenhopOwnerBootstrap.failedAt).toBeGreaterThan(0);
    // Strict bypasses the permissive retry throttle: the same call retried
    // now succeeds against the real DB.
    const out = await b.ensureOwnerBootstrap({ throwOnError: true });
    expect(out.enabled).toBe(true);
    expect(count(`SELECT COUNT(*) AS c FROM users`)).toBe(1);
  });

  it("rejects when the bootstrap read fails after backup (settings unreadable)", async () => {
    await legacy({});
    const spy = vi.spyOn(db, "getSettings").mockRejectedValueOnce(new Error("settings unreadable"));
    await expect(b.ensureOwnerBootstrap({ throwOnError: true })).rejects.toThrow(
      /settings unreadable/,
    );
    spy.mockRestore();
    expect(globalThis.__tokenhopOwnerBootstrap.done).toBe(false);
  });

  it("strict joins an in-flight run started by a permissive caller and still rejects", async () => {
    await legacy({});
    const backup = await import("@/lib/db/backup.js");
    const spy = vi.spyOn(backup, "backupDbLite").mockImplementation(() => {
      throw new Error("disk full");
    });
    const permissive = b.ensureOwnerBootstrap(); // starts the run, swallows
    const strict = b.ensureOwnerBootstrap({ throwOnError: true }); // joins it
    await expect(strict).rejects.toThrow(/disk full/);
    await expect(permissive).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("permissive callers keep today's behavior: resolve, log, never throw", async () => {
    await legacy({});
    const backup = await import("@/lib/db/backup.js");
    const spy = vi.spyOn(backup, "backupDbLite").mockImplementation(() => {
      throw new Error("disk full");
    });
    await expect(b.ensureOwnerBootstrap()).resolves.toBeUndefined();
    spy.mockRestore();
    expect(count(`SELECT COUNT(*) AS c FROM users`)).toBe(0);
    expect(console.warn).toHaveBeenCalled();
  });

  it("strict after permissive success verifies and returns the same invariants", async () => {
    await legacy({});
    await b.ensureOwnerBootstrap();
    const out = await b.ensureOwnerBootstrap({ throwOnError: true });
    expect(out.ownerId).toBe((await db.getOwnerUnscoped()).id);
  });

  it("existing owner: adoption runs and strict resolves the same invariants", async () => {
    await legacy({});
    await b.ensureOwnerBootstrap({ throwOnError: true });
    // Simulate a pre-YAN-361 ownerless row: the next run adopts it into Default.
    const ws = await db.getMeta("defaultWorkspaceId");
    adapter.run(
      `INSERT INTO providerConnections(id, provider, authType, data, createdAt, updatedAt)
       VALUES('conn-ownerless', 'p', 'apikey', '{}', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
    );
    expect(count(`SELECT COUNT(*) AS c FROM providerConnections WHERE workspaceId IS NULL`)).toBe(
      1,
    );
    globalThis.__tokenhopOwnerBootstrap.done = false;
    const out = await b.ensureOwnerBootstrap({ throwOnError: true });
    expect(out.defaultWorkspaceId).toBe(ws);
    expect(count(`SELECT COUNT(*) AS c FROM providerConnections WHERE workspaceId IS NULL`)).toBe(
      0,
    );
    adapter.run(`DELETE FROM providerConnections WHERE id = 'conn-ownerless'`);
  });

  it("corrupt owner state (no Default membership) rejects strict, done not cached", async () => {
    await legacy({});
    await b.ensureOwnerBootstrap({ throwOnError: true });
    const ws = await db.getMeta("defaultWorkspaceId");
    adapter.run(`DELETE FROM memberships WHERE workspaceId = ?`, [ws]);
    globalThis.__tokenhopOwnerBootstrap.done = false;
    await expect(b.ensureOwnerBootstrap({ throwOnError: true })).rejects.toMatchObject({
      code: "OWNER_BOOTSTRAP_INCOMPLETE",
    });
    expect(globalThis.__tokenhopOwnerBootstrap.done).toBe(false);
  });

  it("switch off: strict resolves enabled:false and creates nothing on a pristine DB", async () => {
    await load("off");
    await legacy({ oidcIssuerUrl: "https://idp.test", oidcClientId: "c", oidcClientSecret: "x" });
    const out = await b.ensureOwnerBootstrap({ throwOnError: true });
    expect(out).toEqual({ enabled: false });
    expect(count(`SELECT COUNT(*) AS c FROM users`)).toBe(0);
    expect(await db.getMeta("ownerSetupTokenHash")).toBeNull();
  });
});
