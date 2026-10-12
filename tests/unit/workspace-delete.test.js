// YAN-373: getWorkspaceDetailUnscoped + deleteWorkspaceGuardedUnscoped. Real isolated
// DB per file. Shared workspaces only, counts without secrets, Default and
// personal protection, live actor role/sv re-read inside the transaction,
// exact `ws:<id>/` kv prefix cleanup, outgoing-grant budget cleanup (even in
// other workspaces), SSO group-map rewrite, usage/audit retention, and the
// same-transaction workspace.delete audit row (fixed strings/counts only).
import { beforeEach, describe, expect, it } from "vitest";
import { seedTenancy } from "../setup/tenancyHarness.js";

const NOW = new Date().toISOString();
let repo;
let a;
let t;

beforeEach(async () => {
  repo = await import("@/lib/db/repos/workspacesRepo.js");
  a = await (await import("@/lib/db/driver.js")).getAdapter();
  a.exec(`PRAGMA foreign_keys = ON`);
  for (const table of [
    "providerConnections",
    "providerNodes",
    "combos",
    "connectionGrants",
    "invitations",
    "budgets",
    "workspaceKeys",
    "workspaceSettings",
    "auditEvents",
    "usageHistory",
  ]) {
    a.run(`DELETE FROM ${table}`);
  }
  a.run(`DELETE FROM kv`);
  a.run(`DELETE FROM settings`);
  a.run(
    `DELETE FROM _meta WHERE key IN ('defaultWorkspaceId','apiKeysHashedVersion','apiKeysHashKid')`,
  );
  t = await seedTenancy();
});

const grantable = () => a.get(`SELECT id FROM workspaces WHERE id = ?`, [t.shared.id]);

function seedSharedContent(wsId, otherBudgetWs) {
  a.run(
    `INSERT INTO providerConnections(id, provider, authType, name, priority, isActive, data, workspaceId, createdAt, updatedAt)
     VALUES(?, 'openai', 'api_key', 'c', 1, 1, '{}', ?, ?, ?)`,
    [`conn-${wsId}`, wsId, NOW, NOW],
  );
  const connId = `conn-${wsId}`;
  a.run(
    `INSERT INTO providerNodes(id, type, name, data, workspaceId, createdAt, updatedAt)
     VALUES(?, 'openai', 'n', '{}', ?, ?, ?)`,
    [`node-${wsId}`, wsId, NOW, NOW],
  );
  a.run(
    `INSERT INTO combos(id, name, kind, models, workspaceId, createdAt, updatedAt)
     VALUES(?, 'combo', NULL, '[]', ?, ?, ?)`,
    [`combo-${wsId}`, wsId, NOW, NOW],
  );
  a.run(
    `INSERT INTO connectionGrants(id, connectionId, workspaceId, userId, createdAt)
     VALUES(?, ?, NULL, ?, 1)`,
    [`grant-${wsId}`, connId, t.b.user.id],
  );
  a.run(
    `INSERT INTO budgets(id, workspaceId, scopeType, scopeId, window, limitUsd, createdAt)
     VALUES(?, ?, 'workspace', ?, 'day', 1, ?)`,
    [`budget-ws-${wsId}`, wsId, wsId, NOW],
  );
  // Budget scoped to this workspace's outgoing grant, stored in ANOTHER
  // workspace. NULL workspaceId is possible on the grant row itself (global
  // grant), but budget rows carry a workspaceId here by FK; use a different
  // window for a second outgoing-grant budget to avoid the unique
  // (scopeType, scopeId, window) index.
  a.run(
    `INSERT INTO budgets(id, workspaceId, scopeType, scopeId, window, limitUsd, createdAt)
     VALUES(?, ?, 'grant', ?, 'day', 2, ?)`,
    [`budget-grant-${wsId}`, otherBudgetWs, `grant-${wsId}`, NOW],
  );
  a.run(
    `INSERT INTO budgets(id, workspaceId, scopeType, scopeId, window, limitUsd, createdAt)
     VALUES(?, ?, 'grant', ?, 'week', 4, ?)`,
    [`budget-grant-${wsId}-2`, otherBudgetWs, `grant-${wsId}`, NOW],
  );
  // An unrelated budget on the grant's grantee workspace: no relation to this
  // workspace's outgoing grants, must survive its deletion.
  a.run(
    `INSERT INTO budgets(id, workspaceId, scopeType, scopeId, window, limitUsd, createdAt)
     VALUES(?, ?, 'workspace', ?, 'month', 5, ?)`,
    [`budget-unrelated-${wsId}`, otherBudgetWs, otherBudgetWs, NOW],
  );
  a.run(
    `INSERT INTO invitations(id, workspaceId, role, tokenHash, createdAt, expiresAt)
     VALUES(?, ?, 'member', ?, ?, ?)`,
    [`inv-${wsId}`, wsId, `hash-${wsId}`, NOW, new Date(Date.now() + 60000).toISOString()],
  );
  for (const scope of ["modelAliases", "customModels", "disabledModels"]) {
    a.run(`INSERT INTO kv(scope, key, value) VALUES(?, ?, '1')`, [scope, `ws:${wsId}/one`]);
    a.run(`INSERT INTO kv(scope, key, value) VALUES(?, ?, '1')`, [scope, `ws:${wsId}/two`]);
    // Not a prefix of this workspace: must survive.
    a.run(`INSERT INTO kv(scope, key, value) VALUES(?, ?, '1')`, [scope, `ws:${wsId}x/near`]);
  }
  a.run(`INSERT OR IGNORE INTO kv(scope, key, value) VALUES('modelAliases', 'bare', '1')`);
}

const countsOf = (sql, params) => a.get(sql, params)?.c ?? 0;

describe("getWorkspaceDetailUnscoped", () => {
  it("returns counts for a shared workspace; legacy apiKeys flagged, never decrypted", async () => {
    seedSharedContent(t.shared.id, t.b.personal);
    const detail = await repo.getWorkspaceDetailUnscoped(t.shared.id);
    expect(detail.workspace).toMatchObject({
      id: t.shared.id,
      name: "Shared",
      kind: "shared",
      memberCount: 2,
      isDefault: false,
    });
    expect(detail.counts).toEqual({
      connections: 1,
      nodes: 1,
      combos: 1,
      apiKeys: null,
      apiKeysLegacy: true,
      invitations: 1,
      budgets: 1,
      grantBudgetsElsewhere: 2,
      grantsOut: 1,
    });
    expect(detail.encryption).toEqual({ dekWrapped: false });
    // No secret material anywhere in the payload.
    expect(JSON.stringify(detail)).not.toContain("accessToken");
  });

  it("grantBudgetsElsewhere never double-counts grant budgets stored in the workspace itself", async () => {
    // Every budget lives in the workspace: all counted by budgets, none elsewhere.
    seedSharedContent(t.shared.id, t.shared.id);
    const { counts } = await repo.getWorkspaceDetailUnscoped(t.shared.id);
    expect(counts.budgets).toBe(4); // workspace + 2 grant + unrelated(workspace-scope)
    expect(counts.grantBudgetsElsewhere).toBe(0);
  });

  it("flags the Default workspace and counts hashed keys", async () => {
    a.run(`INSERT INTO _meta(key, value) VALUES('defaultWorkspaceId', ?)`, [t.shared.id]);
    a.run(
      `INSERT INTO _meta(key, value) VALUES('apiKeysHashedVersion', '1'), ('apiKeysHashKid', '0123456789abcdef')`,
    );
    a.exec(`DROP TABLE apiKeys`);
    a.exec(`CREATE TABLE apiKeys (
      id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
      createdAt TEXT NOT NULL)`);
    a.run(
      `INSERT INTO apiKeys(id, workspaceId, keyHash, hashKid, prefix, name, createdAt)
       VALUES('k1', ?, 'h1', '0123456789abcdef', 'th_', 'runner', ?)`,
      [t.shared.id, NOW],
    );
    const detail = await repo.getWorkspaceDetailUnscoped(t.shared.id);
    expect(detail.workspace.isDefault).toBe(true);
    expect(detail.counts.apiKeys).toBe(1);
    expect(detail.counts.apiKeysLegacy).toBe(false);
  });

  it("personal and unknown workspaces both read as absent", async () => {
    expect(await repo.getWorkspaceDetailUnscoped(t.a.personal)).toBeNull();
    expect(await repo.getWorkspaceDetailUnscoped("missing")).toBeNull();
  });
});

describe("deleteWorkspaceGuardedUnscoped", () => {
  const proof = () => ({ actorId: t.a.user.id, sessionVersion: t.a.user.sessionVersion });

  it("deletes content atomically; keeps other workspaces, usage history and audit", async () => {
    seedSharedContent(t.shared.id, t.b.personal);
    const keep = await (await import("@/lib/db/index.js")).createSharedWorkspace(t.a.ctx, {
      name: "Keep",
    });
    seedSharedContent(keep.id, keep.id);
    a.run(
      `INSERT INTO usageHistory(timestamp, provider, model, workspaceId) VALUES(?, 'openai', 'm', ?)`,
      [NOW, t.shared.id],
    );
    a.run(`INSERT INTO settings(id, data) VALUES(1, ?)`, [
      JSON.stringify({
        ssoGroupWorkspaceMap: [
          { group: "eng", workspaceId: t.shared.id, role: "member" },
          { group: "ops", workspaceId: keep.id, role: "manager" },
        ],
      }),
    ]);

    const summary = await repo.deleteWorkspaceGuardedUnscoped(t.shared.id, proof());
    expect(summary).toEqual({ budgetsDeleted: 2, kvDeleted: 6, ssoMapEntriesRemoved: 1 });

    expect(grantable()).toBeUndefined();
    expect(
      countsOf(`SELECT COUNT(*) AS c FROM providerConnections WHERE workspaceId = ?`, [
        t.shared.id,
      ]),
    ).toBe(0);
    expect(
      countsOf(`SELECT COUNT(*) AS c FROM connectionGrants WHERE id = ?`, [`grant-${t.shared.id}`]),
    ).toBe(0);
    expect(
      countsOf(`SELECT COUNT(*) AS c FROM invitations WHERE workspaceId = ?`, [t.shared.id]),
    ).toBe(0);
    expect(
      countsOf(`SELECT COUNT(*) AS c FROM memberships WHERE workspaceId = ?`, [t.shared.id]),
    ).toBe(0);
    // Grant-scope budget lived in B's personal workspace: still removed atomically.
    expect(
      countsOf(`SELECT COUNT(*) AS c FROM budgets WHERE id = ?`, [`budget-grant-${t.shared.id}`]),
    ).toBe(0);
    expect(
      countsOf(`SELECT COUNT(*) AS c FROM budgets WHERE id = ?`, [`budget-grant-${t.shared.id}-2`]),
    ).toBe(0);
    // The unrelated budget in the same other workspace is untouched, as is the
    // workspace-scope budget of the deleted workspace's neighbour.
    expect(
      countsOf(`SELECT COUNT(*) AS c FROM budgets WHERE id = ?`, [
        `budget-unrelated-${t.shared.id}`,
      ]),
    ).toBe(1);
    // Exact-prefix kv cleanup: near-miss and bare keys survive.
    expect(
      countsOf(`SELECT COUNT(*) AS c FROM kv WHERE key = ?`, [`ws:${t.shared.id}x/near`]),
    ).toBe(3);
    expect(countsOf(`SELECT COUNT(*) AS c FROM kv WHERE key = 'bare'`)).toBe(1);
    // Other workspace untouched.
    expect(
      countsOf(`SELECT COUNT(*) AS c FROM providerConnections WHERE workspaceId = ?`, [keep.id]),
    ).toBe(1);
    expect(
      countsOf(`SELECT COUNT(*) AS c FROM budgets WHERE id = ?`, [`budget-grant-${keep.id}`]),
    ).toBe(1);
    expect(
      countsOf(`SELECT COUNT(*) AS c FROM kv WHERE substr(key, 1, ?) = ?`, [
        `ws:${keep.id}/`.length,
        `ws:${keep.id}/`,
      ]),
    ).toBe(6);
    // SSO map: only the deleted target removed, so later logins still validate.
    const blob = JSON.parse(a.get(`SELECT data FROM settings WHERE id = 1`).data);
    expect(blob.ssoGroupWorkspaceMap).toEqual([
      { group: "ops", workspaceId: keep.id, role: "manager" },
    ]);
    // Historical usage survives, attribution nulled by FK.
    expect(a.get(`SELECT workspaceId FROM usageHistory`)?.workspaceId).toBeNull();
    // Same-transaction audit: fixed shape, counts and id only, never a name.
    const audit = a.get(`SELECT * FROM auditEvents WHERE action = 'workspace.delete'`);
    expect(audit).toBeTruthy();
    expect(audit.actorUserId).toBe(t.a.user.id);
    expect(audit.targetId).toBe(t.shared.id);
    expect(audit.after).toContain('"count":9');
    expect(audit.after).not.toContain("Shared");
  });

  it("destroys the workspaceKeys row (DEK) with the workspace", async () => {
    a.run(
      `INSERT INTO workspaceKeys(workspaceId, kid, wrappedDek, createdAt) VALUES(?, 'k', '{}', ?)`,
      [t.shared.id, NOW],
    );
    await repo.deleteWorkspaceGuardedUnscoped(t.shared.id, proof());
    expect(
      countsOf(`SELECT COUNT(*) AS c FROM workspaceKeys WHERE workspaceId = ?`, [t.shared.id]),
    ).toBe(0);
  });

  it("protects the Default workspace with a 409-coded error, no state change", async () => {
    a.run(`INSERT INTO _meta(key, value) VALUES('defaultWorkspaceId', ?)`, [t.shared.id]);
    seedSharedContent(t.shared.id, t.b.personal);
    await expect(repo.deleteWorkspaceGuardedUnscoped(t.shared.id, proof())).rejects.toMatchObject({
      code: "DEFAULT_WORKSPACE_PROTECTED",
      status: 409,
    });
    expect(grantable()).toBeTruthy();
    expect(countsOf(`SELECT COUNT(*) AS c FROM providerConnections`, [])).toBe(1);
  });

  it("refuses personal and missing workspaces identically (404)", async () => {
    for (const id of [t.a.personal, "missing"]) {
      await expect(repo.deleteWorkspaceGuardedUnscoped(id, proof())).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }
  });

  it("re-reads the live actor inside the transaction: role, status and sv", async () => {
    // Missing actors never delete (verified for the MEDIUM fix that replaced
    // `!actor` with an optional-chain comparison).
    await expect(
      repo.deleteWorkspaceGuardedUnscoped(t.shared.id, { actorId: "missing", sessionVersion: 0 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(grantable()).toBeTruthy();
    // A plain user, even a member, never deletes.
    await expect(
      repo.deleteWorkspaceGuardedUnscoped(t.shared.id, {
        actorId: t.b.user.id,
        sessionVersion: t.b.user.sessionVersion,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Stale sv (role change / logout-all bump during the proof window).
    await expect(
      repo.deleteWorkspaceGuardedUnscoped(t.shared.id, {
        actorId: t.a.user.id,
        sessionVersion: t.a.user.sessionVersion + 1,
      }),
    ).rejects.toMatchObject({ code: "STALE" });
    // Missing sv binding fails closed.
    await expect(
      repo.deleteWorkspaceGuardedUnscoped(t.shared.id, { actorId: t.a.user.id }),
    ).rejects.toMatchObject({ code: "STALE" });
    // Disabled owner loses the right immediately.
    a.run(`UPDATE users SET status = 'disabled' WHERE id = ?`, [t.a.user.id]);
    await expect(repo.deleteWorkspaceGuardedUnscoped(t.shared.id, proof())).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(grantable()).toBeTruthy();
  });
});
