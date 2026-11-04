// YAN-1829: turning users & teams on after switch-off budgets exist. The
// owner bootstrap promotes the pending Default into the one Default workspace
// (budgets kept, user-less usage given to the owner on first adoption), and
// key budgets on legacy apiKeys.id still resolve and enforce after the keys
// are hashed.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const NOW = "2026-01-01T00:00:00.000Z";
const RAW = "sk-promote-key-0123456789abcdef0123";

let adapter;
let db;
let ownership;

async function load(state) {
  vi.resetModules();
  process.env[ENV] = state;
  globalThis.__tokenhopOwnerBootstrap = { done: false, failedAt: 0, running: null };
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  db = await import("@/lib/db/index.js");
  ownership = await import("@/lib/db/repos/ownership.js");
}

beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("owner bootstrap with a pending Default", () => {
  it("promotes it: one Default, budgets kept, usage adopted, key budgets survive hashing", async () => {
    await load("off");
    for (const t of ["budgets", "usageHistory", "usageRollup", "apiKeys", "combos", "workspaces"])
      adapter.run(`DELETE FROM ${t}`);
    for (const t of ["memberships", "identities", "users"]) adapter.run(`DELETE FROM ${t}`);
    adapter.run(
      `DELETE FROM _meta WHERE key IN ('defaultWorkspaceId', 'pendingDefaultWorkspaceId', 'usageAdoptedAt')`,
    );
    adapter.run(
      `INSERT INTO apiKeys(id, key, name, isActive, createdAt) VALUES('legacy-key', ?, 'k', 1, ?)`,
      [RAW, NOW],
    );
    adapter.run(
      `INSERT INTO combos(id, name, models, createdAt, updatedAt) VALUES('c1', 'combo', '[]', ?, ?)`,
      [NOW, NOW],
    );

    // Switch off: the first budget creates the pending Default.
    const pending = adapter.transaction(() =>
      ownership.ensurePendingDefaultWorkspaceUnscoped(adapter),
    );
    for (const [id, scopeType, scopeId] of [
      ["bw", "workspace", pending],
      ["bk", "key", "legacy-key"],
    ])
      adapter.run(
        `INSERT INTO budgets(id, workspaceId, scopeType, scopeId, window, limitRequests, createdAt) VALUES(?, ?, ?, ?, 'day', 1, ?)`,
        [id, pending, scopeType, scopeId, NOW],
      );
    const { saveRequestUsageUnscoped } = await import("@/lib/usageDb.js");
    await saveRequestUsageUnscoped({
      provider: "openai",
      model: "gpt-x",
      apiKey: RAW,
      cost: 1,
      status: "success",
    });
    expect(adapter.get(`SELECT workspaceId, userId FROM usageHistory`)).toEqual({
      workspaceId: pending,
      userId: null,
    });
    const before = adapter.all(`SELECT * FROM budgets ORDER BY id`);

    // Switch on: bootstrap promotes the pending row.
    await load("on");
    const { bootstrapOwnerUnscoped } = await import("@/lib/db/repos/usersRepo.js");
    const owner = await bootstrapOwnerUnscoped();
    expect(owner.defaultWorkspaceId).toBe(pending);
    expect(await db.getMeta("defaultWorkspaceId")).toBe(pending);
    expect(await db.getMeta("pendingDefaultWorkspaceId")).toBeNull();
    expect(adapter.all(`SELECT id, createdBy FROM workspaces WHERE kind = 'shared'`)).toEqual([
      { id: pending, createdBy: owner.id },
    ]);
    expect(
      adapter.get(`SELECT role FROM memberships WHERE workspaceId = ? AND userId = ?`, [
        pending,
        owner.id,
      ]).role,
    ).toBe("owner");
    expect(adapter.all(`SELECT * FROM budgets ORDER BY id`)).toEqual(before);
    expect(adapter.get(`SELECT workspaceId, userId FROM usageHistory`)).toEqual({
      workspaceId: pending,
      userId: owner.id,
    });
    expect(
      adapter.all(`SELECT DISTINCT workspaceId, userId FROM usageRollup`).map((r) => ({ ...r })),
    ).toEqual([{ workspaceId: pending, userId: owner.id }]);
    expect(adapter.get(`SELECT workspaceId FROM combos WHERE id = 'c1'`).workspaceId).toBe(pending);
    // The startup invariants hold for the promoted row.
    const { ensureOwnerBootstrap } = await import("@/lib/users/bootstrap.js");
    await expect(ensureOwnerBootstrap({ throwOnError: true })).resolves.toMatchObject({
      enabled: true,
      ownerId: owner.id,
      defaultWorkspaceId: pending,
    });

    // Key hashing keeps apiKeys.id: the key budget still resolves and enforces.
    const masterKey = Buffer.alloc(32, 11);
    try {
      const { hashGatewayKeysSync } = await import("@/lib/db/migrations/hashGatewayKeys.js");
      hashGatewayKeysSync(adapter, {
        masterKey,
        defaultWorkspaceId: pending,
        backup: { completed: true, db: adapter },
      });
      process.env.TOKENHOP_MASTER_KEY = masterKey.toString("base64");
      expect(adapter.get(`SELECT workspaceId FROM apiKeys WHERE id = 'legacy-key'`)).toEqual({
        workspaceId: pending,
      });
      const { resolveApiKey } = await import("@/lib/auth/apiKeyPrincipal.js");
      const principal = await resolveApiKey(RAW);
      expect(principal).toMatchObject({ apiKeyId: "legacy-key", workspaceId: pending });

      const guard = await import("@/sse/services/budgetGuard.js");
      (await import("@/lib/users/budgets.js")).bumpBudgetsGeneration();
      adapter.run(`DELETE FROM budgets WHERE id = 'bw'`);
      const res = await guard.budgeted(
        principal,
        { nonToken: true },
        async () => new Response("ok"),
      );
      expect(res.status).toBe(429);
      expect((await res.json()).error).toMatchObject({ code: "budget_exceeded", level: "key" });

      // The repo still finds the key scope on the promoted Default.
      const { updateBudget } = await import("@/lib/db/repos/budgetsRepo.js");
      const ctx = { userId: owner.id, instanceRole: "owner", via: "session" };
      await expect(
        updateBudget(ctx, { workspaceId: pending, budgetId: "bk" }, { limitRequests: 5 }),
      ).resolves.toMatchObject({ scopeId: "legacy-key", limitRequests: 5 });
    } finally {
      delete process.env.TOKENHOP_MASTER_KEY;
      const { TABLES, buildCreateTableSql } = await import("@/lib/db/schema.js");
      adapter.exec(`DROP TABLE apiKeys`);
      adapter.exec(buildCreateTableSql("apiKeys", TABLES.apiKeys));
      adapter.run(`DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion', 'apiKeysHashKid')`);
    }
  });

  it("no pending row: bootstrap creates Default as before", async () => {
    await load("on");
    for (const t of ["budgets", "memberships", "identities", "workspaces", "users"])
      adapter.run(`DELETE FROM ${t}`);
    adapter.run(
      `DELETE FROM _meta WHERE key IN ('defaultWorkspaceId', 'pendingDefaultWorkspaceId')`,
    );
    const { bootstrapOwnerUnscoped } = await import("@/lib/db/repos/usersRepo.js");
    const owner = await bootstrapOwnerUnscoped();
    expect(adapter.all(`SELECT id FROM workspaces WHERE kind = 'shared'`)).toEqual([
      { id: owner.defaultWorkspaceId },
    ]);
    expect(await db.getMeta("defaultWorkspaceId")).toBe(owner.defaultWorkspaceId);
  });
});
