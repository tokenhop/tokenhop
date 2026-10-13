import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { makeSentinels } from "./secretScan.js";

export const SENT = makeSentinels();
// Real stored hash of the seeded gateway key, so the hash is an exact sentinel.
export const SCAN = {
  ...SENT,
  gatewayKeyHash: hashApiKey(
    SENT.gatewayKey,
    deriveApiKeyHashKey(Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256))),
  ),
};
export const NO_LEAKS = "no credential material may reach this surface";
export const NOW = "2026-10-13T00:00:00.000Z";
export const MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));
export const KID = masterKeyId(MASTER);
// Hashed apiKeys fixture shape (migrations ship the legacy raw-key table).
export const HASHED_KEYS_TABLE = `CREATE TABLE apiKeys (
  id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  userId TEXT REFERENCES users(id) ON DELETE CASCADE,
  createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
  keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
  machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
  revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
  expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`;
