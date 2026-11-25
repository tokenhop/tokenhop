// Usage hub management keys (YAN-2019). Read-only keys T3 Code sends to the
// CLIProxyAPI-compatible hub routes; they never authorize /v1 or a dashboard
// route. Instance-level and owner/admin managed (the routes check
// instance.settings.manage), so these helpers are *Unscoped by design.
// The raw key is returned only by create; storage holds its SHA-256 hash and
// a display prefix. Revoked rows stay as tombstones (lookups skip them).
import { createHash, randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { TenancyError } from "@/lib/users/errors.js";

export const HUB_KEY_PREFIX = "thm_";
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BODY_LEN = 32;
// Exact shape only: anything else is rejected before hashing or a DB read.
const KEY_SHAPE = /^thm_[A-Za-z0-9]{32}$/;
export const MAX_ACTIVE_HUB_KEYS = 20;
export const MAX_HUB_KEY_NAME = 64;
// lastUsedAt is display-only: write it at most once a minute per key.
const TOUCH_MS = 60_000;

const PUBLIC_COLS = "id, prefix, name, createdAt, lastUsedAt";

/** A fresh raw hub key: `thm_` + 32 base62 chars (unbiased, ~190 bits). */
export function generateHubKey() {
  let body = "";
  while (body.length < BODY_LEN) {
    for (const byte of randomBytes(BODY_LEN - body.length)) {
      if (byte < 248) body += ALPHABET[byte % 62];
    }
  }
  return HUB_KEY_PREFIX + body;
}

export function hashHubKey(raw) {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Display prefix: `thm_abcd…wxyz`. Never enough to reconstruct the key. */
export function hubKeyPrefix(raw) {
  return `${raw.slice(0, 8)}…${raw.slice(-4)}`;
}

export function isHubKeyShape(raw) {
  return typeof raw === "string" && KEY_SHAPE.test(raw);
}

function normalizeName(name) {
  if (name === undefined || name === null) return null;
  if (typeof name !== "string") throw new TenancyError("INVALID", "Invalid key name");
  const trimmed = name.trim();
  const hasControl = [...trimmed].some((ch) => {
    const code = ch.codePointAt(0);
    return code < 0x20 || code === 0x7f;
  });
  if (trimmed.length > MAX_HUB_KEY_NAME || hasControl) {
    throw new TenancyError("INVALID", "Invalid key name");
  }
  return trimmed || null;
}

/**
 * Mint a hub key. Returns the raw key once, plus public metadata.
 * @param {{ name?: string|null, createdByUserId?: string|null }} input
 */
export async function createHubKeyUnscoped({ name = null, createdByUserId = null } = {}) {
  const cleanName = normalizeName(name);
  const db = await getAdapter();
  const raw = generateHubKey();
  const row = {
    id: uuidv4(),
    keyHash: hashHubKey(raw),
    prefix: hubKeyPrefix(raw),
    name: cleanName,
    createdAt: new Date().toISOString(),
  };
  db.transaction(() => {
    const { n } = db.get(`SELECT COUNT(*) AS n FROM hubKeys WHERE revokedAt IS NULL`);
    if (n >= MAX_ACTIVE_HUB_KEYS) throw new TenancyError("LIMIT", "Too many active hub keys");
    // The creator may be a pre-users session or local owner with no users row.
    const creator =
      createdByUserId && db.get(`SELECT id FROM users WHERE id = ?`, [createdByUserId])
        ? createdByUserId
        : null;
    db.run(
      `INSERT INTO hubKeys(id, keyHash, prefix, name, createdByUserId, createdAt, lastUsedAt, revokedAt) VALUES(?, ?, ?, ?, ?, ?, NULL, NULL)`,
      [row.id, row.keyHash, row.prefix, row.name, creator, row.createdAt],
    );
  });
  return {
    key: raw,
    metadata: {
      id: row.id,
      prefix: row.prefix,
      name: row.name,
      createdAt: row.createdAt,
      lastUsedAt: null,
    },
  };
}

/** Active keys, oldest first. Metadata only: never the hash. */
export async function listHubKeysUnscoped() {
  const db = await getAdapter();
  return db.all(
    `SELECT ${PUBLIC_COLS} FROM hubKeys WHERE revokedAt IS NULL ORDER BY createdAt ASC, id ASC`,
  );
}

/** Revoke an active key. True when this call revoked it. Takes effect at once. */
export async function revokeHubKeyUnscoped(id) {
  if (typeof id !== "string" || !id) return null;
  const db = await getAdapter();
  let revoked = null;
  db.transaction(() => {
    const row = db.get(`SELECT ${PUBLIC_COLS} FROM hubKeys WHERE id = ? AND revokedAt IS NULL`, [
      id,
    ]);
    if (!row) return;
    db.run(`UPDATE hubKeys SET revokedAt = ? WHERE id = ? AND revokedAt IS NULL`, [
      new Date().toISOString(),
      id,
    ]);
    revoked = row;
  });
  return revoked;
}

export async function countActiveHubKeysUnscoped() {
  const db = await getAdapter();
  return db.get(`SELECT COUNT(*) AS n FROM hubKeys WHERE revokedAt IS NULL`).n;
}

/**
 * Resolve a presented raw key to its active row `{ id, prefix }`, or null.
 * Malformed input never reaches the DB. Touches lastUsedAt (throttled).
 */
export async function findActiveHubKeyUnscoped(raw) {
  if (!isHubKeyShape(raw)) return null;
  const db = await getAdapter();
  const row = db.get(
    `SELECT id, prefix, lastUsedAt FROM hubKeys WHERE keyHash = ? AND revokedAt IS NULL`,
    [hashHubKey(raw)],
  );
  if (!row) return null;
  const now = Date.now();
  const last = row.lastUsedAt ? Date.parse(row.lastUsedAt) : 0;
  if (!Number.isFinite(last) || now - last >= TOUCH_MS) {
    try {
      db.run(`UPDATE hubKeys SET lastUsedAt = ? WHERE id = ?`, [
        new Date(now).toISOString(),
        row.id,
      ]);
    } catch {
      // Display-only bookkeeping never fails an authenticated read.
    }
  }
  return { id: row.id, prefix: row.prefix };
}
