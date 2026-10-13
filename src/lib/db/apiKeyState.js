// YAN-363 durable API-key storage marker (inert reader, no activation).
// Strict sync read of the `_meta.apiKeysHashedVersion` / `apiKeysHashKid`
// pair. No feature-switch, barrel, session, or DB imports: this module must
// stay cycle-free so migrations, repos, and guards can all read it.

/**
 * One-SELECT `_meta` batch read. `keys` must be code constants (placeholders
 * are generated, values always bound). Absent rows read as null.
 * @returns {Record<string, string|null>}
 */
export function readMetaValues(db, keys) {
  const out = Object.fromEntries(keys.map((k) => [k, null]));
  const rows = db.all(
    `SELECT key, value FROM _meta WHERE key IN (${keys.map(() => "?").join(",")})`,
    keys,
  );
  for (const { key, value } of rows) out[key] = value ?? null;
  return out;
}

export function readApiKeyStorageState(db) {
  const { apiKeysHashedVersion: version, apiKeysHashKid: hashKid } = readMetaValues(db, [
    "apiKeysHashedVersion",
    "apiKeysHashKid",
  ]);
  if (version === null && hashKid === null)
    return { storage: "legacy", version: null, hashKid: null };
  if (version === "1" && typeof hashKid === "string" && /^[0-9a-f]{16}$/.test(hashKid)) {
    return { storage: "hashed", version: 1, hashKid };
  }
  const err = new Error(
    `Invalid API key storage state: apiKeysHashedVersion=${version} apiKeysHashKid=${hashKid}`,
  );
  err.code = "API_KEY_STATE_INVALID";
  throw err;
}
