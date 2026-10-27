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
import { assertImportDiskSpace } from "../diskPreflight.js";
import { forEachBoundedPage, sizeExpr } from "./pagedRows.js";

const PAGE = 500;
const SMALL_PAGE = 200; // requestDetails rows carry large `data`
const SET_NULL_SECTIONS = new Set(["usageHistory", "requestDetails"]);
const DERIVED_SECTIONS = new Set(["usageComboRollup"]);

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

// Retained usageBudgetCarry (YAN-424): attribution naming a workspace/user the
// snapshot replaces moves to '' and rows that then share the primary key are
// summed — SQL GROUP BY in first-occurrence (rowid) order. SQLite's SUM() of
// REALs is compensated while the original JS path adds left to right, so the
// REAL totals of merged groups are recomputed in JS to stay bit-identical.
// Integer SUM() (tokens/requests) raises on 64-bit overflow where JS would lose
// precision; real counters are far below 2^63, so that edge is not handled.
function retainBudgetCarryNative(db, stageTable, section) {
  const cols = section.columns.map(q).join(", ");
  const W = `CASE WHEN "workspaceId" <> '' AND "workspaceId" IN (SELECT id FROM xstage._refWorkspaces) THEN "workspaceId" ELSE '' END`;
  const U = `CASE WHEN "userId" <> '' AND "userId" IN (SELECT id FROM xstage._refUsers) THEN "userId" ELSE '' END`;
  const live = `main.${q(section.name)}`;
  db.run(
    `INSERT INTO ${stageTable}(k1, k2, absent, ${cols}) SELECT NULL, NULL, NULL, "day", ${W} AS __w, ${U} AS __u, "apiKeyId", "grantId", SUM("usd"), SUM("tokens"), SUM("requests"), SUM("notionalUsd") FROM ${live} GROUP BY "day", __w, __u, "apiKeyId", "grantId" ORDER BY MIN(rowid)`,
  );
  const merged = db.all(
    `SELECT "day", ${W} AS __w, ${U} AS __u, "apiKeyId", "grantId" FROM ${live} GROUP BY "day", __w, __u, "apiKeyId", "grantId" HAVING COUNT(*) > 1`,
  );
  // Without an index each per-group UPDATE below scans the whole stage table
  // (O(groups x rows)); index the five dimensions it matches on first.
  if (merged.length > 0) {
    db.exec(
      `CREATE INDEX xstage."idx_stage_carry_dims" ON ${q(section.name)}("day", "workspaceId", "userId", "apiKeyId", "grantId")`,
    );
  }
  for (const g of merged) {
    const key = [g.day, g.__w, g.__u, g.apiKeyId, g.grantId];
    const parts = db.all(
      `SELECT "usd", "notionalUsd" FROM ${live} WHERE "day" = ? AND ${W} = ? AND ${U} = ? AND "apiKeyId" = ? AND "grantId" = ? ORDER BY rowid`,
      key,
    );
    let usd = parts[0].usd;
    let notionalUsd = parts[0].notionalUsd;
    for (let i = 1; i < parts.length; i++) {
      usd += parts[i].usd || 0;
      notionalUsd += parts[i].notionalUsd || 0;
    }
    db.run(
      `UPDATE ${stageTable} SET "usd" = ?, "notionalUsd" = ? WHERE "day" = ? AND "workspaceId" = ? AND "userId" = ? AND "apiKeyId" = ? AND "grantId" = ?`,
      [usd, notionalUsd, ...key],
    );
  }
}

function nativeBackend(db, dir) {
  const file = path.join(dir, "stage.sqlite");
  if (file.includes("\0")) throw new Error("Invalid staging path");
  fs.closeSync(openPrivateFileSync(file)); // private (0600) before SQLite touches it
  // Imports are serialized process-wide (transferLock), so an attached xstage is
  // a leak from a failed close — never another import's live stage.
  if (db.all("PRAGMA database_list").some((r) => r.name === "xstage")) {
    db.exec("DETACH DATABASE xstage");
  }
  db.exec(`ATTACH DATABASE '${file.replace(/'/g, "''")}' AS xstage`);
  const table = (name) => `xstage.${q(name)}`;
  const backend = {
    onDisk: true,
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
      if (section.name === "usageBudgetCarry") {
        retainBudgetCarryNative(db, table(section.name), section);
        return;
      }
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

  // Estimated bytes of the live rows an absent section will copy into the stage.
  function retainedBytes(sections) {
    let total = 0;
    for (const section of sections) {
      const row = db.get(
        `SELECT COALESCE(SUM(${sizeExpr(section.columns)}), 0) AS n FROM main.${q(section.name)}`,
      );
      total += Number(row?.n) || 0;
    }
    return total;
  }

  function validateStaged(refs) {
    for (const section of SECTIONS) {
      let seen = 0;
      forEachBoundedPage(
        (sql, params) => backend.all(sql, params),
        {
          table: backend.table(section.name),
          key: "seq",
          columns: section.columns,
          pageSize: pageSizeOf(section),
        },
        (rows) => {
          for (const rec of rows)
            validateSectionRow(section, rowFromStage(section, rec), refs, NOOP_SEEN);
          seen += rows.length;
          progress(section.name, seen);
        },
      );
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
      let absent = [];
      for (const section of SECTIONS) {
        if (present.has(section.name)) continue;
        if (Object.hasOwn(head, section.name)) {
          if (head[section.name] !== undefined && !Array.isArray(head[section.name])) {
            fail("TRANSFER_STATE_INVALID", `${section.name} must be an array`);
          }
          present.add(section.name); // explicit clear
        } else absent.push(section);
      }
      // YAN-1226: derived combo rows are never retained when the snapshot
      // replaces usageRollup; apply recomputes them from restored history.
      if (present.has("usageRollup")) {
        for (const section of absent.filter((s) => DERIVED_SECTIONS.has(s.name))) {
          present.add(section.name);
        }
      }
      absent = absent.filter((s) => !present.has(s.name));
      if (absent.length) {
        // Retained live rows are copied into the stage: the disk may have
        // filled since the upload-time check. Fail coded, before copying.
        if (backend.onDisk) {
          assertImportDiskSpace({
            phase: "staging",
            incomingBytes: retainedBytes(absent),
          });
        }
        backend.setRefs(refs);
        for (const section of absent) backend.retain(db, section);
      }
      validateStaged(refs);
      return handle;
    },

    /** Drop staged rows of one section (derived data recomputed at apply). */
    clearStaged(name) {
      backend.run(`DELETE FROM ${backend.table(name)}`);
    },

    /**
     * True when staged usageRollup rows predate the savings columns. A staged
     * row's `absent` list records the columns its source row never carried,
     * so post-021 rows that merely defaulted a column at bind time (absent =
     * NULL) are not mistaken for pre-021 rows.
     */
    hasSavingsGaps() {
      if (!present.has("usageRollup")) return false;
      const t = backend.table("usageRollup");
      // One bounded aggregate: no staged row may reach the JS heap.
      const r = backend.get(
        `SELECT EXISTS(SELECT 1 FROM ${t}) AS anyRow,
                EXISTS(SELECT 1 FROM ${t} WHERE absent IS NULL OR instr(absent, '"savingsSavedEst"') = 0) AS hasFull`,
      );
      return !!r?.anyRow && !r.hasFull;
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
