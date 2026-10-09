// YAN-375: automatic backups (backupDbLite) must cover every table, including
// the users & teams tenancy tables, and drop ONLY requestDetails. Real adapter
// + real isolated DATA_DIR (tests/vitest.config.js).
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import * as dbApi from "@/lib/db/index.js";
import { backupDbLite, makeBackupDir } from "@/lib/db/backup.js";

const NOW = "2026-10-08T00:00:00.000Z";
const TENANCY_TABLES = [
  "budgets",
  "connectionGrants",
  "identities",
  "memberships",
  "usageRollup",
  "userPreferences",
  "users",
  "workspaceKeys",
  "workspaceSettings",
  "workspaces",
];
// Opaque stand-ins: the backup copies bytes, it never decrypts anything.
const WRAPPED_DEK = JSON.stringify({ v: 1, kid: "k1", iv: "aXY=", ct: "Y3Q=", tag: "dGFn" });
const CIPHERTEXT = JSON.stringify({ v: 1, kid: "k1", iv: "aXY=", ct: "c2VhbGVk", tag: "dGFn" });

let db;

async function openRo(file) {
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(file, { readOnly: true });
}

const tableNames = (conn) =>
  conn
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name)
    .sort();

beforeAll(async () => {
  await dbApi.initDb();
  db = await getAdapter();
  db.run(
    `INSERT INTO users(id, email, username, displayName, instanceRole, status, passwordHash, sessionVersion, createdAt, updatedAt)
     VALUES('u1', 'u1@x.test', 'u1', 'U1', 'owner', 'active', 'bcrypt-hash', 3, ?, ?)`,
    [NOW, NOW],
  );
  db.run(
    `INSERT INTO identities(id, userId, provider, issuer, subject, createdAt) VALUES('i1', 'u1', 'password', '', 'u1', ?)`,
    [NOW],
  );
  db.run(
    `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES('w1', 'Team', 'shared', 'u1', ?, ?)`,
    [NOW, NOW],
  );
  db.run(
    `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES('w1', 'u1', 'owner', 'manual', ?)`,
    [NOW],
  );
  db.run(`INSERT INTO workspaceSettings(workspaceId, data) VALUES('w1', '{"theme":"ws"}')`);
  db.run(`INSERT INTO userPreferences(userId, data) VALUES('u1', '{"theme":"user"}')`);
  db.run(
    `INSERT INTO workspaceKeys(workspaceId, kid, wrappedDek, createdAt) VALUES('w1', 'k1', ?, ?)`,
    [WRAPPED_DEK, NOW],
  );
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, priority, isActive, data, createdAt, updatedAt, workspaceId, createdByUserId)
     VALUES('c1', 'openai', 'api_key', 'Main', 1, 1, ?, ?, ?, 'w1', 'u1')`,
    [CIPHERTEXT, NOW, NOW],
  );
  db.run(
    `INSERT INTO connectionGrants(id, connectionId, workspaceId, createdAt) VALUES('g1', 'c1', 'w1', 1)`,
  );
  db.run(
    `INSERT INTO budgets(id, workspaceId, scopeType, scopeId, window, limitUsd, createdAt)
     VALUES('b1', 'w1', 'workspace', 'w1', 'month', 5, ?)`,
    [NOW],
  );
  db.run(
    `INSERT INTO usageRollup(dateKey, workspaceId, userId, provider, model, requests, cost)
     VALUES('2026-10-08', 'w1', 'u1', 'openai', 'gpt-4o', 7, 0.5)`,
  );
  db.run(
    `INSERT INTO requestDetails(id, timestamp, provider, model, status, data) VALUES('rd1', ?, 'openai', 'gpt-4o', 'ok', '{}')`,
    [NOW],
  );
});

describe("automatic backup table coverage (YAN-375)", () => {
  it("copies every live table except requestDetails, tenancy tables included", async () => {
    const live = db
      .all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .map((r) => r.name)
      .sort();
    for (const t of TENANCY_TABLES) expect(live).toContain(t);

    const file = backupDbLite(db, makeBackupDir("test-tables"));
    const ro = await openRo(file);
    try {
      const names = tableNames(ro);
      expect(names).toEqual(live.filter((n) => n !== "requestDetails"));
      expect(names).not.toContain("requestDetails");
      for (const t of TENANCY_TABLES) expect(names).toContain(t);

      // Representative content survives byte-for-byte (ciphertext + wrapped DEK opaque).
      expect(ro.prepare("SELECT passwordHash, sessionVersion FROM users").get()).toMatchObject({
        passwordHash: "bcrypt-hash",
        sessionVersion: 3,
      });
      expect(ro.prepare("SELECT userId FROM identities").get().userId).toBe("u1");
      expect(ro.prepare("SELECT role FROM memberships").get().role).toBe("owner");
      expect(ro.prepare("SELECT data FROM workspaceSettings").get().data).toBe('{"theme":"ws"}');
      expect(ro.prepare("SELECT data FROM userPreferences").get().data).toBe('{"theme":"user"}');
      expect(ro.prepare("SELECT wrappedDek FROM workspaceKeys").get().wrappedDek).toBe(WRAPPED_DEK);
      expect(ro.prepare("SELECT data FROM providerConnections WHERE id='c1'").get().data).toBe(
        CIPHERTEXT,
      );
      expect(ro.prepare("SELECT connectionId FROM connectionGrants").get().connectionId).toBe("c1");
      expect(ro.prepare("SELECT limitUsd FROM budgets").get().limitUsd).toBe(5);
      expect(ro.prepare("SELECT requests FROM usageRollup").get().requests).toBe(7);
    } finally {
      ro.close();
    }
  });

  it("complete=true also keeps requestDetails (pre-import snapshots)", async () => {
    const dir = makeBackupDir("test-complete");
    const file = backupDbLite(db, dir, "data.sqlite", true);
    const ro = await openRo(file);
    try {
      expect(tableNames(ro)).toContain("requestDetails");
      expect(ro.prepare("SELECT COUNT(*) AS c FROM requestDetails").get().c).toBe(1);
    } finally {
      ro.close();
    }
    expect(fs.existsSync(path.join(dir, "data.sqlite"))).toBe(true);
  });
});
