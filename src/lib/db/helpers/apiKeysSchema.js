// Cache only main.apiKeys' keyHash shape, never marker, root or auth state.
const schemas = new WeakMap();

export function clearApiKeysSchemaCache(db) {
  schemas.delete(db);
}

export function apiKeysHasKeyHash(db) {
  try {
    const schemaVersion = db.get("PRAGMA main.schema_version")?.schema_version;
    const valid = Number.isSafeInteger(schemaVersion) && schemaVersion >= 0;
    const cached = schemas.get(db);
    if (valid && cached?.schemaVersion === schemaVersion) return cached.hasKeyHash;
    schemas.delete(db);
    const hasKeyHash = db.all("PRAGMA main.table_info(apiKeys)").some((c) => c.name === "keyHash");
    if (valid) schemas.set(db, { schemaVersion, hasKeyHash });
    return hasKeyHash;
  } catch (error) {
    schemas.delete(db);
    throw error;
  }
}
