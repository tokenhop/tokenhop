// deleteUserUnscoped drops the personal workspace's `ws:<id>/` kv rows and
// nothing else: no FK covers kv, so the tx must delete them by exact prefix.
import { beforeEach, describe, expect, it } from "vitest";

describe("deleteUserUnscoped kv cleanup", () => {
  let db;
  let repo;

  beforeEach(async () => {
    repo = await import("@/lib/db/index.js");
    db = await (await import("@/lib/db/driver.js")).getAdapter();
    for (const t of ["memberships", "identities", "workspaces", "users"])
      db.run(`DELETE FROM ${t}`);
    db.run(`DELETE FROM kv`);
  });

  it("deletes personal-prefixed kv rows, keeps other workspaces' keys", async () => {
    const a = await repo.createUserUnscoped({ instanceRole: "owner" });
    const b = await repo.createUserUnscoped({ instanceRole: "user" });
    const ws = await repo.createSharedWorkspace(
      { userId: a.id, instanceRole: a.instanceRole, workspaceIds: [], activeWorkspaceId: null },
      { name: "Team" },
    );

    db.run(`INSERT INTO kv (scope, key, value) VALUES (?, ?, ?)`, [
      "global",
      `ws:${b.personalWorkspaceId}/modelAliases`,
      "gone",
    ]);
    db.run(`INSERT INTO kv (scope, key, value) VALUES (?, ?, ?)`, [
      "global",
      `ws:${b.personalWorkspaceId}extra/decoy`,
      "kept",
    ]);
    db.run(`INSERT INTO kv (scope, key, value) VALUES (?, ?, ?)`, [
      "global",
      `ws:${ws.id}/disabledModels`,
      "kept",
    ]);
    db.run(`INSERT INTO kv (scope, key, value) VALUES (?, ?, ?)`, [
      "global",
      "unscopedKey",
      "kept",
    ]);

    expect(await repo.deleteUserUnscoped(b.id)).toBe(true);

    expect(
      db
        .all(`SELECT key FROM kv`)
        .map((r) => r.key)
        .sort(),
    ).toEqual(
      [
        "unscopedKey",
        `ws:${b.personalWorkspaceId}extra/decoy`,
        `ws:${ws.id}/disabledModels`,
      ].sort(),
    );
  });
});
