// apiKeys keyHash-shape cache probe: bool-only, main-qualified, cookie-checked.
import { describe, expect, it } from "vitest";
import { apiKeysHasKeyHash, clearApiKeysSchemaCache } from "@/lib/db/helpers/apiKeysSchema.js";

const stub = ({ version = 7, cols = ["id", "key"], failFirst = 0 } = {}) => {
  const calls = { version: 0, info: 0, sql: [] };
  let failures = failFirst;
  return {
    calls,
    db: {
      get: (sql) => {
        calls.sql.push(sql);
        calls.version++;
        return { schema_version: version };
      },
      all: (sql) => {
        calls.sql.push(sql);
        calls.info++;
        if (failures > 0) {
          failures--;
          throw new Error("boom");
        }
        return cols.map((name) => ({ name }));
      },
    },
  };
};

describe("apiKeysHasKeyHash", () => {
  it("repeats same cookie with one table_info; equal cookies stay per-adapter", () => {
    const a = stub();
    expect(apiKeysHasKeyHash(a.db)).toBe(false);
    expect(apiKeysHasKeyHash(a.db)).toBe(false);
    expect(a.calls.info).toBe(1);
    const b = stub();
    expect(apiKeysHasKeyHash(b.db)).toBe(false);
    expect(b.calls.info).toBe(1);
  });

  it("follows DDL legacy->hashed->legacy across cookie bumps", () => {
    let version = 7;
    let cols = ["id", "key"];
    const db = {
      get: () => ({ schema_version: version }),
      all: () => cols.map((name) => ({ name })),
    };
    expect(apiKeysHasKeyHash(db)).toBe(false);
    version = 8;
    cols = ["id", "keyHash"];
    expect(apiKeysHasKeyHash(db)).toBe(true);
    version = 9;
    cols = ["id", "key"];
    expect(apiKeysHasKeyHash(db)).toBe(false);
  });

  it("uses main-qualified PRAGMAs so a TEMP shadow cannot win", () => {
    const { calls, db } = stub();
    apiKeysHasKeyHash(db);
    expect(calls.sql).toEqual(["PRAGMA main.schema_version", "PRAGMA main.table_info(apiKeys)"]);
  });

  it("propagates errors, caches nothing, retries clean", () => {
    const { calls, db } = stub({ failFirst: 1 });
    expect(() => apiKeysHasKeyHash(db)).toThrow("boom");
    expect(apiKeysHasKeyHash(db)).toBe(false);
    expect(calls.info).toBe(2);
  });

  it("explicit clear drops a stale same-cookie entry", () => {
    let cols = ["id", "key"];
    const db = {
      get: () => ({ schema_version: 7 }),
      all: () => cols.map((name) => ({ name })),
    };
    expect(apiKeysHasKeyHash(db)).toBe(false);
    cols = ["id", "keyHash"]; // external DDL reusing the cookie
    expect(apiKeysHasKeyHash(db)).toBe(false); // stale until cleared
    clearApiKeysSchemaCache(db);
    expect(apiKeysHasKeyHash(db)).toBe(true);
  });

  it("runVersionedMigrations clears a memo warmed inside rolled-back DDL", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { runVersionedMigrations } = await import("@/lib/db/migrate.js");
    const { schemaCookie, reachSchemaCookie } = await import("../helpers/schemaCookie.js");
    const db = await getAdapter();
    const original = schemaCookie(db);
    let warmed;
    const version = Number(db.get("SELECT value FROM _meta WHERE key = 'schemaVersion'").value) + 1;
    expect(() =>
      runVersionedMigrations(db, [
        {
          version,
          name: "probe-rollback",
          up: (adapter) => {
            adapter.exec("ALTER TABLE apiKeys ADD COLUMN keyHash TEXT");
            expect(apiKeysHasKeyHash(adapter)).toBe(true);
            warmed = schemaCookie(adapter);
            throw new Error("probe rollback");
          },
        },
      ]),
    ).toThrow("probe rollback");
    expect(schemaCookie(db)).toBe(original);
    reachSchemaCookie(db, warmed);
    expect(apiKeysHasKeyHash(db)).toBe(false);
  });

  it("live: TEMP shadow does not change main's answer; flush/snapshot stay stable", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    clearApiKeysSchemaCache(db);
    const before = apiKeysHasKeyHash(db);
    db.exec("CREATE TEMP TABLE apiKeys(x TEXT)");
    try {
      clearApiKeysSchemaCache(db);
      expect(apiKeysHasKeyHash(db)).toBe(before);
    } finally {
      db.exec("DROP TABLE temp.apiKeys");
    }
    db.flushSync?.();
    db.snapshot?.();
    clearApiKeysSchemaCache(db);
    expect(apiKeysHasKeyHash(db)).toBe(before);
  });

  it("live: schema cache never overrides a malformed marker", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { readApiKeyStorageState } = await import("@/lib/db/apiKeyState.js");
    const db = await getAdapter();
    apiKeysHasKeyHash(db); // prime the bool cache
    db.run("INSERT OR REPLACE INTO _meta(key,value) VALUES ('apiKeysHashedVersion','bogus')");
    try {
      expect(() => readApiKeyStorageState(db)).toThrow(/Invalid API key storage state/);
    } finally {
      db.run("DELETE FROM _meta WHERE key = 'apiKeysHashedVersion'");
    }
  });
});
