-- A tokenhop v1.0.0 database as that release left it: schema stamped 3 by the
-- old chain (001-initial, 002-cursor-refresh-backfill, 003-pin-saml-issuer),
-- plus the old SCHEMA_VERSION backup marker. Frozen: do not edit.
CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
CREATE TABLE providerConnections (id TEXT PRIMARY KEY, provider TEXT NOT NULL, authType TEXT NOT NULL, name TEXT, email TEXT, priority INTEGER, isActive INTEGER DEFAULT 1, data TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE INDEX idx_pc_provider ON providerConnections(provider);
CREATE INDEX idx_pc_provider_active ON providerConnections(provider, isActive);
CREATE INDEX idx_pc_priority ON providerConnections(provider, priority);
CREATE TABLE providerNodes (id TEXT PRIMARY KEY, type TEXT, name TEXT, data TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE INDEX idx_pn_type ON providerNodes(type);
CREATE TABLE proxyPools (id TEXT PRIMARY KEY, isActive INTEGER DEFAULT 1, testStatus TEXT, data TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE INDEX idx_pp_active ON proxyPools(isActive);
CREATE INDEX idx_pp_status ON proxyPools(testStatus);
CREATE TABLE apiKeys (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT, isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL);
CREATE INDEX idx_ak_key ON apiKeys(key);
CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, kind TEXT, models TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE INDEX idx_combo_name ON combos(name);
CREATE TABLE kv (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (scope, key));
CREATE INDEX idx_kv_scope ON kv(scope);
CREATE TABLE usageHistory (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, provider TEXT, model TEXT, connectionId TEXT, apiKey TEXT, endpoint TEXT, promptTokens INTEGER DEFAULT 0, completionTokens INTEGER DEFAULT 0, cost REAL DEFAULT 0, status TEXT, tokens TEXT, meta TEXT);
CREATE INDEX idx_uh_ts ON usageHistory(timestamp DESC);
CREATE INDEX idx_uh_provider ON usageHistory(provider);
CREATE INDEX idx_uh_model ON usageHistory(model);
CREATE INDEX idx_uh_conn ON usageHistory(connectionId);
CREATE TABLE usageDaily (dateKey TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE requestDetails (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, provider TEXT, model TEXT, connectionId TEXT, status TEXT, data TEXT NOT NULL);
CREATE INDEX idx_rd_ts ON requestDetails(timestamp DESC);
CREATE INDEX idx_rd_provider ON requestDetails(provider);
CREATE INDEX idx_rd_model ON requestDetails(model);
CREATE INDEX idx_rd_conn ON requestDetails(connectionId);

INSERT INTO _meta(key, value) VALUES ('schemaVersion', '3'), ('backupSchemaVersion', '1'), ('appVersion', '1.0.0');
INSERT INTO settings(id, data) VALUES (1, '{"requireLogin":true,"samlIssuer":"9router"}'); -- legacy(9router): issuer pinned by 003
INSERT INTO providerConnections(id, provider, authType, name, priority, isActive, data, createdAt, updatedAt)
  VALUES ('pc1', 'openai', 'apikey', 'work', 1, 1, '{"apiKey":"sk-test"}', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
INSERT INTO apiKeys(id, key, name, isActive, createdAt) VALUES ('k1', 'sk-th-legacy', 'laptop', 1, '2026-10-01T00:00:00Z');
INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES
  ('c1', 'fast', NULL, '["openai/gpt-5"]', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'),
  ('c2', 'smart', NULL, '["openai/gpt-5-pro"]', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
INSERT INTO kv(scope, key, value) VALUES ('modelAliases', 'gpt', '"openai/gpt-5"');
INSERT INTO usageHistory(timestamp, provider, model, promptTokens, completionTokens) VALUES ('2026-10-01T00:00:00Z', 'openai', 'gpt-5', 10, 20);
INSERT INTO requestDetails(id, timestamp, provider, data) VALUES ('rd1', '2026-10-01T00:00:00Z', 'openai', '{}');
