import { beforeAll, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import * as dbApi from "@/lib/db/index.js";
import { INSTANCE_SNAPSHOT_SECTION_NAMES } from "@/lib/db/helpers/instanceSnapshotTables.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { apiKeyPrefix } from "@/shared/utils/apiKey.js";

let enabled = false;
vi.mock("@/lib/users/featureSwitch.js", () => ({ isMultiUserEnabled: vi.fn(async () => enabled) }));
vi.mock("@/lib/auth/apiKeyPrincipal.js", () => ({ clearApiKeyPrincipalCache: vi.fn() }));

const NOW = "2026-10-09T00:00:00.000Z";
const MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));
const KID = masterKeyId(MASTER);
const RAW = "th_SWITCHTESTGATEWAYKEYxxxxxxxxxxxxx";
let db;

const tableDump = () =>
  JSON.stringify(
    Object.fromEntries(
      ["workspaceSettings", "userPreferences", "budgets", "auditEvents", "invitations", "kv"].map(
        (table) => [table, db.all(`SELECT * FROM ${table} ORDER BY rowid`)],
      ),
    ),
  );

beforeAll(async () => {
  db = await getAdapter();
  db.exec("DROP TABLE IF EXISTS apiKeys");
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    userId TEXT REFERENCES users(id) ON DELETE CASCADE,
    createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
    keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
    machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
    revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
    expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
  db.run(
    `INSERT INTO users(id, email, username, displayName, instanceRole, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt)
     VALUES('owner', 'owner@x.test', 'owner', 'Owner', 'owner', 'active', 'hash', 0, 1, ?, ?)`,
    [NOW, NOW],
  );
  db.run(
    "INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES('ws', 'Default', 'shared', 'owner', ?, ?)",
    [NOW, NOW],
  );
  db.run(
    "INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES('ws', 'owner', 'owner', 'manual', ?)",
    [NOW],
  );
  db.run(
    `INSERT INTO apiKeys(id, workspaceId, userId, createdByUserId, keyHash, hashKid, prefix, name, legacy, isActive, allowedModels, createdAt)
     VALUES('key', 'ws', 'owner', 'owner', ?, ?, ?, 'Key', 0, 1, '[]', ?)`,
    [hashApiKey(RAW, deriveApiKeyHashKey(MASTER)), KID, apiKeyPrefix(RAW), NOW],
  );
  db.run(
    "INSERT INTO _meta(key, value) VALUES('apiKeysHashedVersion', '1'), ('apiKeysHashKid', ?), ('defaultWorkspaceId', 'ws')",
    [KID],
  );
  const { activateCredentialEncryption } = await import("@/lib/db/activateCredentialEncryption.js");
  await activateCredentialEncryption(db, {
    enabled: true,
    beforeServing: true,
    root: { kid: KID, key: MASTER },
  });
  db.run(
    "INSERT INTO workspaceSettings(workspaceId, data, updatedAt) VALUES('ws', '{\"rtkEnabled\":true}', ?)",
    [NOW],
  );
});

// Switch-off budgets on Default: a workspace and a key budget, plus a live
// notice claim on the workspace budget.
function seedOffBudgets() {
  db.run("DELETE FROM budgets");
  db.run(
    `INSERT INTO budgets(id, workspaceId, scopeType, scopeId, window, limitUsd, limitTokens, limitRequests, softLimitPct, resetAt, createdByUserId, createdAt)
     VALUES('b-ws', 'ws', 'workspace', 'ws', 'day', 10, NULL, NULL, 50, NULL, 'owner', ?),
           ('b-key', 'ws', 'key', 'key', 'week', NULL, NULL, 3, NULL, NULL, NULL, ?)`,
    [NOW, NOW],
  );
  db.run(
    `INSERT INTO budgetNotices(budgetId, kind, windowStart, signature, notifiedAt) VALUES('b-ws', 'soft', ?, '10|||50', ?)`,
    [NOW, NOW],
  );
}
const budgetRows = () =>
  db.all(
    "SELECT id, workspaceId, scopeType, scopeId, window, limitUsd, limitTokens, limitRequests, softLimitPct, createdByUserId FROM budgets ORDER BY id",
  );
const claimRows = () => db.all("SELECT * FROM budgetNotices ORDER BY budgetId, kind");

describe("instance transfer switch gating", () => {
  it("keeps encrypted export and import on the previous behavior while switched off", async () => {
    enabled = false;
    seedOffBudgets();
    const snapshot = await dbApi.exportDb();
    expect(snapshot.formatVersion).toBe(3);
    for (const name of ["kv", "metadataCounters", ...INSTANCE_SNAPSHOT_SECTION_NAMES]) {
      expect(snapshot).not.toHaveProperty(name);
    }
    expect(snapshot).not.toHaveProperty("budgetNotices");
    await dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER });
    // Prior hashed restore replaces users/workspaces; existing FK cascades
    // remove their settings. OFF must not run the new retention/restore lane.
    expect(db.all("SELECT * FROM workspaceSettings")).toEqual([]);
    await expect(dbApi.exportDb({ passphrase: "test" })).rejects.toMatchObject({
      code: "TRANSFER_PORTABLE_UNSUPPORTED",
    });
  });

  // YAN-1934 / YAN-1929: budgets are the exception to the cascade above.
  it("carries switch-off workspace and key budgets through an export and restore", async () => {
    enabled = false;
    seedOffBudgets();
    const claims = claimRows();
    const snapshot = await dbApi.exportDb();
    // Limits only: no spend, carry, notices, creator or derived resetAt.
    expect(snapshot.offBudgets).toEqual([
      {
        id: "b-ws",
        workspaceId: "ws",
        scopeType: "workspace",
        scopeId: "ws",
        window: "day",
        limitUsd: 10,
        limitTokens: null,
        limitRequests: null,
        softLimitPct: 50,
        createdAt: NOW,
      },
      {
        id: "b-key",
        workspaceId: "ws",
        scopeType: "key",
        scopeId: "key",
        window: "week",
        limitUsd: null,
        limitTokens: null,
        limitRequests: 3,
        softLimitPct: null,
        createdAt: NOW,
      },
    ]);
    db.run("UPDATE budgets SET limitUsd = 99 WHERE id = 'b-ws'");
    await dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER });
    expect(budgetRows()).toEqual([
      {
        id: "b-key",
        workspaceId: "ws",
        scopeType: "key",
        scopeId: "key",
        window: "week",
        limitUsd: null,
        limitTokens: null,
        limitRequests: 3,
        softLimitPct: null,
        createdByUserId: null,
      },
      {
        id: "b-ws",
        workspaceId: "ws",
        scopeType: "workspace",
        scopeId: "ws",
        window: "day",
        limitUsd: 10,
        limitTokens: null,
        limitRequests: null,
        softLimitPct: 50,
        createdByUserId: null,
      },
    ]);
    // The live claim of the kept budget id survives the cascade.
    expect(claimRows()).toEqual(claims);
  });

  it("an older switch-off snapshot without offBudgets keeps the previous cascade", async () => {
    enabled = false;
    seedOffBudgets();
    const snapshot = await dbApi.exportDb();
    delete snapshot.offBudgets;
    await dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER });
    expect(budgetRows()).toEqual([]);
    expect(claimRows()).toEqual([]);
  });

  it("an explicit empty offBudgets clears the switch-off budgets, audited", async () => {
    enabled = false;
    seedOffBudgets();
    db.run("DELETE FROM auditEvents WHERE action = 'budget.delete'");
    const snapshot = await dbApi.exportDb();
    snapshot.offBudgets = [];
    await dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER });
    expect(budgetRows()).toEqual([]);
    // The workspace cascade removed them; each removal is still audited once.
    expect(
      db
        .all(
          "SELECT targetId, after FROM auditEvents WHERE action = 'budget.delete' ORDER BY targetId",
        )
        .map((r) => ({ id: r.targetId, after: JSON.parse(r.after) })),
    ).toEqual([
      { id: "b-key", after: { reason: "not_in_backup", scopeType: "key" } },
      { id: "b-ws", after: { reason: "not_in_backup", scopeType: "workspace" } },
    ]);
  });

  // YAN-1929: a kept id the backup moved to another window or scope starts
  // clean; its old claim does not come back.
  it("drops the claim of a kept id whose window or scope changed", async () => {
    enabled = false;
    seedOffBudgets();
    db.run(
      `INSERT INTO budgetNotices(budgetId, kind, windowStart, signature, notifiedAt) VALUES('b-key', 'hard', ?, '||3', ?)`,
      [NOW, NOW],
    );
    const snapshot = await dbApi.exportDb();
    for (const b of snapshot.offBudgets) {
      if (b.id === "b-ws") b.window = "month";
      if (b.id === "b-key")
        Object.assign(b, { scopeType: "workspace", scopeId: "ws", window: "week" });
    }
    await dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER });
    expect(budgetRows().map((r) => [r.id, r.scopeType, r.window])).toEqual([
      ["b-key", "workspace", "week"],
      ["b-ws", "workspace", "month"],
    ]);
    expect(claimRows()).toEqual([]);
  });

  // YAN-1934: a live row holding a restored row's slot under another id is
  // replaced (audited), never an idx_budgets_scope_window failure.
  it("replaces a live budget that holds a restored budget's slot under another id", async () => {
    enabled = false;
    seedOffBudgets();
    const snapshot = await dbApi.exportDb();
    db.run("DELETE FROM budgets WHERE id = 'b-ws'");
    db.run(
      `INSERT INTO budgets(id, workspaceId, scopeType, scopeId, window, limitUsd, createdAt) VALUES('b-squatter', 'ws', 'workspace', 'ws', 'day', 1, ?)`,
      [NOW],
    );
    db.run("DELETE FROM auditEvents WHERE action = 'budget.delete'");
    const { restoreOffBudgetsUnscoped } = await import("@/lib/db/repos/budgetOrphansRepo.js");
    db.transaction(() => restoreOffBudgetsUnscoped(db, snapshot.offBudgets));
    expect(budgetRows().map((r) => r.id)).toEqual(["b-key", "b-ws"]);
    expect(
      db.all("SELECT targetId, after FROM auditEvents WHERE action = 'budget.delete'"),
    ).toEqual([
      {
        targetId: "b-squatter",
        after: JSON.stringify({ reason: "not_in_backup", scopeType: "workspace" }),
      },
    ]);
  });

  it("rejects invalid offBudgets before any mutation", async () => {
    enabled = false;
    seedOffBudgets();
    const snapshot = await dbApi.exportDb();
    const [ws, key] = snapshot.offBudgets;
    const cases = [
      { ...ws, id: "b-grant", scopeType: "grant", scopeId: "g" },
      { ...key, id: "b-dup" }, // same key and window as b-key
      { ...ws, id: "b-neg", window: "month", limitUsd: -1 },
      { ...ws, id: "b-other", window: "month", workspaceId: "elsewhere", scopeId: "elsewhere" },
      { ...ws, id: "b-creator", window: "month", createdByUserId: "owner" },
      { ...ws, id: "b-extra", window: "month", spent: 1 },
    ];
    db.run("UPDATE budgets SET limitUsd = 42 WHERE id = 'b-ws'");
    const before = tableDump();
    const claims = claimRows();
    for (const bad of cases) {
      const doc = structuredClone(snapshot);
      doc.offBudgets.push(bad);
      await expect(dbApi.importDb(doc, { masterKey: MASTER })).rejects.toMatchObject({
        code: expect.stringMatching(/^TRANSFER_(STATE|REF)_INVALID$/),
      });
    }
    await expect(
      dbApi.importDb({ ...structuredClone(snapshot), offBudgets: {} }, { masterKey: MASTER }),
    ).rejects.toMatchObject({ code: "TRANSFER_STATE_INVALID" });
    expect(tableDump()).toBe(before);
    expect(claimRows()).toEqual(claims);
  });

  it("a switch-off snapshot restored with the switch on applies its offBudgets", async () => {
    enabled = false;
    seedOffBudgets();
    const snapshot = await dbApi.exportDb();
    db.run("DELETE FROM budgets");
    enabled = true;
    try {
      await dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER });
    } finally {
      enabled = false;
    }
    expect(budgetRows().map((r) => r.id)).toEqual(["b-key", "b-ws"]);
    // With a budgets section (switch-on snapshot) the section wins.
    enabled = true;
    try {
      const full = await dbApi.exportDb();
      full.budgets = [];
      full.offBudgets = snapshot.offBudgets;
      await dbApi.importDb(full, { masterKey: MASTER });
    } finally {
      enabled = false;
    }
    expect(budgetRows()).toEqual([]);
  });
  it("rejects new sections while switched off", async () => {
    enabled = true;
    const snapshot = await dbApi.exportDb();
    enabled = false;
    const before = tableDump();
    await expect(dbApi.importDb(snapshot, { masterKey: MASTER })).rejects.toMatchObject({
      code: "TRANSFER_FORMAT_INVALID",
    });
    expect(tableDump()).toBe(before);
  });
});
