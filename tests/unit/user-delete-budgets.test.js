// YAN-1982: deleting a user cascades their hashed API keys, memberships,
// grants and personal workspace. budgets.scopeId has no FK, so the budgets on
// those targets (and the user's own user budget) must go in the same
// transaction, one `budget.delete` audit row each (reason `user_deleted`).
import { beforeEach, describe, expect, it } from "vitest";
import { hashedKeysDdl } from "../helpers/budgetLeafFixture.js";

const NOW = "2026-11-01T00:00:00.000Z";

let db;
let repo;
let budgets;
let t;

function budget(id, workspaceId, scopeType, scopeId) {
  db.run(
    `INSERT INTO budgets(id, workspaceId, scopeType, scopeId, window, limitUsd, createdAt)
     VALUES(?, ?, ?, ?, 'day', 1, ?)`,
    [id, workspaceId, scopeType, scopeId, NOW],
  );
}

function key(id, workspaceId, userId) {
  db.run(
    `INSERT INTO apiKeys(id, workspaceId, userId, createdByUserId, keyHash, hashKid, prefix, name, createdAt)
     VALUES(?, ?, ?, ?, ?, '0123456789abcdef', 'th_x', ?, ?)`,
    [id, workspaceId, userId, userId, `hash-${id}`, id, NOW],
  );
}

function connection(id, workspaceId) {
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, priority, isActive, data, workspaceId, createdAt, updatedAt)
     VALUES(?, 'openai', 'apikey', ?, 1, 1, '{}', ?, ?, ?)`,
    [id, id, workspaceId, NOW, NOW],
  );
}

function grant(id, connectionId, { userId = null, workspaceId = null } = {}) {
  db.run(
    `INSERT INTO connectionGrants(id, connectionId, workspaceId, userId, createdAt) VALUES(?, ?, ?, ?, 1)`,
    [id, connectionId, workspaceId, userId],
  );
}

const budgetIds = () =>
  db
    .all(`SELECT id FROM budgets`)
    .map((r) => r.id)
    .sort();

const deleteAudits = () =>
  db.all(`SELECT * FROM auditEvents WHERE action = 'budget.delete' ORDER BY targetId`).map((r) => ({
    id: r.targetId,
    actor: r.actorUserId,
    via: r.via,
    ip: r.ip,
    reason: JSON.parse(r.after).reason,
  }));

const actorOf = (userId) => ({ principal: { userId, via: "session" }, ip: "127.0.0.1" });

async function setup({ hashed = true } = {}) {
  repo = await import("@/lib/db/index.js");
  budgets = await import("@/lib/users/budgets.js");
  db = await (await import("@/lib/db/driver.js")).getAdapter();
  db.exec(
    "DELETE FROM budgets; DELETE FROM connectionGrants; DELETE FROM providerConnections; DELETE FROM auditEvents",
  );
  if (hashed) {
    db.exec("DROP TABLE apiKeys");
    db.exec(hashedKeysDdl);
  }
  const { seedTenancy } = await import("../setup/tenancyHarness.js");
  t = await seedTenancy();
}

describe("deleteUserUnscoped budget cleanup (YAN-1982)", () => {
  beforeEach(() => setup());

  it("removes the budgets on everything that cascades with the user, audited", async () => {
    const a = t.a.user.id;
    const b = t.b.user.id;
    connection("conn", t.shared.id);
    connection("conn-b", t.b.personal);
    key("kb", t.shared.id, b);
    key("kb-personal", t.b.personal, b);
    key("ka", t.shared.id, a);
    grant("gb", "conn", { userId: b });
    grant("ga", "conn", { userId: a });
    // B's personal connection shared out: its grants cascade with B's workspace.
    grant("g-out-user", "conn-b", { userId: a });
    grant("g-out-ws", "conn-b", { workspaceId: t.shared.id });

    budget("b-key", t.shared.id, "key", "kb");
    budget("b-key-personal", t.b.personal, "key", "kb-personal");
    budget("b-user", null, "user", b);
    budget("b-member", t.shared.id, "membership", `${t.shared.id}:${b}`);
    budget("b-grant", t.shared.id, "grant", "gb");
    budget("b-personal-ws", t.b.personal, "workspace", t.b.personal);
    budget("b-out-user", t.b.personal, "grant", "g-out-user");
    budget("b-out-ws", t.b.personal, "grant", "g-out-ws");
    // Someone else's: kept.
    budget("k-key", t.shared.id, "key", "ka");
    budget("k-user", null, "user", a);
    budget("k-member", t.shared.id, "membership", `${t.shared.id}:${a}`);
    budget("k-grant", t.shared.id, "grant", "ga");
    budget("k-ws", t.shared.id, "workspace", t.shared.id);

    const gen = budgets.budgetsGeneration();
    expect(await repo.deleteUserUnscoped(b, { actorUserId: a, actor: actorOf(a) })).toBe(true);

    expect(budgetIds()).toEqual(["k-grant", "k-key", "k-member", "k-user", "k-ws"]);
    expect(deleteAudits()).toEqual(
      [
        "b-grant",
        "b-key",
        "b-key-personal",
        "b-member",
        "b-out-user",
        "b-out-ws",
        "b-personal-ws",
        "b-user",
      ].map((id) => ({ id, actor: a, via: "session", ip: "127.0.0.1", reason: "user_deleted" })),
    );
    // The gateway's budget cache sees the removal without a restart.
    expect(budgets.budgetsGeneration()).not.toBe(gen);
    // Nothing left that points at a target that no longer exists.
    const { pruneOrphanedScopeBudgetsUnscoped } = await import(
      "@/lib/db/repos/budgetOrphansRepo.js"
    );
    expect(db.transaction(() => pruneOrphanedScopeBudgetsUnscoped(db))).toBe(0);
  });

  it("no budgets to remove: no audit rows and no cache bump", async () => {
    budget("k-ws", t.shared.id, "workspace", t.shared.id);
    const gen = budgets.budgetsGeneration();
    expect(await repo.deleteUserUnscoped(t.b.user.id)).toBe(true);
    expect(budgetIds()).toEqual(["k-ws"]);
    expect(deleteAudits()).toEqual([]);
    expect(budgets.budgetsGeneration()).toBe(gen);
  });

  it("a refused delete leaves every budget in place", async () => {
    const b = t.b.user.id;
    key("kb", t.shared.id, b);
    budget("b-key", t.shared.id, "key", "kb");
    budget("b-user", null, "user", b);
    // b alone manages the shared workspace: LAST_MANAGER refuses the delete.
    db.run(`UPDATE memberships SET role = 'member' WHERE userId = ?`, [t.a.user.id]);
    db.run(`UPDATE memberships SET role = 'manager' WHERE userId = ? AND workspaceId = ?`, [
      b,
      t.shared.id,
    ]);
    await expect(repo.deleteUserUnscoped(b)).rejects.toMatchObject({ code: "LAST_MANAGER" });
    expect(budgetIds()).toEqual(["b-key", "b-user"]);
    expect(deleteAudits()).toEqual([]);
  });
});

describe("deleteUserUnscoped budget cleanup on legacy key storage (YAN-1982)", () => {
  beforeEach(async () => {
    await setup({ hashed: false });
    db.exec("DROP TABLE apiKeys");
    db.exec(
      "CREATE TABLE apiKeys (id TEXT PRIMARY KEY, key TEXT, name TEXT, machineId TEXT, isActive INTEGER, createdAt TEXT)",
    );
  });

  it("legacy keys have no owner: their budgets stay, the user's own go", async () => {
    const b = t.b.user.id;
    db.run(
      `INSERT INTO apiKeys(id, key, name, isActive, createdAt) VALUES('lk', 'sk-x', 'k', 1, ?)`,
      [NOW],
    );
    budget("k-legacy-key", t.shared.id, "key", "lk");
    budget("b-user", null, "user", b);
    expect(await repo.deleteUserUnscoped(b)).toBe(true);
    expect(budgetIds()).toEqual(["k-legacy-key"]);
    expect(deleteAudits().map((r) => [r.id, r.via, r.reason])).toEqual([
      ["b-user", "system", "user_deleted"],
    ]);
  });
});
