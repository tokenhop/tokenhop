// DB safety backups — taken ONLY before a schema change (see migrate.js).
//
// ⚠️ AGENT/DEV NOTES:
// - Backups are a best-effort safety net before schema migrations. There is NO
//   automated restore path; recovery is manual (copy a backup file back).
// - Backups intentionally EXCLUDE the `requestDetails` table (observability log,
//   auto-pruned, non-critical) so a multi-hundred-MB DB backs up as a few MB.
// - Only the newest KEEP_BACKUPS are kept; older ones are pruned automatically.
// - Gateway-key activation backups (PROTECTED_PREFIX) are EXEMPT from that
//   auto-prune: they carry raw credentials predating the hashed switch-on and
//   have a manual retention/recovery contract (delete by hand once the
//   activated instance is verified).
import fs from "node:fs";
import path from "node:path";
import { BACKUPS_DIR, ensureDirs } from "./paths.js";
import { timestampSlug, getAppVersion } from "./version.js";

const KEEP_BACKUPS = 3;

// Never auto-pruned (raw-credential copies; manual retention, see header).
export const PROTECTED_BACKUP_PREFIX = "gateway-key-activation-";
export const PRE_IMPORT_BACKUP_PREFIX = "pre-import-";

// Tables excluded from safety backups (large, non-critical, reproducible).
const BACKUP_EXCLUDE_TABLES = ["requestDetails"];

export function makeBackupDir(label) {
  ensureDirs();
  const ver = getAppVersion();
  const slug = `${label}-${ver}-${timestampSlug()}`;
  const dir = path.join(BACKUPS_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Private backup dir for protected prefixes (activation, pre-import). */
export function makeProtectedBackupDir(prefix) {
  ensureDirs();
  const parent = fs.lstatSync(BACKUPS_DIR);
  if (!parent.isDirectory() || parent.isSymbolicLink())
    throw Object.assign(new Error("[db-backup] Backup directory must be a real directory"), {
      code: "BACKUP_DIR_INVALID",
    });
  const previousUmask = process.umask(0o077);
  try {
    const dir = fs.mkdtempSync(path.join(BACKUPS_DIR, prefix));
    fs.chmodSync(dir, 0o700);
    return dir;
  } finally {
    process.umask(previousUmask);
  }
}

// sql.js WASM init is async; the returned verifier is sync so snapshot → check
// → destructive txn never yields. Cached: one init per process.
let verifierPromise = null;

/** Resolve sql.js before the snapshot. Caller must not await again until the
 * destructive transaction has finished. */
export function prepareProtectedBackupVerifier() {
  verifierPromise ??= (async () => {
    const { default: initSqlJs } = await import("sql.js");
    const SQL = await initSqlJs();
    return (dir, file) => verifyProtectedBackupSync(SQL, dir, file);
  })();
  return verifierPromise;
}

function verifyProtectedBackupSync(SQL, dir, file) {
  fs.chmodSync(dir, 0o700);
  fs.chmodSync(file, 0o600);
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0)
      throw Object.assign(new Error("[db-backup] Empty or invalid backup"), {
        code: "BACKUP_INVALID",
      });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (process.platform !== "win32") {
    for (const target of [dir, BACKUPS_DIR]) {
      const directory = fs.openSync(target, "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    }
  }
  const ro = new SQL.Database(fs.readFileSync(file));
  try {
    const stmt = ro.prepare("PRAGMA quick_check");
    try {
      const row = stmt.step() ? stmt.getAsObject() : undefined;
      if (row?.quick_check !== "ok")
        throw Object.assign(new Error("[db-backup] Backup failed SQLite integrity check"), {
          code: "BACKUP_INVALID",
        });
    } finally {
      stmt.free();
    }
  } finally {
    ro.close();
  }
}

export function backupFile(srcPath, destDir, destName = null) {
  if (!fs.existsSync(srcPath)) return null;
  const name = destName || path.basename(srcPath);
  const dest = path.join(destDir, name);
  fs.copyFileSync(srcPath, dest);
  return dest;
}

// Lightweight DB backup via ATTACH: create an empty sqlite file, copy every
// table EXCEPT the excluded ones into it. Avoids duplicating the huge
// observability log, so the backup stays small regardless of DB size.
export function backupDbLite(adapter, destDir, destName = "data.sqlite", complete = false) {
  const dest = path.join(destDir, destName);
  try {
    fs.rmSync(dest, { force: true });
  } catch {}
  if (adapter.snapshot) {
    fs.writeFileSync(dest, adapter.snapshot(complete ? [] : BACKUP_EXCLUDE_TABLES));
    return dest;
  }
  const escaped = dest.replace(/'/g, "''");

  adapter.exec(`ATTACH DATABASE '${escaped}' AS bak`);
  // Copy order isn't FK order; the backup only needs the rows.
  adapter.exec("PRAGMA foreign_keys = OFF");
  try {
    const excluded = new Set(BACKUP_EXCLUDE_TABLES);
    const tables = adapter
      .all(
        `SELECT name, sql FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
      )
      .filter((t) => complete || !excluded.has(t.name));

    adapter.transaction(() => {
      for (const t of tables) {
        // Recreate table structure in backup DB, then copy rows.
        const createSql = t.sql.replace(/CREATE TABLE\s+/i, "CREATE TABLE bak.");
        adapter.exec(createSql);
        adapter.exec(`INSERT INTO bak.${t.name} SELECT * FROM main.${t.name}`);
      }
    });
  } finally {
    adapter.exec("PRAGMA foreign_keys = ON");
    try {
      adapter.exec("DETACH DATABASE bak");
    } catch {}
  }
  return dest;
}

export function pruneOldBackups() {
  if (!fs.existsSync(BACKUPS_DIR)) return;
  const entries = fs
    .readdirSync(BACKUPS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({
      name: e.name,
      full: path.join(BACKUPS_DIR, e.name),
      mtime: fs.statSync(path.join(BACKUPS_DIR, e.name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime)
    // Activation + pre-import copies are protected: KEEP_BACKUPS applies to
    // ordinary backups only, so a busy migration cadence can never delete the
    // last pre-activation or pre-import snapshot.
    .filter(
      (e) =>
        !e.name.startsWith(PROTECTED_BACKUP_PREFIX) && !e.name.startsWith(PRE_IMPORT_BACKUP_PREFIX),
    );

  for (const old of entries.slice(KEEP_BACKUPS)) {
    try {
      fs.rmSync(old.full, { recursive: true, force: true });
    } catch {}
  }
}
