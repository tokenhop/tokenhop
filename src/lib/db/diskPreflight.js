// Synchronous disk-space preflight for instance snapshot import (D14).
// Pure arithmetic over injectable probes (see stagingFiles.__setFreeBytesProbeForTests);
// no DB access, so it can sit inside the no-await window before the backup.
import fs from "node:fs";
import { BACKUPS_DIR, DATA_FILE, STAGING_DIR } from "./paths.js";
import { deviceOf, freeBytes } from "./stagingFiles.js";

export const IMPORT_DISK_INSUFFICIENT = "IMPORT_DISK_INSUFFICIENT";

const MIB = 1024 * 1024;
const MIN_MARGIN_BYTES = 32 * MIB;
const MARGIN_FRACTION = 0.02;
const MAX_MESSAGE_CHARS = 300;
// Staged row JSON text plus the UNIQUE(k1)/UNIQUE(k2) indexes and per-row
// overhead make the stage file larger than the uploaded document.
const STAGE_OVERHEAD = 1.6;
// Export file vs. live DB: JSON escaping/keys can outgrow SQLite's packing.
const EXPORT_OVERHEAD = 1.25;
export const EXPORT_DISK_INSUFFICIENT = "EXPORT_DISK_INSUFFICIENT";

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function nonNegative(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** margin = max(32 MiB, 2% of the bytes being reserved on that filesystem). */
export function diskMargin(bytes) {
  return Math.max(MIN_MARGIN_BYTES, Math.ceil(nonNegative(bytes) * MARGIN_FRACTION));
}

/**
 * Per-component byte needs for an import phase.
 *  - "staging": before the body is read. stage = ceil(incomingBytes * 1.6), wal = incomingBytes.
 *  - "backup": right before the pre-import backup. stage is already on disk (0);
 *    wal = actual stage size (stageBytes).
 * @param {{ phase: "staging" | "backup", incomingBytes?: number, stageBytes?: number, dbFootprint?: number }} p
 * @returns {{ backup: number, stage: number, wal: number }}
 */
export function computeImportNeeds({ phase, incomingBytes = 0, stageBytes = 0, dbFootprint = 0 }) {
  if (phase !== "staging" && phase !== "backup") {
    throw new Error(`Unknown import disk phase: ${String(phase)}`);
  }
  const footprint = nonNegative(dbFootprint);
  if (phase === "staging") {
    const incoming = nonNegative(incomingBytes);
    return { backup: footprint, stage: Math.ceil(incoming * STAGE_OVERHEAD), wal: incoming };
  }
  return { backup: footprint, stage: 0, wal: nonNegative(stageBytes) };
}

/**
 * Group needs by filesystem. The backup copy and WAL growth both land under DB_DIR
 * (BACKUPS_DIR is its child, so one device); staging may sit on another device.
 * Same device: requirements are summed; otherwise each is checked on its own.
 * @param {{ backup: number, stage: number, wal: number }} needs
 * @param {{ deviceOf?: (dir: string) => unknown }} [probes]
 * @returns {Array<{ dir: string, bytes: number }>}
 */
export function groupNeedsByDevice(needs, { deviceOf: devOf = deviceOf } = {}) {
  const parts = [
    { dir: BACKUPS_DIR, bytes: needs.backup + needs.wal },
    { dir: STAGING_DIR, bytes: needs.stage },
  ];
  const groups = new Map();
  for (const part of parts) {
    const dev = devOf(part.dir);
    // Unknown device: do not merge with anything else.
    const key = dev === null || dev === undefined ? `dir:${part.dir}` : `dev:${String(dev)}`;
    const g = groups.get(key);
    if (g) g.bytes += part.bytes;
    else groups.set(key, { dir: part.dir, bytes: part.bytes });
  }
  return [...groups.values()].filter((g) => g.bytes > 0);
}

function mib(bytes) {
  return Math.ceil(bytes / MIB);
}

function buildMessage(requiredBytes, free) {
  const head = `Not enough free disk space to import: about ${mib(requiredBytes)} MiB needed, ${Math.floor(
    free / MIB,
  )} MiB free.`;
  // Relative on purpose: the message reaches the client, never an absolute server path.
  const full = `${head} Free space (old pre-import backups are in db/backups/pre-import-*) and retry.`;
  return full.length <= MAX_MESSAGE_CHARS ? full : full.slice(0, MAX_MESSAGE_CHARS);
}

/**
 * Throw IMPORT_DISK_INSUFFICIENT when the import cannot fit. Synchronous.
 * Skipped (no throw) for any filesystem whose free space cannot be determined.
 * @param {{ phase: "staging" | "backup", incomingBytes?: number, stageBytes?: number }} opts
 */
export function assertImportDiskSpace({ phase, incomingBytes = 0, stageBytes = 0 }) {
  const dbFootprint = sizeOf(DATA_FILE) + sizeOf(`${DATA_FILE}-wal`);
  const needs = computeImportNeeds({ phase, incomingBytes, stageBytes, dbFootprint });

  for (const { dir, bytes } of groupNeedsByDevice(needs)) {
    const free = freeBytes(dir);
    if (free === null || free === undefined || !Number.isFinite(free)) continue;
    const requiredBytes = bytes + diskMargin(bytes);
    if (free < requiredBytes) {
      throw Object.assign(new Error(buildMessage(requiredBytes, free)), {
        code: IMPORT_DISK_INSUFFICIENT,
        requiredBytes,
        freeBytes: free,
      });
    }
  }
}

/**
 * Throw EXPORT_DISK_INSUFFICIENT when the export staging file cannot fit.
 * Synchronous; skipped when free space is unknown. Estimate: the live DB
 * (data file + WAL) with 25% headroom, plus the usual margin.
 */
export function assertExportDiskSpace() {
  const footprint = sizeOf(DATA_FILE) + sizeOf(`${DATA_FILE}-wal`);
  const bytes = Math.ceil(footprint * EXPORT_OVERHEAD);
  const free = freeBytes(STAGING_DIR);
  if (free === null || free === undefined || !Number.isFinite(free)) return;
  const requiredBytes = bytes + diskMargin(bytes);
  if (free < requiredBytes) {
    const message = `Not enough free disk space to stage the export: about ${mib(requiredBytes)} MiB needed, ${Math.floor(free / MIB)} MiB free. Free space and retry.`;
    throw Object.assign(new Error(message.slice(0, MAX_MESSAGE_CHARS)), {
      code: EXPORT_DISK_INSUFFICIENT,
      requiredBytes,
      freeBytes: free,
    });
  }
}
