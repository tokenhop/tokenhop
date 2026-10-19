// sql.js stage backend (YAN-1013). ATTACH is unsafe on sql.js (persist() →
// db.export() reopens the DB and drops attachments), so the stage is a SEPARATE
// in-memory SQL.Database and rows are copied through JS. This is the
// documented exception: bounded memory is NOT guaranteed on sql.js.
import initSqlJs from "sql.js";
import { SECTIONS } from "../helpers/instanceSnapshotSchema.js";
import { SET_NULL_SECTIONS, STAGE_PAGE, q, stageDdl } from "./importStage.js";
import { forEachBoundedPage, forEachBoundedSectionPage } from "./pagedRows.js";

let SQL = null;

export async function sqlJsBackend() {
  SQL ??= await initSqlJs();
  const stage = new SQL.Database();
  let refs = { users: new Set(), workspaces: new Set() };

  const bindable = (params) => (params?.length ? params : undefined);
  const run = (sql, params = []) => {
    const stmt = stage.prepare(sql);
    try {
      stmt.bind(bindable(params));
      stmt.step();
      return { changes: stage.getRowsModified() };
    } finally {
      stmt.free();
    }
  };
  const all = (sql, params = []) => {
    const stmt = stage.prepare(sql);
    try {
      stmt.bind(bindable(params));
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  };

  for (const s of SECTIONS) stage.exec(stageDdl(q(s.name), s));

  return {
    table: q,
    run,
    all,
    get: (sql, params = []) => all(sql, params)[0],
    transaction(fn) {
      const sp = `sp_${Math.random().toString(36).slice(2)}`;
      stage.exec(`SAVEPOINT ${sp}`);
      try {
        const result = fn();
        stage.exec(`RELEASE ${sp}`);
        return result;
      } catch (error) {
        try {
          stage.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
        } catch {}
        throw error;
      }
    },
    setRefs(next) {
      refs = next;
    },
    retain(db, section) {
      const cols = section.columns;
      const sql = `INSERT INTO ${q(section.name)}(k1, k2, absent, ${cols.map(q).join(", ")}) VALUES(NULL, NULL, NULL, ${cols.map(() => "?").join(", ")})`;
      const nullify = SET_NULL_SECTIONS.has(section.name);
      forEachBoundedSectionPage(db, section, STAGE_PAGE, (rows) => {
        stage.exec("SAVEPOINT retain");
        try {
          for (const r of rows) {
            if (nullify) {
              r.workspaceId =
                r.workspaceId && refs.workspaces.has(r.workspaceId) ? r.workspaceId : null;
              r.userId = r.userId && refs.users.has(r.userId) ? r.userId : null;
            }
            run(
              sql,
              cols.map((c) => r[c] ?? null),
            );
          }
          stage.exec("RELEASE retain");
        } catch (error) {
          try {
            stage.exec("ROLLBACK TO retain; RELEASE retain");
          } catch {}
          throw error;
        }
      });
    },
    apply(db, section) {
      const cols = section.columns;
      const sql = `INSERT INTO ${q(section.name)}(${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
      forEachBoundedPage(
        all,
        { table: q(section.name), key: "seq", columns: section.columns, pageSize: STAGE_PAGE },
        (rows) => {
          for (const r of rows) {
            db.run(
              sql,
              cols.map((c) => r[c] ?? section.defaults?.[c] ?? null),
            );
          }
        },
      );
    },
    size: () => 0,
    close() {
      try {
        stage.close();
      } catch {}
    },
  };
}
