// Direct node:sqlite adapter (in-memory, no driver fallback that could mask it).
// Node 24 StatementSync caches result shape: after DDL a cached SELECT * throws
// ("Cannot get name of column N") on shrink or silently truncates on growth.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeSqliteAdapter } from "@/lib/db/adapters/nodeSqliteAdapter.js";

let db;
beforeEach(async () => {
  db = await createNodeSqliteAdapter(":memory:");
});
afterEach(() => db.close());

const plain = (rows) => rows.map((r) => ({ ...r }));
const sel = "SELECT * FROM t";

describe("node:sqlite adapter statement cache vs DDL", () => {
  it("reports driver node:sqlite", () => {
    expect(db.driver).toBe("node:sqlite");
  });

  it("shrink: first call after DDL returns full new shape", () => {
    db.exec("CREATE TABLE t(a,b,c,d,e,f); INSERT INTO t VALUES(1,2,3,4,5,6)");
    expect(Object.keys(db.all(sel)[0])).toHaveLength(6);
    db.exec("DROP TABLE t; CREATE TABLE t(a,b); INSERT INTO t VALUES(7,8)");
    expect(plain(db.all(sel))).toEqual([{ a: 7, b: 8 }]);
  });

  it("growth: first call after DDL is not truncated", () => {
    db.exec("CREATE TABLE t(a,b); INSERT INTO t VALUES(1,2)");
    expect(plain(db.all(sel))).toEqual([{ a: 1, b: 2 }]);
    db.exec("DROP TABLE t; CREATE TABLE t(a,b,c,d); INSERT INTO t VALUES(1,2,3,4)");
    expect(plain(db.all(sel))).toEqual([{ a: 1, b: 2, c: 3, d: 4 }]);
    expect(db.get(sel)).toMatchObject({ c: 3, d: 4 });
  });

  it("transaction: DDL commit invalidates cached shape", () => {
    db.exec("CREATE TABLE t(a,b); INSERT INTO t VALUES(1,2)");
    db.all(sel);
    db.transaction(() => {
      db.exec("DROP TABLE t; CREATE TABLE t(a,b,c); INSERT INTO t VALUES(1,2,3)");
    });
    expect(plain(db.all(sel))).toEqual([{ a: 1, b: 2, c: 3 }]);
  });

  it("rollback: statement prepared inside tx on new shape does not survive the undo", () => {
    db.exec("CREATE TABLE t(a,b); INSERT INTO t VALUES(1,2)");
    expect(() =>
      db.transaction(() => {
        db.exec("DROP TABLE t; CREATE TABLE t(a,b,c,d,e); INSERT INTO t VALUES(1,2,3,4,5)");
        expect(Object.keys(db.all(sel)[0])).toHaveLength(5); // warm cache in-window
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(plain(db.all(sel))).toEqual([{ a: 1, b: 2 }]);
  });

  it("rollback reusing the schema cookie still reads the restored shape", () => {
    db.exec("CREATE TABLE t(a,b); INSERT INTO t VALUES(1,2)");
    const cookie = () => db.get("PRAGMA main.schema_version").schema_version;
    const before = cookie();
    expect(() =>
      db.transaction(() => {
        db.exec("ALTER TABLE t ADD COLUMN c; UPDATE t SET c = 3");
        expect(plain(db.all(sel))).toEqual([{ a: 1, b: 2, c: 3 }]);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(cookie()).toBe(before);
    expect(plain(db.all(sel))).toEqual([{ a: 1, b: 2 }]);
  });

  it("nested savepoint rollback keeps outer transaction view correct", () => {
    db.exec("CREATE TABLE t(a,b); INSERT INTO t VALUES(1,2)");
    db.transaction(() => {
      expect(() =>
        db.transaction(() => {
          db.exec("ALTER TABLE t ADD COLUMN c; UPDATE t SET c = 3");
          expect(Object.keys(db.all(sel)[0])).toHaveLength(3);
          throw new Error("inner");
        }),
      ).toThrow("inner");
      expect(plain(db.all(sel))).toEqual([{ a: 1, b: 2 }]);
    });
    expect(plain(db.all(sel))).toEqual([{ a: 1, b: 2 }]);
  });

  it("partial exec: DDL applied before a later failure still invalidates cache", () => {
    db.exec("CREATE TABLE t(a,b,c,d); INSERT INTO t VALUES(1,2,3,4)");
    expect(Object.keys(db.all(sel)[0])).toHaveLength(4);
    expect(() =>
      db.exec(
        "DROP TABLE t; CREATE TABLE t(a,b); INSERT INTO t VALUES(7,8); SELECT * FROM missing",
      ),
    ).toThrow();
    expect(plain(db.all(sel))).toEqual([{ a: 7, b: 8 }]);
  });
});
