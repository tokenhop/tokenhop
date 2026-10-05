// YAN-367: audit log of security and administrative events — insert roundtrip,
// filters (exact + action prefix + ts range), pagination math, retention prune,
// NOT NULL enforcement on action, and migration idempotency.
import { beforeEach, describe, expect, it } from "vitest";

let repo;
let db;

beforeEach(async () => {
  repo = await import("@/lib/db/index.js");
  db = await (await import("@/lib/db/driver.js")).getAdapter();
  db.run(`DELETE FROM auditEvents`);
});

const evt = (over = {}) => ({ action: "auth.login", result: "success", ...over });

async function seed() {
  await repo.auditRepo.insert(
    evt({
      action: "auth.login",
      actorUserId: "u1",
      workspaceId: "ws1",
      targetType: "user",
      targetId: "u1",
      ts: "2026-01-01T00:00:00.000Z",
    }),
  );
  await repo.auditRepo.insert(
    evt({
      action: "auth.loginFailed",
      actorUserId: "u1",
      workspaceId: "ws1",
      result: "failure",
      ts: "2026-01-02T00:00:00.000Z",
    }),
  );
  await repo.auditRepo.insert(
    evt({
      action: "key.create",
      actorUserId: "u2",
      workspaceId: "ws2",
      targetType: "apiKey",
      targetId: "k1",
      ts: "2026-01-03T00:00:00.000Z",
    }),
  );
  await repo.auditRepo.insert(
    evt({
      action: "membership.add",
      actorUserId: "u2",
      workspaceId: "ws1",
      targetType: "membership",
      targetId: "ws1:u2",
      ts: "2026-01-04T00:00:00.000Z",
    }),
  );
}

describe("auditRepo.insert", () => {
  it("roundtrips the full row with auto ts", async () => {
    const before = new Date().toISOString();
    const row = await repo.auditRepo.insert(
      evt({
        actorUserId: "u1",
        actorApiKeyId: "k9",
        via: "session",
        ip: "127.0.0.1",
        workspaceId: "ws1",
        targetType: "user",
        targetId: "u1",
        before: '{"role":"user"}',
        after: '{"role":"admin"}',
      }),
    );
    expect(row.id).toBeTruthy();
    expect(row.ts >= before).toBe(true);
    expect(db.get(`SELECT * FROM auditEvents WHERE id = ?`, [row.id])).toMatchObject({
      action: "auth.login",
      actorUserId: "u1",
      actorApiKeyId: "k9",
      via: "session",
      ip: "127.0.0.1",
      workspaceId: "ws1",
      targetType: "user",
      targetId: "u1",
      before: '{"role":"user"}',
      after: '{"role":"admin"}',
      result: "success",
    });
  });

  it("nulls every optional column when absent", async () => {
    const row = await repo.auditRepo.insert({ action: "hostOps.shutdown" });
    expect(db.get(`SELECT * FROM auditEvents WHERE id = ?`, [row.id])).toMatchObject({
      actorUserId: null,
      actorApiKeyId: null,
      via: null,
      ip: null,
      workspaceId: null,
      targetType: null,
      targetId: null,
      before: null,
      after: null,
      result: null,
    });
  });

  it("rejects a NULL action", async () => {
    await expect(repo.auditRepo.insert({})).rejects.toThrow();
    await expect(repo.auditRepo.insert({ action: null })).rejects.toThrow();
    expect(db.get(`SELECT COUNT(*) AS c FROM auditEvents`).c).toBe(0);
  });
});

describe("auditRepo.list", () => {
  it("filters by workspaceId, actorUserId, targetType, targetId", async () => {
    await seed();
    expect((await repo.auditRepo.list({ workspaceId: "ws1" })).pagination.totalItems).toBe(3);
    expect((await repo.auditRepo.list({ workspaceId: "ws2" })).events.map((e) => e.action)).toEqual(
      ["key.create"],
    );
    expect((await repo.auditRepo.list({ actorUserId: "u2" })).pagination.totalItems).toBe(2);
    expect((await repo.auditRepo.list({ targetType: "membership" })).events).toHaveLength(1);
    expect(
      (await repo.auditRepo.list({ targetType: "apiKey", targetId: "k1" })).events,
    ).toHaveLength(1);
    expect((await repo.auditRepo.list({ targetId: "nope" })).events).toHaveLength(0);
  });

  it("matches action by prefix", async () => {
    await seed();
    const auth = await repo.auditRepo.list({ action: "auth." });
    expect(auth.events.map((e) => e.action).sort()).toEqual(["auth.login", "auth.loginFailed"]);
    // No dot needed: a bare prefix also matches the longer sibling.
    expect((await repo.auditRepo.list({ action: "auth.login" })).pagination.totalItems).toBe(2);
    expect((await repo.auditRepo.list({ action: "key." })).pagination.totalItems).toBe(1);
    expect((await repo.auditRepo.list({ action: "zzz." })).events).toHaveLength(0);
  });

  it("filters by inclusive ts range and orders ts DESC, id DESC", async () => {
    await seed();
    const r = await repo.auditRepo.list({
      fromTs: "2026-01-02T00:00:00.000Z",
      toTs: "2026-01-03T00:00:00.000Z",
    });
    expect(r.events.map((e) => e.action)).toEqual(["key.create", "auth.loginFailed"]);
    const all = await repo.auditRepo.list({});
    expect(all.events.map((e) => e.action)).toEqual([
      "membership.add",
      "key.create",
      "auth.loginFailed",
      "auth.login",
    ]);
  });

  it("paginates with correct math and clamps", async () => {
    await seed();
    const p1 = await repo.auditRepo.list({ page: 1, pageSize: 2 });
    expect(p1.pagination).toMatchObject({ page: 1, pageSize: 2, totalItems: 4, totalPages: 2 });
    expect(p1.events).toHaveLength(2);
    const p2 = await repo.auditRepo.list({ page: 2, pageSize: 2 });
    expect(p2.events).toHaveLength(2);
    expect(p2.events.map((e) => e.id)).not.toEqual(p1.events.map((e) => e.id));
    expect((await repo.auditRepo.list({ page: 3, pageSize: 2 })).events).toHaveLength(0);
    // Clamps: page floors at 1, pageSize caps at 100.
    expect((await repo.auditRepo.list({ page: 0, pageSize: 9999 })).pagination).toMatchObject({
      page: 1,
      pageSize: 100,
    });
  });
});

describe("auditRepo.pruneOlderThan", () => {
  it("deletes only rows older than the cutoff", async () => {
    const old = new Date(Date.now() - 400 * 86400000).toISOString();
    await repo.auditRepo.insert(evt({ action: "auth.login", ts: old }));
    await repo.auditRepo.insert(evt({ action: "key.create" }));
    expect(await repo.auditRepo.pruneOlderThan(365)).toBe(1);
    expect(db.all(`SELECT action FROM auditEvents`).map((r) => r.action)).toEqual(["key.create"]);
    expect(await repo.auditRepo.pruneOlderThan(365)).toBe(0);
  });
});

describe("migration 010 audit-events", () => {
  it("reruns cleanly on an already-migrated DB", async () => {
    const m010 = (await import("@/lib/db/migrations/010-audit-events.js")).default;
    expect(m010.version).toBe(10);
    m010.up(db);
    m010.up(db);
    expect(db.get(`SELECT COUNT(*) AS c FROM auditEvents`).c).toBe(0);
  });
});
