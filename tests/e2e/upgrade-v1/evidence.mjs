// Storage/backup proof through in-container stdlib. Never reads real host DB.
import assert from "node:assert/strict";
import { check, secrets, sleep } from "./core.mjs";

export const MARKERS_SQL =
  "SELECT key,value FROM _meta WHERE key IN ('apiKeysHashedVersion','credentialsEncryptedVersion') ORDER BY key";
// backupDbLite copies TABLE row payloads deliberately without indexes,
// triggers or views (BACKUP_EXCLUDE_TABLES covers requestDetails too): a
// backup snapshot must match on table shells only. Restored-DB comparisons
// additionally pin table counts on the complete (index/trigger-inclusive) rows.
export const TABLE_SHELL_SQL =
  "SELECT name,tbl_name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
export const SCHEMA_SQL =
  "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
export function tableShells(rows) {
  return rows
    .filter((r) => r.type === "table")
    .map(({ name, tbl_name, sql }) => ({
      name,
      tbl_name,
      sql,
    }));
}
export const markers = (h, app) => h.dbRead(app, MARKERS_SQL);
export async function waitRows(h, app, count) {
  for (let i = 0; i < 100; i++) {
    const n = h.dbRead(app, "SELECT COUNT(*) n FROM usageHistory")[0].n;
    if (n === count) return;
    assert(n <= count, `unexpected usage rows ${n} > ${count}`);
    await sleep(100);
  }
  throw new Error(`${app.name}: usage write timeout expected=${count}`);
}
export function byteScan(h, app, values) {
  return JSON.parse(
    h.command(
      app,
      `import fs from 'node:fs'; const values=${JSON.stringify(values)}; const out={}; for(const name of ['data.sqlite','data.sqlite-wal']) { const p='/app/data/db/'+name; const b=fs.existsSync(p)?fs.readFileSync(p):Buffer.alloc(0); out[name]=values.map(v=>b.includes(Buffer.from(v))); } console.log(JSON.stringify(out));`,
    ),
  );
}
export function logicalScan(h, app, values) {
  return JSON.parse(
    h.command(
      app,
      `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync('/app/data/db/data.sqlite',{readOnly:true}); const values=${JSON.stringify(values)}; let found=false; const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all(); function scan(v){if(typeof v==='string') return values.some(s=>v.includes(s)); if(v instanceof Uint8Array) return values.some(s=>Buffer.from(v).includes(Buffer.from(s))); if(v&&typeof v==='object')return Object.values(v).some(scan);return false;} for(const {name} of tables) if(db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"').all().some(scan))found=true; console.log(found); db.close();`,
    ),
  );
}
export function storageEvidence(h, app, keys, encrypted) {
  const values = [...secrets, ...keys];
  const bytes = byteScan(h, app, values);
  const found = Object.values(bytes).some((list) => list.some(Boolean));
  check(
    encrypted
      ? "no plaintext credentials in live DB/WAL bytes"
      : "pre-upgrade plaintext positive control",
    encrypted ? !found : values.every((_s, i) => Object.values(bytes).some((l) => l[i])),
    JSON.stringify(bytes),
  );
  check(
    encrypted
      ? "no plaintext TEXT/BLOB credentials in live rows"
      : "pre-upgrade logical positive control",
    logicalScan(h, app, values) === !encrypted,
  );
  if (encrypted) {
    const conn = JSON.parse(
      h.dbRead(app, "SELECT data FROM providerConnections ORDER BY id")[0].data,
    ).apiKey;
    check(
      "provider credential authenticated envelope",
      conn?.v === 1 &&
        typeof conn.iv === "string" &&
        typeof conn.ct === "string" &&
        typeof conn.tag === "string",
    );
    const keysStored = h.dbRead(app, "SELECT keyHash FROM apiKeys");
    check(
      "gateway credentials are hashes",
      keysStored.length >= 2 && keysStored.every((k) => /^[0-9a-f]{64}$/.test(k.keyHash)),
    );
  }
}
export function backupInfo(h, app, prefix = "gateway-key-activation-") {
  return JSON.parse(
    h.command(
      app,
      `import fs from 'node:fs'; import {DatabaseSync} from 'node:sqlite'; const root='/app/data/db/backups'; const names=fs.readdirSync(root).filter(n=>n.startsWith(${JSON.stringify(prefix)})).sort(); const out=names.map(name=>{const dir=root+'/'+name;const file=dir+'/data.sqlite';const db=new DatabaseSync(file,{readOnly:true});const markers=db.prepare("SELECT key,value FROM _meta WHERE key IN ('apiKeysHashedVersion','credentialsEncryptedVersion') ORDER BY key").all();const keys=db.prepare('SELECT COUNT(*) n FROM apiKeys').get().n;const integrity=db.prepare('PRAGMA integrity_check').get().integrity_check;db.close();return {name,markers,keys,integrity,dirMode:fs.statSync(dir).mode&511,fileMode:fs.statSync(file).mode&511};});console.log(JSON.stringify(out));`,
    ),
  );
}
export function privateRoot(h, app) {
  const modes = JSON.parse(
    h.command(
      app,
      "import fs from 'node:fs'; console.log(JSON.stringify(['keys','keys/master'].map(p=>fs.statSync('/app/data/'+p).mode&511)));",
    ),
  );
  check(
    "master directory/file modes 0700/0600",
    JSON.stringify(modes) === JSON.stringify([0o700, 0o600]),
  );
}
export function seedTotals(h, app, count) {
  const rows = h.dbRead(
    app,
    "SELECT model,COUNT(*) n,SUM(promptTokens) pin,SUM(completionTokens) pout FROM usageHistory GROUP BY model",
  );
  check(
    "exact per-model/token totals",
    rows.length === 1 &&
      rows[0].model === "gpt-4o-mini" &&
      rows[0].n === count &&
      rows[0].pin === count * 7 &&
      rows[0].pout === count * 3,
    JSON.stringify(rows),
  );
  // Published 1.0.3 records raw key; master migration maps it to apiKeyId.
  const cols = h.dbRead(app, "PRAGMA table_info(usageHistory)").map((r) => r.name);
  const keyColumn = cols.includes("apiKeyId") ? "apiKeyId" : "apiKey";
  const keyRows = h.dbRead(
    app,
    `SELECT ${keyColumn},COUNT(*) n,SUM(promptTokens) pin,SUM(completionTokens) pout FROM usageHistory GROUP BY ${keyColumn}`,
  );
  check(
    "exact two per-key usage totals",
    keyRows.length === 2 &&
      keyRows.every(
        (r) => r.n === count / 2 && r.pin === (count / 2) * 7 && r.pout === (count / 2) * 3,
      ),
    JSON.stringify(keyRows.map(({ n, pin, pout }) => ({ n, pin, pout }))),
  );
}
