// YAN-367: management-event emissions — key create/update/revoke (hashed
// management service), connection create/delete, settings.update +
// user.passwordChange (PATCH /api/settings), db.export/import.
// Fixture mirrors tests/unit/gateway-key-management.test.js (real adapter,
// isolated temp DATA_DIR, direct hashed-store fixture).
import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import { createApiKey, revokeApiKey, updateApiKey } from "@/lib/users/apiKeyManagement.js";
import { createConnection, deleteConnection } from "@/lib/db/repos/connectionsRepo.js";
import { masterKeyId } from "@/lib/security/masterKey.js";
import { auditRepo } from "@/lib/db/index.js";

const NOW = "2026-10-03T00:00:00.000Z";
const MASTER = crypto.randomBytes(32);

let db;
const manager = {
  userId: "manager",
  instanceRole: "user",
  workspaceIds: ["w"],
  workspaceRoles: { w: "manager" },
  via: "session",
};

const actions = () =>
  db.all(
    `SELECT action, actorUserId, targetType, targetId, before, after, result FROM auditEvents ORDER BY ts ASC, id ASC`,
  );

beforeEach(async () => {
  process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
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
  db.exec(
    "DELETE FROM auditEvents; DELETE FROM memberships; DELETE FROM workspaces; DELETE FROM users; DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')",
  );
  db.run(
    "INSERT INTO users(id, instanceRole, status, createdAt, updatedAt) VALUES ('manager', 'user', 'active', ?, ?)",
    [NOW, NOW],
  );
  db.run(
    "INSERT INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES ('w', 'w', 'shared', ?, ?)",
    [NOW, NOW],
  );
  db.run(
    "INSERT INTO memberships(workspaceId, userId, role, createdAt) VALUES ('w', 'manager', 'manager', ?)",
    [NOW],
  );
  db.run(
    "INSERT INTO _meta(key, value) VALUES ('apiKeysHashedVersion', '1'), ('apiKeysHashKid', ?)",
    [masterKeyId(MASTER)],
  );
});

describe("key lifecycle events", () => {
  it("emits key.create, key.update and key.revoke with actor + target, never key material", async () => {
    const { key: rawKey, metadata } = await createApiKey(manager, "w", {
      type: "service",
      name: "CI",
    });
    await updateApiKey(manager, "w", metadata.id, { name: "CI-renamed" });
    await revokeApiKey(manager, "w", metadata.id);

    const rows = actions().filter((r) => r.action.startsWith("key."));
    // ts has ms precision: same-ms inserts tie and uuid tiebreak is random, so compare sorted.
    expect(rows.map((r) => r.action).sort()).toEqual(["key.create", "key.revoke", "key.update"]);
    expect(rows.every((r) => r.actorUserId === "manager")).toBe(true);
    expect(rows.every((r) => r.targetType === "apiKey" && r.targetId === metadata.id)).toBe(true);
    // The raw secret and its hash never reach the audit path.
    const blob = JSON.stringify(rows);
    expect(blob).not.toContain(rawKey);
    expect(blob).toContain("CI-renamed");
  });
});

describe("connection lifecycle events", () => {
  it("emits connection.create and connection.delete without credential material", async () => {
    const conn = await createConnection(manager, "w", {
      provider: "openai",
      authType: "apikey",
      name: "org-key",
      apiKey: "sk-super-secret-value",
    });
    await deleteConnection(manager, conn.id);

    const rows = actions().filter((r) => r.action.startsWith("connection."));
    expect(rows.map((r) => r.action).sort()).toEqual(["connection.create", "connection.delete"]);
    expect(rows.every((r) => r.targetId === conn.id)).toBe(true);
    const blob = JSON.stringify(rows);
    expect(blob).not.toContain("sk-super-secret-value");
    expect(blob).toContain("org-key");
  });
});

describe("settings PATCH events (legacy single-user path)", () => {
  it("emits settings.update with keyNames; actor null off-switch", async () => {
    const { PATCH } = await import("@/app/api/settings/route.js");
    const patch = (body) =>
      PATCH(
        new Request("http://localhost/api/settings", {
          method: "PATCH",
          body: JSON.stringify(body),
        }),
        {
          params: Promise.resolve({}),
        },
      );
    const res = await patch({ requestLogsEnabled: true });
    expect(res.status).toBe(200);

    const rows = actions().filter((r) => r.action === "settings.update");
    expect(rows).toHaveLength(1);
    const settingsRow = JSON.parse(rows[0].after);
    expect(settingsRow.keyNames).toEqual(["requestLogsEnabled"]);
    expect(rows[0].actorUserId).toBeNull();
  });
});

describe("database export/import events", () => {
  it("emits db.export on success and db.import failure on a bad body", async () => {
    const { GET, POST } = await import("@/app/api/settings/database/route.js");
    const headers = { "x-9r-password": process.env.INITIAL_PASSWORD || "123456" };

    const exported = await GET(new Request("http://localhost/api/settings/database", { headers }));
    expect(exported.status).toBe(200);

    const badImport = await POST(
      new Request("http://localhost/api/settings/database", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: "not-json",
      }),
    );
    expect(badImport.status).toBe(400);

    const rows = actions().filter((r) => r.action.startsWith("db."));
    expect(rows.map((r) => r.action).sort()).toEqual(["db.export", "db.import"]);
    const byAction = Object.fromEntries(rows.map((r) => [r.action, r]));
    expect(byAction["db.export"].result).toBe("success");
    expect(byAction["db.import"].result).toBe("failure");
    expect(rows.every((r) => r.actorUserId === null)).toBe(true);
  });
});

describe("auditRepo contract used by all emitters", () => {
  it("list() exposes the pagination shape routes relay", async () => {
    const { pagination } = await auditRepo.list({ page: 1, pageSize: 100 });
    expect(pagination).toMatchObject({ page: 1, pageSize: 100, totalItems: 0, totalPages: 0 });
  });
});
