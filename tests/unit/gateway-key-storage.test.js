import { beforeEach, describe, expect, it } from "vitest";
import * as keys from "@/lib/db/repos/apiKeysRepo.js";
import { getAdapter } from "@/lib/db/driver.js";
import { updateUserUnscoped } from "@/lib/db/repos/usersRepo.js";
import { addMembership, removeMembership } from "@/lib/db/repos/membershipsRepo.js";

const NOW = "2026-10-03T00:00:00.000Z";
const KID = "0123456789abcdef";
let db;
const row = (patch = {}) => ({
  id: "key",
  workspaceId: "w",
  userId: "u",
  createdByUserId: "u",
  keyHash: "a".repeat(64),
  hashKid: KID,
  prefix: "th_1234…5678",
  name: "Runner",
  machineId: null,
  legacy: 0,
  isActive: 1,
  revokedAt: null,
  allowedModels: [],
  allowedCombos: [],
  expiresAt: null,
  lastUsedAt: null,
  createdAt: NOW,
  ...patch,
});
const ctx = { userId: "manager", instanceRole: "user" };

beforeEach(async () => {
  db = await getAdapter();
  db.exec("DROP TABLE apiKeys");
  // Direct hashed fixture only: no migration or crypto activation.
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    userId TEXT REFERENCES users(id) ON DELETE CASCADE,
    createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
    keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
    machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
    revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
    expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
  db.exec(
    "DELETE FROM memberships; DELETE FROM workspaces; DELETE FROM users; DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')",
  );
  for (const id of ["u", "manager"])
    db.run(
      "INSERT INTO users(id, instanceRole, status, createdAt, updatedAt) VALUES (?, 'user', 'active', ?, ?)",
      [id, NOW, NOW],
    );
  for (const id of ["w", "other"]) {
    db.run(
      "INSERT INTO workspaces(id,name,kind,createdAt,updatedAt) VALUES (?, ?, 'shared', ?, ?)",
      [id, id, NOW, NOW],
    );
    for (const userId of ["u", "manager"])
      db.run("INSERT INTO memberships(workspaceId,userId,role,createdAt) VALUES (?, ?, ?, ?)", [
        id,
        userId,
        userId === "manager" ? "manager" : "member",
        NOW,
      ]);
  }
  db.run("INSERT INTO _meta(key,value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)", [
    KID,
  ]);
});

describe("hashed gateway key storage", () => {
  it("reads strict durable marker pairs", async () => {
    const { readApiKeyStorageState } = await import("@/lib/db/apiKeyState.js");
    expect(readApiKeyStorageState(db)).toEqual({ storage: "hashed", version: 1, hashKid: KID });
    db.run("DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')");
    expect(readApiKeyStorageState(db)).toEqual({ storage: "legacy", version: null, hashKid: null });
    for (const [version, kid] of [
      [null, KID],
      ["1", null],
      ["2", KID],
      ["01", KID],
      ["1", ""],
      ["1", "x"],
      ["1", KID.toUpperCase()],
    ]) {
      db.run("DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')");
      if (version !== null)
        db.run("INSERT INTO _meta VALUES ('apiKeysHashedVersion',?)", [version]);
      if (kid !== null) db.run("INSERT INTO _meta VALUES ('apiKeysHashKid',?)", [kid]);
      expect(() => readApiKeyStorageState(db)).toThrow(
        expect.objectContaining({ code: "API_KEY_STATE_INVALID" }),
      );
    }
  });

  it("validates hash-only rows and projects explicit safe metadata", () => {
    expect(typeof keys.insertHashedApiKeySync).toBe("function");
    for (const patch of [
      { key: "secret" },
      { plain: "secret" },
      { budgetId: "b" },
      { keyHash: "bad" },
      { hashKid: "bad" },
      { allowedModels: [42] },
      { allowedCombos: "[]" },
      { expiresAt: "tomorrow" },
      { isActive: "false" },
    ]) {
      expect(() => keys.insertHashedApiKeySync(db, row(patch))).toThrow();
    }
    const saved = keys.insertHashedApiKeySync(db, row());
    expect(saved.allowedModels).toEqual([]);
    expect(keys.getHashedApiKeyByHashUnscoped(db, row().keyHash)).toEqual(saved);
    expect(() => keys.insertHashedApiKeySync(db, row({ id: "duplicate" }))).toThrow();
    const metadata = keys.apiKeyMetadata({
      ...saved,
      key: "secret",
      plain: "secret",
      unexpected: "secret",
    });
    for (const field of ["key", "plain", "keyHash", "hashKid", "unexpected"])
      expect(metadata).not.toHaveProperty(field);
    expect(metadata).toMatchObject({ id: "key", type: "user", isActive: true, allowedModels: [] });
    expect(db.all("PRAGMA table_info(apiKeys)").map((r) => r.name)).not.toContain("key");
  });

  it("rechecks live hash, kid, pause, tombstone, expiry, user and membership", () => {
    expect(typeof keys.insertHashedApiKeySync).toBe("function");
    keys.insertHashedApiKeySync(db, row());
    const eligible = () =>
      keys.getEligibleApiKeySync(db, "key", { keyHash: row().keyHash, now: NOW });
    expect(eligible()).not.toBeNull();
    expect(keys.getEligibleApiKeySync(db, "key", { keyHash: "b".repeat(64), now: NOW })).toBeNull();
    for (const [field, value, original] of [
      ["hashKid", "f".repeat(16), KID],
      ["isActive", 0, 1],
      ["revokedAt", NOW, null],
      ["expiresAt", NOW, null],
    ]) {
      db.run(`UPDATE apiKeys SET ${field} = ?`, [value]);
      expect(eligible()).toBeNull();
      db.run(`UPDATE apiKeys SET ${field} = ?`, [original]);
    }
    db.run("UPDATE users SET status = 'disabled' WHERE id = 'u'");
    expect(eligible()).toBeNull();
    db.run("UPDATE users SET status = 'active', instanceRole = 'pending' WHERE id = 'u'");
    expect(eligible()).toBeNull();
    db.run("UPDATE users SET instanceRole = 'user' WHERE id = 'u'");
    db.run("DELETE FROM memberships WHERE userId = 'u' AND workspaceId = 'w'");
    expect(eligible()).toBeNull();
    keys.insertHashedApiKeySync(db, row({ id: "service", userId: null, keyHash: "b".repeat(64) }));
    db.run("UPDATE users SET status = 'disabled' WHERE id = 'u'");
    expect(
      keys.getEligibleApiKeySync(db, "service", { keyHash: "b".repeat(64), now: NOW }),
    ).not.toBeNull();
  });

  it("disable and leave tombstone inside transactions; re-enable and rejoin never revive", async () => {
    expect(typeof keys.insertHashedApiKeySync).toBe("function");
    keys.insertHashedApiKeySync(db, row());
    keys.insertHashedApiKeySync(
      db,
      row({ id: "other-key", workspaceId: "other", keyHash: "b".repeat(64) }),
    );
    keys.insertHashedApiKeySync(db, row({ id: "service", userId: null, keyHash: "c".repeat(64) }));
    db.exec(
      "CREATE TRIGGER block_revoke BEFORE UPDATE OF revokedAt ON apiKeys BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    await expect(removeMembership(ctx, "w", "u")).rejects.toThrow("blocked");
    expect(
      db.get("SELECT role FROM memberships WHERE workspaceId='w' AND userId='u'"),
    ).toBeTruthy();
    await expect(updateUserUnscoped("u", { status: "disabled" })).rejects.toThrow("blocked");
    expect(db.get("SELECT status FROM users WHERE id='u'").status).toBe("active");
    db.exec("DROP TRIGGER block_revoke");
    await removeMembership(ctx, "w", "u");
    await addMembership(ctx, "w", { userId: "u" });
    const first = db.get("SELECT revokedAt FROM apiKeys WHERE id='key'").revokedAt;
    expect(first).toBeTruthy();
    expect(db.get("SELECT revokedAt FROM apiKeys WHERE id='other-key'").revokedAt).toBeNull();
    await updateUserUnscoped("u", { status: "disabled" });
    await updateUserUnscoped("u", { status: "active" });
    db.run("UPDATE apiKeys SET isActive=1");
    expect(db.get("SELECT revokedAt FROM apiKeys WHERE id='key'").revokedAt).toBe(first);
    expect(
      keys.getEligibleApiKeySync(db, "other-key", { keyHash: "b".repeat(64), now: NOW }),
    ).toBeNull();
    expect(db.get("SELECT revokedAt FROM apiKeys WHERE id='service'").revokedAt).toBeNull();
  });

  it("revocation fails closed on invalid marker or schema probe errors", () => {
    const hashed = () => keys.revokeUserApiKeysSync(db, "u", { workspaceId: "w", now: NOW });
    expect(hashed()).toBe(0); // hashed path exercised, no matching rows yet
    keys.insertHashedApiKeySync(db, row());

    // Injected schema mismatch becomes API_KEY_STATE_INVALID, never silent 0.
    db.exec("ALTER TABLE apiKeys RENAME COLUMN keyHash TO tamperedHash");
    expect(() => hashed()).toThrow(expect.objectContaining({ code: "API_KEY_STATE_INVALID" }));
    db.exec("ALTER TABLE apiKeys RENAME COLUMN tamperedHash TO keyHash");
    expect(db.get("SELECT revokedAt FROM apiKeys WHERE id='key'").revokedAt).toBeNull();

    // Injected marker failure propagates through the same transaction-capable
    // helper instead of collapsing to 0.
    const broken = {
      get: () => {
        throw new Error("injected _meta read failure");
      },
      all: (...args) => db.all(...args),
      run: (...args) => db.run(...args),
      exec: (...args) => db.exec(...args),
    };
    expect(() => keys.revokeUserApiKeysSync(broken, "u", { now: NOW })).toThrow(
      "injected _meta read failure",
    );
    expect(db.get("SELECT revokedAt FROM apiKeys WHERE id='key'").revokedAt).toBeNull();

    expect(hashed()).toBe(1);
    expect(db.get("SELECT revokedAt FROM apiKeys WHERE id='key'").revokedAt).toBe(NOW);
  });

  it("malformed, oversized, or non-array stored scopes fail closed", () => {
    keys.insertHashedApiKeySync(db, row());
    for (const [field, value] of [
      ["allowedModels", "["],
      ["allowedModels", '"model"'],
      ["allowedModels", JSON.stringify([42])],
      ["allowedModels", JSON.stringify(new Array(129).fill("model"))],
      ["allowedModels", JSON.stringify(["x".repeat(257)])],
      ["allowedCombos", "{"],
      ["allowedCombos", JSON.stringify({ combo: [] })],
    ]) {
      db.run(`UPDATE apiKeys SET ${field} = ?`, [value]);
      expect(() =>
        keys.getEligibleApiKeySync(db, "key", { keyHash: "a".repeat(64), now: NOW }),
      ).toThrow(/Invalid hashed API key row/);
    }
  });

  it("canonicalizes timestamp variants and rejects impossible calendar dates", () => {
    const saved = keys.insertHashedApiKeySync(db, row({ expiresAt: "2026-10-04T00:00:00Z" }));
    expect(saved.expiresAt).toBe("2026-10-04T00:00:00.000Z");
    db.run("UPDATE apiKeys SET expiresAt = '2026-10-04T00:00:00.000Z'");
    expect(
      keys.getEligibleApiKeySync(db, "key", {
        keyHash: "a".repeat(64),
        now: "2026-10-03T00:00:00Z",
      }),
    ).not.toBeNull();
    // Approved semantics: expiry at equality rejects (expiresAt <= now expired).
    expect(
      keys.getEligibleApiKeySync(db, "key", {
        keyHash: "a".repeat(64),
        now: "2026-10-04T00:00:00Z",
      }),
    ).toBeNull();
    // Impossible dates throw instead of silently rolling over.
    for (const bad of ["2026-02-30T00:00:00Z", "2026-10-04T25:00:00Z", "2026-13-04T00:00:00Z"]) {
      expect(() =>
        keys.insertHashedApiKeySync(db, row({ id: bad, keyHash: "d".repeat(64), expiresAt: bad })),
      ).toThrow(/Invalid hashed API key row/);
    }
  });

  it("cascades user/workspace keys, nulls creator only, and preserves usage history", async () => {
    const { HASHED_API_KEYS_TABLE, buildCreateTableSql } = await import("@/lib/db/schema.js");
    expect(HASHED_API_KEYS_TABLE).toBeDefined();
    db.exec("DROP TABLE apiKeys");
    db.exec(buildCreateTableSql("apiKeys", HASHED_API_KEYS_TABLE));
    keys.insertHashedApiKeySync(db, row());
    keys.insertHashedApiKeySync(db, row({ id: "service", userId: null, keyHash: "b".repeat(64) }));
    db.run("INSERT INTO usageHistory(timestamp,apiKey) VALUES (?, 'key')", [NOW]);
    db.run("DELETE FROM users WHERE id='u'");
    expect(keys.getHashedApiKeyByHashUnscoped(db, row().keyHash)).toBeNull();
    expect(keys.getHashedApiKeyByHashUnscoped(db, "b".repeat(64)).createdByUserId).toBeNull();
    db.run("DELETE FROM workspaces WHERE id='w'");
    expect(db.get("SELECT COUNT(*) AS n FROM apiKeys").n).toBe(0);
    expect(db.get("SELECT apiKey FROM usageHistory WHERE apiKey='key'")).toBeTruthy();
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });
});
