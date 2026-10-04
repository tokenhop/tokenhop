// YAN-363 durable API-key storage marker (inert reader, no activation).
// Strict sync read of the `_meta.apiKeysHashedVersion` / `apiKeysHashKid`
// pair. No feature-switch, barrel, session, or DB imports: this module must
// stay cycle-free so migrations, repos, and guards can all read it.
export function readApiKeyStorageState(db) {
  const version =
    db.get(`SELECT value FROM _meta WHERE key = ?`, ["apiKeysHashedVersion"])?.value ?? null;
  const hashKid =
    db.get(`SELECT value FROM _meta WHERE key = ?`, ["apiKeysHashKid"])?.value ?? null;
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
