import fs from "node:fs";
import path from "node:path";
import initSqlJs from "sql.js";
import { PRAGMA_SQL } from "../schema.js";
import { runShutdownFlushers } from "../shutdownFlushers.js";

let SQL = null;

async function loadSql() {
  if (SQL) return SQL;
  SQL = await initSqlJs();
  return SQL;
}

export async function createSqlJsAdapter(filePath) {
  const SQLLib = await loadSql();
  const buf = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
  const db = new SQLLib.Database(buf);
  db.exec(PRAGMA_SQL);
  // Schema is created/synced by migrate.js after adapter init

  let dirty = false;
  let saveTimer = null;
  const SAVE_DEBOUNCE_MS = 100;

  function persist(strict = false) {
    const data = Buffer.from(db.export());
    db.exec(PRAGMA_SQL); // export() reopens the DB, which resets the PRAGMAs
    // Write a sibling temp file, fsync, then rename over the target so a crash mid-write
    // never leaves a truncated DB. rename replaces an existing file on POSIX and Windows.
    // Unique per writer so two processes on one DATA_DIR never share a temp file.
    const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    let fd = null;
    try {
      fd = fs.openSync(tmpPath, "wx");
      fs.writeSync(fd, data, 0, data.length, 0);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmpPath, filePath);
      // Make the rename itself durable. Directories can't be fsynced on Windows.
      try {
        const dirFd = fs.openSync(path.dirname(filePath), "r");
        try {
          fs.fsyncSync(dirFd);
        } finally {
          fs.closeSync(dirFd);
        }
      } catch (e) {
        if (strict && process.platform !== "win32") throw e;
      }
    } catch (e) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {}
      throw e;
    }
    dirty = false;
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (dirty) {
        try {
          persist();
        } catch (e) {
          console.error("[sqljs] save failed:", e);
        }
      }
    }, SAVE_DEBOUNCE_MS);
  }

  function paramsObj(params) {
    if (!params || (Array.isArray(params) && params.length === 0)) return undefined;
    return params;
  }

  function run(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      stmt.step();
      const changes = db.getRowsModified();
      const lastInsertRowid =
        db.exec("SELECT last_insert_rowid() as id")[0]?.values?.[0]?.[0] ?? null;
      scheduleSave();
      return { changes, lastInsertRowid };
    } finally {
      stmt.free();
    }
  }

  function get(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      if (stmt.step()) return stmt.getAsObject();
      return undefined;
    } finally {
      stmt.free();
    }
  }

  function all(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  function exec(sql) {
    db.exec(sql);
    scheduleSave();
  }

  function transaction(fn) {
    const sp = `sp_${Math.random().toString(36).slice(2)}`;
    db.exec(`SAVEPOINT ${sp}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${sp}`);
      scheduleSave();
      return result;
    } catch (e) {
      try {
        db.exec(`ROLLBACK TO ${sp}`);
        db.exec(`RELEASE ${sp}`);
      } catch {}
      throw e;
    }
  }

  function close() {
    if (saveTimer) clearTimeout(saveTimer);
    try {
      if (dirty) persist();
    } finally {
      db.close();
    }
  }

  // Explicit durability gate: no swallowed persistence errors, no best-effort
  // shutdown flushers. Caller must drain repo buffers before activation.
  function flushSync() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    if (dirty) persist(true);
  }

  // Preserve existing best-effort shutdown behavior.
  const flush = () => {
    runShutdownFlushers();
    try {
      if (dirty) persist();
    } catch {}
  };
  process.on("beforeExit", flush);
  process.on("SIGINT", flush);
  process.on("SIGTERM", flush);

  // Backup bytes without `excludeTables`. ATTACH would write into sql.js's
  // in-memory FS, never to disk, so backups copy through a scratch DB instead.
  function snapshot(excludeTables = []) {
    const scratch = new SQLLib.Database(db.export());
    db.exec(PRAGMA_SQL); // export() reopens the DB, which resets the PRAGMAs
    try {
      for (const t of excludeTables) scratch.exec(`DROP TABLE IF EXISTS ${t}`);
      scratch.exec("VACUUM");
      return Buffer.from(scratch.export());
    } finally {
      scratch.close();
    }
  }

  return {
    driver: "sql.js",
    run,
    get,
    all,
    exec,
    transaction,
    close,
    snapshot,
    flushSync,
    raw: db,
  };
}
