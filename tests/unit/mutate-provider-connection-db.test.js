// YAN-1038: generic transactional read-decide-write on one connection, real SQLite.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-mutate-conn-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const mk = (name, extra = {}) =>
  db.createProviderConnectionUnscoped({
    provider: "codex",
    authType: "oauth",
    name,
    accessToken: "at-1",
    refreshToken: "rt-1",
    ...extra,
  });

describe("mutateProviderConnectionUnscoped", () => {
  it("is exported from the db index and the localDb shim", async () => {
    expect(typeof db.mutateProviderConnectionUnscoped).toBe("function");
    const shim = await import("@/lib/localDb.js");
    expect(shim.mutateProviderConnectionUnscoped).toBe(db.mutateProviderConnectionUnscoped);
  });

  it("applies the patch decided against the live row inside the transaction", async () => {
    const conn = await mk("mut-a");
    let seen;
    const r = await db.mutateProviderConnectionUnscoped(conn.id, (live) => {
      seen = live;
      return live.refreshToken === "rt-1" ? { refreshToken: "rt-2", accessToken: "at-2" } : null;
    });
    expect(r).toEqual({ applied: true, missing: false });
    expect(seen.refreshToken).toBe("rt-1");
    const after = await db.getProviderConnectionByIdUnscoped(conn.id);
    expect(after.refreshToken).toBe("rt-2");
    expect(after.accessToken).toBe("at-2");
  });

  it("does not apply when decide returns null", async () => {
    const conn = await mk("mut-b");
    const r = await db.mutateProviderConnectionUnscoped(conn.id, (live) =>
      live.refreshToken === "other" ? { refreshToken: "x" } : null,
    );
    expect(r).toEqual({ applied: false, missing: false });
    const after = await db.getProviderConnectionByIdUnscoped(conn.id);
    expect(after.refreshToken).toBe("rt-1");
  });

  it("reports a missing row without calling decide", async () => {
    const decide = vi.fn(() => ({ name: "x" }));
    const r = await db.mutateProviderConnectionUnscoped("nope", decide);
    expect(r).toEqual({ applied: false, missing: true });
    expect(decide).not.toHaveBeenCalled();
  });

  it("returns a narrow shape: never the row", async () => {
    const conn = await mk("mut-c");
    const r = await db.mutateProviderConnectionUnscoped(conn.id, () => ({ name: "mut-c2" }));
    expect(Object.keys(r).sort()).toEqual(["applied", "missing"]);
  });

  it("keeps mutateBillingLockUnscoped's return shape", async () => {
    const conn = await mk("mut-d");
    const lock = { reason: "credit_exhausted", generation: 3 };
    await db.updateProviderConnectionUnscoped(conn.id, { billingLock: lock });
    const applied = await db.mutateBillingLockUnscoped(conn.id, () => ({ billingLock: null }));
    expect(applied).toMatchObject({ applied: true, missing: false, billingLock: null });
    const skipped = await db.mutateBillingLockUnscoped(conn.id, () => null);
    expect(skipped).toMatchObject({ applied: false, missing: false, disabled: false });
    const missing = await db.mutateBillingLockUnscoped("nope", () => null);
    expect(missing).toEqual({ applied: false, missing: true, billingLock: null });
  });
});
