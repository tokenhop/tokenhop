// Staging area for whole-instance imports (YAN-1013). Section rows are staged
// into a private disposable SQLite DB (never held in the JS heap), validated
// by paging, then copied into the live tables with INSERT…SELECT inside the
// caller's single synchronous import transaction.
//
// Native drivers ATTACH `<dir>/stage.sqlite` as the fixed schema `xstage`
// (instance imports are serialized by transferLock, so the fixed name is
// safe). sql.js cannot ATTACH safely (persist() reopens the DB), so it uses a
// separate in-memory DB — the documented bounded-memory exception.
//
// Stage columns are deliberately UNTYPED (no affinity): a value is stored and
// read back exactly as bound, so main-table affinity conversion at apply time
// is byte-identical to today's direct bind path. No json_extract anywhere.
import fs from "node:fs";
import path from "node:path";
import { fail, isPlainObject, SECTIONS } from "../helpers/instanceSnapshotSchema.js";
import {
  NOOP_SEEN,
  sectionDedupKeys,
  validateSectionRow,
} from "../helpers/instanceSnapshotTables.js";
import { openPrivateFileSync } from "../stagingFiles.js";

const PAGE = 500;
const SMALL_PAGE = 200; // requestDetails rows carry large `data`
const SET_NULL_SECTIONS = new Set(["usageHistory", "requestDetails"]);

export const q = (id) => `"${id}"`;

/** CREATE TABLE for one staged section; `table` is the qualified table name. */
export function stageDdl(table, section) {
  const cols = section.columns.map(q).join(", ");
  return `CREATE TABLE ${table}(seq INTEGER PRIMARY KEY, k1, k2, absent, ${cols}, UNIQUE(k1), UNIQUE(k2))`;
}

const pageSizeOf = (section) => (section.name === "requestDetails" ? SMALL_PAGE : PAGE);

function sqlLiteral(value) {
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  return "NULL";
}

/** `<col>` or `COALESCE(<col>, <default>)` — mirrors `row[c] ?? defaults[c] ?? null`. */
function applySelectList(section) {
  return section.columns
    .map((c) => {
      const d = section.defaults?.[c];
      return d === undefined || d === null ? q(c) : `COALESCE(${q(c)}, ${sqlLiteral(d)})`;
    })
    .join(", ");
}

const validValue = (v) =>
  v === null || typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

function rowFromStage(section, rec) {
  const absent = rec.absent ? new Set(JSON.parse(rec.absent)) : null;
  const row = {};
  for (const c of section.columns) if (!absent?.has(c)) row[c] = rec[c];
  return row;
}

function nativeBackend(db, dir) {
  const file = path.join(dir, "stage.sqlite");
  if (file.includes("\0")) throw new Error("Invalid staging path");
  fs.closeSync(openPrivateFileSync(file)); // private (0600) before SQLite touches it
  try {
    db.exec("DETACH DATABASE xstage"); // stale attach from an interrupted import
  } catch {}
  db.exec(`ATTACH DATABASE '${file.replace(/'/g, "''")}' AS xstage`);
  const table = (name) => `xstage.${q(name)}`;
  const backend = {
    table,
    run: (sql, params = []) => db.run(sql, params),
    all: (sql, params = []) => db.all(sql, params),
    get: (sql, params = []) => db.get(sql, params),
    transaction: (fn) => db.transaction(fn),
    setRefs(refs) {
      db.exec("DELETE FROM xstage._refUsers; DELETE FROM xstage._refWorkspaces");
      for (const [tbl, ids] of [
        ["_refUsers", refs.users],
        ["_refWorkspaces", refs.workspaces],
      ]) {
        db.transaction(() => {
          for (const id of ids) db.run(`INSERT OR IGNORE INTO xstage.${tbl}(id) VALUES(?)`, [id]);
        });
      }
    },
    // Absent section: copy live rows. usageHistory/requestDetails attribution
    // FKs are ON DELETE SET NULL — a ref the snapshot replaces becomes NULL.
    retain(_db, section) {
      const sel = section.columns
        .map((c) => {
          if (!SET_NULL_SECTIONS.has(section.name)) return q(c);
          if (c !== "workspaceId" && c !== "userId") return q(c);
          const refTable = c === "workspaceId" ? "_refWorkspaces" : "_refUsers";
          return `CASE WHEN ${q(c)} <> '' AND ${q(c)} IN (SELECT id FROM xstage.${refTable}) THEN ${q(c)} END`;
        })
        .join(", ");
      db.run(
        `INSERT INTO ${table(section.name)}(k1, k2, absent, ${section.columns.map(q).join(", ")}) SELECT NULL, NULL, NULL, ${sel} FROM main.${q(section.name)} ORDER BY rowid`,
      );
    },
    apply(_db, section) {
      db.run(
        `INSERT INTO main.${q(section.name)}(${section.columns.map(q).join(", ")}) SELECT ${applySelectList(section)} FROM ${table(section.name)} ORDER BY seq`,
      );
    },
    size: () => {
      try {
        return fs.statSync(file).size;
      } catch {
        return 0;
      }
    },
    close() {
      try {
        db.exec("DETACH DATABASE xstage");
      } catch {}
    },
  };
  try {
    // MEMORY journal: no -journal file, yet a failed staging batch can roll back.
    db.exec("PRAGMA xstage.journal_mode = MEMORY");
    db.exec("PRAGMA xstage.synchronous = OFF");
    db.exec("CREATE TABLE xstage._refUsers(id TEXT PRIMARY KEY)");
    db.exec("CREATE TABLE xstage._refWorkspaces(id TEXT PRIMARY KEY)");
    for (const s of SECTIONS) db.exec(stageDdl(table(s.name), s));
  } catch (error) {
    backend.close();
    throw error;
  }
  return backend;
}

function duplicateMessage(backend, section, k1) {
  if (section.name === "invitations") {
    const hit =
      k1 !== null &&
      backend.get(`SELECT 1 AS x FROM ${backend.table(section.name)} WHERE k1 = ?`, [k1]);
    return hit ? "duplicate invitations tokenHash in snapshot" : "duplicate invitations row";
  }
  return `duplicate ${section.name} row`;
}

function createStage(db, backend) {
  const present = new Set();
  const counts = {};
  const byName = new Map(SECTIONS.map((s) => [s.name, s]));
  const columnSets = new Map(SECTIONS.map((s) => [s.name, new Set(s.columns)]));
  const insertSql = new Map();
  const progress = (section, rows) => handle.onProgress?.({ phase: "import", section, rows });

  function sqlFor(section) {
    let sql = insertSql.get(section.name);
    if (!sql) {
      const cols = section.columns.map(q).join(", ");
      const marks = section.columns.map(() => "?").join(", ");
      sql = `INSERT INTO ${backend.table(section.name)}(k1, k2, absent, ${cols}) VALUES(?, ?, ?, ${marks}) ON CONFLICT DO NOTHING`;
      insertSql.set(section.name, sql);
    }
    return sql;
  }

  // Per-row checks that need no refs; returns bind params.
  function checkRow(section, row) {
    if (!isPlainObject(row))
      fail("TRANSFER_STATE_INVALID", `${section.name} entries must be objects`);
    const known = columnSets.get(section.name);
    for (const field of Object.keys(row)) {
      if (!known.has(field)) {
        fail("TRANSFER_STATE_INVALID", `${section.name} entry has unknown field "${field}"`);
      }
    }
    const absent = [];
    const values = section.columns.map((c) => {
      const v = row[c];
      if (v === undefined) {
        absent.push(c);
        return null;
      }
      if (!validValue(v))
        fail("TRANSFER_STATE_INVALID", `${section.name} entry has an invalid value`);
      return v;
    });
    const [k1, k2] = sectionDedupKeys(section, row);
    return { k1, params: [k1, k2, absent.length ? JSON.stringify(absent) : null, ...values] };
  }

  function validateStaged(refs) {
    for (const section of SECTIONS) {
      const size = pageSizeOf(section);
      const table = backend.table(section.name);
      let last = 0;
      let seen = 0;
      for (;;) {
        const rows = backend.all(`SELECT * FROM ${table} WHERE seq > ? ORDER BY seq LIMIT ?`, [
          last,
          size,
        ]);
        if (rows.length === 0) break;
        last = rows[rows.length - 1].seq;
        for (const rec of rows)
          validateSectionRow(section, rowFromStage(section, rec), refs, NOOP_SEEN);
        seen += rows.length;
        progress(section.name, seen);
        if (rows.length < size) break;
      }
    }
  }

  const handle = {
    present,
    counts,
    onProgress: null,

    /** Stage one batch of parsed rows (one transaction). Marks the section own-present. */
    stageRows(name, rows) {
      const section = byName.get(name);
      if (!section) throw new Error(`Unknown snapshot section "${name}"`);
      present.add(name);
      const checked = rows.map((row) => checkRow(section, row));
      const sql = sqlFor(section);
      backend.transaction(() => {
        for (const { k1, params } of checked) {
          if (backend.run(sql, params).changes === 0) {
            fail("TRANSFER_STATE_INVALID", duplicateMessage(backend, section, k1));
          }
        }
      });
      counts[name] = (counts[name] ?? 0) + rows.length;
      progress(name, counts[name]);
    },

    /** In-memory payload variant: same checks, batched. */
    stageArray(name, rows) {
      present.add(name);
      for (let i = 0; i < rows.length; i += PAGE) handle.stageRows(name, rows.slice(i, i + PAGE));
    },

    /**
     * Finish staging against the incoming head: typed non-array failure,
     * retain-fill of absent sections, then paged validation of every staged
     * row. Returns this handle (the preflight plan's `instanceSections`).
     */
    prepare(_db, head, refs) {
      const absent = [];
      for (const section of SECTIONS) {
        if (present.has(section.name)) continue;
        if (Object.hasOwn(head, section.name)) {
          if (head[section.name] !== undefined && !Array.isArray(head[section.name])) {
            fail("TRANSFER_STATE_INVALID", `${section.name} must be an array`);
          }
          present.add(section.name); // explicit clear
        } else absent.push(section);
      }
      if (absent.length) {
        backend.setRefs(refs);
        for (const section of absent) backend.retain(db, section);
      }
      validateStaged(refs);
      return handle;
    },

    /** Insert every section into the live tables (inside the caller's transaction). */
    apply(applyDb = db) {
      for (const section of SECTIONS) backend.apply(applyDb, section);
    },

    size: () => backend.size(),
    close: () => backend.close(),
  };
  return handle;
}

/**
 * Open a stage in `dir` for `db`. Resolves the stage handle; the caller must
 * `close()` it (DETACH / free) outside any transaction, then remove `dir`.
 */
export async function openStage(db, dir) {
  if (db.driver === "sql.js") {
    const { sqlJsBackend } = await import("./importStageSqljs.js");
    return createStage(db, await sqlJsBackend());
  }
  return createStage(db, nativeBackend(db, dir));
}

export { PAGE as STAGE_PAGE, SET_NULL_SECTIONS };
