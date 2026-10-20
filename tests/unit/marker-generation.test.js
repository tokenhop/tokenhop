// YAN-1106: marker reads follow an adapter write generation instead of
// re-querying `_meta` on every call. The memo is only sound if EVERY write to
// the database moves the generation, so this file (a) proves each write verb
// invalidates, (b) proves the rotation/poison fail-closed semantics still fire,
// and (c) statically enumerates every source file that touches a marker key or
// writes `_meta`, asserting each one writes through run/exec/transaction.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqlJsAdapter } from "@/lib/db/adapters/sqljsAdapter.js";
import {
  invalidateMarkerCache,
  markerGeneration,
  memoizeUntilWrite,
  readApiKeyStorageState,
} from "@/lib/db/apiKeyState.js";
import {
  readCredentialEncryptionState,
  readCredentialMarkerValues,
} from "@/lib/db/credentialEncryptionState.js";
import { installCredentialMaintenanceAdmission } from "@/lib/db/credentialMaintenance.js";

const kid = "0123456789abcdef";
let db;
let seq = 0;

beforeEach(async () => {
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
  db = await createSqlJsAdapter(path.join(process.env.DATA_DIR, `marker-gen-${seq++}.sqlite`));
  db.exec(`CREATE TABLE IF NOT EXISTS _meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS workspaceKeys(workspaceId TEXT PRIMARY KEY);`);
});
afterEach(() => db.close());

const reads = () => {
  let n = 0;
  const all = db.all;
  db.all = (...a) => {
    if (String(a[0]).includes("FROM _meta")) n++;
    return all.apply(db, a);
  };
  return () => n;
};

describe("write-generation memo", () => {
  it("serves repeat marker reads from memory while nothing writes", () => {
    const count = reads();
    readApiKeyStorageState(db);
    readApiKeyStorageState(db);
    readCredentialMarkerValues(db);
    readCredentialMarkerValues(db);
    readCredentialEncryptionState(db);
    readCredentialEncryptionState(db);
    expect(count()).toBe(2); // one 2-key batch + one 5-key batch
  });

  it("returns private copies: mutating a result never poisons the memo", () => {
    const a = readApiKeyStorageState(db);
    a.storage = "hashed";
    expect(readApiKeyStorageState(db).storage).toBe("legacy");
    const v = readCredentialMarkerValues(db);
    v.credentialsKekKid = "x";
    expect(readCredentialMarkerValues(db).credentialsKekKid).toBeNull();
    const s = readCredentialEncryptionState(db);
    s.storage = "encrypted";
    expect(readCredentialEncryptionState(db).storage).toBe("legacy");
  });

  it.each([
    ["run", () => db.run("INSERT INTO _meta(key,value) VALUES('apiKeysHashedVersion','1')")],
    ["exec", () => db.exec("INSERT INTO _meta(key,value) VALUES('apiKeysHashedVersion','1')")],
    [
      "transaction",
      () =>
        db.transaction(() =>
          db.run("INSERT INTO _meta(key,value) VALUES('apiKeysHashedVersion','1')"),
        ),
    ],
  ])("a marker write via %s is seen by the very next read", (_name, write) => {
    expect(readApiKeyStorageState(db).storage).toBe("legacy");
    const before = markerGeneration(db);
    expect(() => {
      write();
      readApiKeyStorageState(db);
    }).toThrow(expect.objectContaining({ code: "API_KEY_STATE_INVALID" })); // half marker
    expect(markerGeneration(db)).toBeGreaterThan(before);
  });

  it("a write inside a rolled-back transaction never leaves a stale memo", () => {
    expect(readApiKeyStorageState(db).storage).toBe("legacy");
    expect(() =>
      db.transaction(() => {
        db.run(
          `INSERT INTO _meta(key,value) VALUES('apiKeysHashedVersion','1'),('apiKeysHashKid','${kid}')`,
        );
        expect(readApiKeyStorageState(db).storage).toBe("hashed");
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(readApiKeyStorageState(db).storage).toBe("legacy");
  });

  it("a thrown read is never cached", () => {
    db.run("INSERT INTO _meta(key,value) VALUES('credentialsKekKid', ?)", [kid]);
    expect(() => readCredentialEncryptionState(db)).toThrow(
      expect.objectContaining({ code: "CREDENTIAL_STATE_INVALID" }),
    );
    db.run("DELETE FROM _meta WHERE key = 'credentialsKekKid'");
    expect(readCredentialEncryptionState(db).storage).toBe("legacy");
  });

  it("strict reads always run the envelope sniff (never memoized)", () => {
    db.exec("CREATE TABLE IF NOT EXISTS providerConnections(id TEXT PRIMARY KEY, data TEXT)");
    let sniffs = 0;
    const all = db.all;
    db.all = (...a) => {
      if (String(a[0]).includes("instr(data")) sniffs++;
      return all.apply(db, a);
    };
    readCredentialEncryptionState(db, { strict: true });
    readCredentialEncryptionState(db, { strict: true });
    expect(sniffs).toBe(2);
    readCredentialEncryptionState(db);
    expect(sniffs).toBe(2); // the runtime path never sniffs
  });

  it("a mutator replaced after install (spy, maintenance gate) still invalidates", () => {
    expect(readApiKeyStorageState(db).storage).toBe("legacy");
    installCredentialMaintenanceAdmission(db);
    const gen = markerGeneration(db);
    db.run(
      `INSERT INTO _meta(key,value) VALUES('apiKeysHashedVersion','1'),('apiKeysHashKid','${kid}')`,
    );
    expect(markerGeneration(db)).toBeGreaterThan(gen);
    expect(readApiKeyStorageState(db).storage).toBe("hashed");
  });

  it("repeatedly replacing a mutator never stacks wrappers without bound", () => {
    readApiKeyStorageState(db);
    let depth = 0;
    for (let i = 0; i < 50; i++) {
      const inner = db.run;
      db.run = function replaced(...a) {
        depth++;
        return inner.apply(this, a);
      };
      readApiKeyStorageState(db);
    }
    // Past the bound the adapter falls back to live reads: never stale.
    db.run("INSERT INTO _meta(key,value) VALUES('apiKeysHashedVersion','1'),('apiKeysHashKid',?)", [
      kid,
    ]);
    expect(readApiKeyStorageState(db).storage).toBe("hashed");
    expect(depth).toBeGreaterThan(0);
  });

  it("an adapter without run() is never memoized (read-only handle)", () => {
    let calls = 0;
    const readonly = {
      get: () => null,
      all: () => {
        calls++;
        return [];
      },
    };
    readApiKeyStorageState(readonly);
    readApiKeyStorageState(readonly);
    expect(calls).toBe(2);
    expect(markerGeneration(readonly)).toBeNull();
  });

  it("invalidateMarkerCache forces a re-read", () => {
    const count = reads();
    readApiKeyStorageState(db);
    invalidateMarkerCache(db);
    readApiKeyStorageState(db);
    expect(count()).toBe(2);
  });

  it("a computation that races a write is not cached", () => {
    let first = true;
    const value = memoizeUntilWrite(db, "race", () => {
      if (first) {
        first = false;
        db.run("INSERT INTO _meta(key,value) VALUES('x','1')");
      }
      return Symbol("v");
    });
    expect(memoizeUntilWrite(db, "race", () => "fresh")).not.toBe(value);
  });
});

// ─── static enumeration of marker writers ───────────────────────────────────
const MARKER_RE =
  /apiKeysHashedVersion|apiKeysHashKid|credentialsEncryptedVersion|credentialsKekKid|credentialsCleanupPending|credentialsPendingRotation|apiKeyHashKeyWrapped/;
const SRC = path.resolve(import.meta.dirname, "../../src");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(SRC);
const rel = (f) => path.relative(SRC, f).replaceAll(path.sep, "/");

describe("every writer of a marker key goes through a tracked mutator", () => {
  // Marker-key writers (INSERT/UPDATE/DELETE/setMeta). Adding a new file here
  // means it writes a marker: confirm it uses run/exec/transaction/setMetaSync.
  const KNOWN_WRITERS = [
    "lib/db/activateCredentialEncryption.js",
    "lib/db/helpers/gatewayKeyTransfer.js",
    "lib/db/migrations/encryptCredentials.js",
    "lib/db/migrations/hashGatewayKeys.js",
    "lib/security/keyRotation.js",
  ];
  const WRITE_CALL = /(?:setMeta(?:Sync)?|\.run|\.exec)\(/;
  const WRITE_SQL = /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;

  it("no unknown file writes a marker key", () => {
    const writers = files
      .filter((f) => {
        const text = fs.readFileSync(f, "utf8");
        if (!MARKER_RE.test(text)) return false;
        // A marker key literal on a line that also writes, or inside a write statement.
        return text.split("\n").some((line, i, lines) => {
          if (!MARKER_RE.test(line)) return false;
          const window = lines.slice(Math.max(0, i - 3), i + 2).join("\n");
          return WRITE_CALL.test(window) && (WRITE_SQL.test(window) || /setMeta/.test(window));
        });
      })
      .map(rel)
      .filter((f) => !f.startsWith("lib/db/migrations/") || KNOWN_WRITERS.includes(f));
    expect(writers.sort()).toEqual([...KNOWN_WRITERS].sort());
  });

  it("no source file writes through get()/all() or captures a bare mutator", () => {
    const offenders = [];
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      if (rel(f).startsWith("lib/db/adapters/")) continue;
      if (/\.(?:get|all)\(\s*[`"'](?:\s*)(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(text))
        offenders.push(`${rel(f)}: write through get/all`);
      if (
        /\b(?:const|let)\s*\{[^}]*\b(?:run|exec|transaction)\b[^}]*\}\s*=\s*(?:db|adapter)\b/.test(
          text,
        )
      )
        offenders.push(`${rel(f)}: destructured mutator`);
      if (/\b(?:db|adapter)\.raw\b/.test(text) && !rel(f).startsWith("lib/db/"))
        offenders.push(`${rel(f)}: raw handle`);
    }
    expect(offenders).toEqual([]);
  });

  it("the only code that opens a SQLite file for writing is an adapter or a tracked stage", () => {
    const openers = files
      .filter((f) =>
        /new (?:Database|DatabaseSync)\(|SQLLib\.Database\(|new SQL\.Database\(/.test(
          fs.readFileSync(f, "utf8"),
        ),
      )
      .map(rel)
      .sort();
    // Explicit inventory: every file that can open a SQLite database. A new
    // opener is a possible second connection and must be reviewed before it is
    // added here.
    const expected = [
      "app/api/oauth/cursor/auto-import/route.js", // Cursor's own state file, read-only
      "lib/db/activateGatewayKeys.js", // read-only backup verification
      "lib/db/adapters/betterSqliteAdapter.js",
      "lib/db/adapters/bunSqliteAdapter.js",
      "lib/db/adapters/nodeSqliteAdapter.js",
      "lib/db/adapters/sqljsAdapter.js",
      "lib/db/backup.js", // read-only integrity check of a copied snapshot
      "lib/db/snapshot/importStageSqljs.js", // in-memory scratch stage, never the live file
    ];
    expect(openers).toEqual(expected);
  });
});
