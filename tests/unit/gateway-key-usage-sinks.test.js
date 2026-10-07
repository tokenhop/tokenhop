import crypto from "node:crypto";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import { saveRequestUsageUnscoped } from "@/lib/db/repos/usageRepo.js";
import { getUsageStats } from "@/lib/db/repos/usageStatsRepo.js";
import { insertHashedApiKeySync } from "@/lib/db/repos/apiKeysRepo.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import {
  getRequestDetailById,
  getRequestDetails,
  saveRequestDetailUnscoped,
} from "@/lib/db/repos/requestDetailsRepo.js";
import { TABLES, buildCreateTableSql } from "@/lib/db/schema.js";

const NOW = new Date(Date.now() - 60_000).toISOString();
const MASTER = crypto.randomBytes(32);
const KID = masterKeyId(MASTER);
const RAW = `th_${"A".repeat(32)}`;
const LATE_RAW = `sk-${"b".repeat(32)}`;
const digest = (raw) => hashApiKey(raw, deriveApiKeyHashKey(MASTER));

let db;
// YAN-370: the identity lives in usageHistory.apiKeyId; the raw-era apiKey
// column stays NULL, and the daily rollup is keyed by the same id.
const rollupKeys = () =>
  db
    .all("SELECT apiKeyId, model, provider, requests FROM usageRollup")
    .map((r) => `${r.apiKeyId}|${r.model}|${r.provider}`);
const entry = (patch = {}) => ({
  timestamp: NOW,
  provider: "openai",
  model: "gpt-4o",
  connectionId: null,
  endpoint: "/v1/chat",
  tokens: { prompt_tokens: 5, completion_tokens: 7 },
  status: "ok",
  ...patch,
});

function installHashedFixture() {
  db.exec("DELETE FROM memberships; DELETE FROM workspaces; DELETE FROM users");
  db.run(
    "INSERT INTO users(id, instanceRole, status, createdAt, updatedAt) VALUES ('u','user','active',?,?)",
    [NOW, NOW],
  );
  db.run("INSERT INTO workspaces(id,name,kind,createdAt,updatedAt) VALUES ('w','w','shared',?,?)", [
    NOW,
    NOW,
  ]);
  db.exec("DROP TABLE apiKeys");
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    userId TEXT REFERENCES users(id) ON DELETE CASCADE,
    createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
    keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
    machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
    revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
    expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
  db.run("INSERT INTO _meta(key,value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)", [
    KID,
  ]);
  insertHashedApiKeySync(db, {
    id: "known",
    workspaceId: "w",
    userId: null,
    createdByUserId: null,
    keyHash: digest(RAW),
    hashKid: KID,
    prefix: "th_AAAA…AAAA",
    name: "Known",
    machineId: null,
    legacy: 0,
    isActive: 1,
    revokedAt: null,
    allowedModels: [],
    allowedCombos: [],
    expiresAt: null,
    lastUsedAt: null,
    createdAt: NOW,
  });
}

beforeEach(async () => {
  db = await getAdapter();
  db.exec("DELETE FROM usageHistory");
  db.exec("DELETE FROM usageRollup");
  db.run("DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')");
});

afterEach(() => {
  delete process.env.TOKENHOP_MASTER_KEY;
});

describe("usage sinks under hashed storage", () => {
  beforeEach(() => {
    process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
    installHashedFixture();
  });

  it("explicit trusted apiKeyId is stored verbatim; raw never appears", async () => {
    await saveRequestUsageUnscoped(entry({ apiKeyId: "known", workspaceId: "w", userId: "u" }));
    expect(db.get("SELECT apiKey, apiKeyId, workspaceId, userId FROM usageHistory")).toEqual({
      apiKey: null,
      apiKeyId: "known",
      workspaceId: "w",
      userId: "u",
    });
    expect(rollupKeys()).toEqual([`known|gpt-4o|openai`]);
    expect(db.get("SELECT workspaceId, userId FROM usageRollup")).toEqual({
      workspaceId: "w",
      userId: "u",
    });
    const all = JSON.stringify([
      db.all("SELECT * FROM usageHistory"),
      db.all("SELECT * FROM usageRollup"),
    ]);
    expect(all).not.toContain("th_");
  });

  it("late raw from a known key resolves to its id; unknown raw becomes a keyed pseudonym", async () => {
    await saveRequestUsageUnscoped(entry({ apiKey: RAW }));
    await saveRequestUsageUnscoped(entry({ apiKey: LATE_RAW, model: "gpt-4o-mini" }));
    const keys = db.all("SELECT apiKeyId FROM usageHistory ORDER BY id").map((r) => r.apiKeyId);
    expect(keys[0]).toBe("known");
    expect(keys[1].startsWith("historical:")).toBe(true);
    expect(JSON.stringify(db.all("SELECT * FROM usageHistory"))).not.toContain(LATE_RAW);
    expect(rollupKeys().sort()).toEqual(
      [`${keys[1]}|gpt-4o-mini|openai`, `known|gpt-4o|openai`].sort(),
    );
  });

  it("raw and explicit id must agree; mismatch fails closed with no write", async () => {
    await expect(
      saveRequestUsageUnscoped(entry({ apiKey: RAW, apiKeyId: "other" })),
    ).rejects.toThrow();
    expect(db.get("SELECT COUNT(*) AS n FROM usageHistory").n).toBe(0);
    expect(db.get("SELECT COUNT(*) AS n FROM usageRollup").n).toBe(0);
  });

  it("invalid durable marker fails closed; no raw or row is written", async () => {
    db.run("DELETE FROM _meta WHERE key = 'apiKeysHashKid'");
    await expect(saveRequestUsageUnscoped(entry({ apiKey: RAW }))).rejects.toThrow();
    expect(db.get("SELECT COUNT(*) AS n FROM usageHistory").n).toBe(0);
  });

  it("missing master key fails closed; no raw or row is written", async () => {
    // Fresh DATA_DIR never provisioned a key file; env is cleared in
    // afterEach and here, so loadMasterKey has nothing to load.
    delete process.env.TOKENHOP_MASTER_KEY;
    await expect(
      saveRequestUsageUnscoped(entry({ apiKey: RAW, apiKeyId: "known" })),
    ).rejects.toThrow(/\[master-key\]/);
    expect(db.get("SELECT COUNT(*) AS n FROM usageHistory").n).toBe(0);
    expect(db.get("SELECT COUNT(*) AS n FROM usageRollup").n).toBe(0);
    expect(JSON.stringify(db.all("SELECT value FROM _meta"))).not.toContain(RAW);
  });

  it("stats join by id in hashed state: names resolve, counts preserved, no raw", async () => {
    await saveRequestUsageUnscoped(entry({ apiKeyId: "known" }));
    await saveRequestUsageUnscoped(entry({ apiKeyId: "known", model: "gpt-4o-mini" }));
    const stats = await getUsageStats(null, "24h");
    const rows = Object.values(stats.byApiKey);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.keyName === "Known")).toBe(true);
    expect(rows.reduce((s, r) => s + r.requests, 0)).toBe(2);
    expect(JSON.stringify(stats)).not.toContain("th_");
  });

  it("no credential keys into the local-no-key bucket", async () => {
    await saveRequestUsageUnscoped(entry({}));
    expect(rollupKeys()).toEqual([`local-no-key|gpt-4o|openai`]);
  });

  it("valid hashed schema with zero key rows still accepts usage writes", async () => {
    db.exec("DELETE FROM apiKeys");
    await saveRequestUsageUnscoped(entry({})); // request without a key
    await saveRequestUsageUnscoped(entry({ apiKey: LATE_RAW, model: "gpt-4o-mini" }));
    expect(db.get("SELECT COUNT(*) AS n FROM usageHistory").n).toBe(2);
    expect(db.get("SELECT 1 AS x FROM usageHistory WHERE apiKeyId = 'local-no-key'")).toBeTruthy();
    const pseudonym = db.get(
      "SELECT apiKeyId FROM usageHistory WHERE apiKeyId != 'local-no-key'",
    ).apiKeyId;
    expect(pseudonym.startsWith("historical:")).toBe(true);
    expect(JSON.stringify(db.all("SELECT * FROM usageHistory"))).not.toContain(LATE_RAW);
  });
});

describe("usage sinks under legacy storage", () => {
  beforeEach(() => {
    // Shared per-file DB: the hashed describe leaves a hashed-shaped apiKeys
    // table behind. Legacy storage means the legacy raw-key schema.
    db.exec("DROP TABLE IF EXISTS apiKeys");
    db.exec(buildCreateTableSql("apiKeys", TABLES.apiKeys));
  });

  it("raw keys are never persisted (YAN-370): known → id, unknown → pseudonym", async () => {
    db.run("INSERT INTO apiKeys(id,key,name,createdAt) VALUES ('k1', ?, 'K1', ?)", [RAW, NOW]);
    await saveRequestUsageUnscoped(entry({ apiKey: RAW }));
    await saveRequestUsageUnscoped(entry({ apiKey: LATE_RAW, model: "gpt-4o-mini" }));
    const ids = db.all("SELECT apiKey, apiKeyId FROM usageHistory ORDER BY id");
    expect(ids[0]).toEqual({ apiKey: null, apiKeyId: "k1" });
    expect(ids[1].apiKey).toBeNull();
    expect(ids[1].apiKeyId).toMatch(/^historical:[0-9a-f]{24}$/);
    const all = JSON.stringify([
      db.all("SELECT * FROM usageHistory"),
      db.all("SELECT * FROM usageRollup"),
    ]);
    expect(all).not.toContain(RAW);
    expect(all).not.toContain(LATE_RAW);
    const stats = await getUsageStats(null, "24h");
    const row = Object.values(stats.byApiKey).find((r) => r.apiKeyKey === "k1");
    expect(row).toMatchObject({
      requests: 1,
      keyName: "K1",
      apiKeyMasked: `${RAW.slice(0, 8)}***`,
    });
  });

  it("stats projection matches HEAD: named, unnamed fallback, unknown raw", async () => {
    const NAMED = `th_${"N".repeat(32)}`;
    const UNNAMED = `th_${"U".repeat(32)}`;
    db.run("INSERT INTO apiKeys(id,key,name,createdAt) VALUES ('n', ?, 'Named', ?)", [NAMED, NOW]);
    db.run("INSERT INTO apiKeys(id,key,name,createdAt) VALUES ('u', ?, NULL, ?)", [UNNAMED, NOW]);
    await saveRequestUsageUnscoped(entry({ apiKey: NAMED }));
    await saveRequestUsageUnscoped(entry({ apiKey: UNNAMED, model: "gpt-4o-mini" }));
    await saveRequestUsageUnscoped(entry({ apiKey: RAW, model: "gpt-4.1" }));
    const stats = await getUsageStats(null, "24h");
    const rows = Object.values(stats.byApiKey);
    expect(rows.find((r) => r.apiKeyKey === "n")).toMatchObject({
      keyName: "Named",
      apiKeyMasked: `${NAMED.slice(0, 8)}***`,
    });
    // HEAD: keyName falls back to apiKeyMasked when the key row has no name.
    expect(rows.find((r) => r.apiKeyKey === "u")).toMatchObject({
      keyName: `${UNNAMED.slice(0, 8)}***`,
      apiKeyMasked: `${UNNAMED.slice(0, 8)}***`,
    });
    // YAN-370: an unknown raw is stored as a pseudonym, so no masked prefix
    // survives; it is labelled "Unknown key (<tag>)".
    const unknown = rows.find((r) => r.apiKeyKey.startsWith("historical:"));
    expect(unknown.apiKeyMasked).toBeNull();
    expect(unknown.keyName).toMatch(/^Unknown key \([0-9a-f]{6}\)$/);
    expect(JSON.stringify(stats)).not.toContain(RAW);
    expect(JSON.stringify(stats)).not.toContain(NAMED);
    expect(JSON.stringify(stats)).not.toContain(UNNAMED);
  });
  it("trusted attribution IDs round-trip through JSON persistence and readback", async () => {
    const RAW = "th_SENTINELREMOVE000000000000000000";
    const settings = await import("@/lib/db/repos/settingsRepo.js");
    await settings.updateSettings({
      requestLogsEnabled: true,
      observabilityBatchSize: 1,
      observabilityFlushIntervalMs: 50,
    });
    await saveRequestDetailUnscoped({
      id: "rd-ids-1",
      timestamp: NOW,
      provider: "openai",
      model: "gpt-4o",
      connectionId: "conn-1",
      apiKeyId: "known",
      workspaceId: "w",
      userId: "u",
      request: { headers: { Authorization: `Bearer ${RAW}`, "Content-Type": "application/json" } },
    });
    await new Promise((r) => setTimeout(r, 200));
    const viaId = await getRequestDetailById(null, "rd-ids-1");
    expect(viaId).toMatchObject({ apiKeyId: "known", workspaceId: "w", userId: "u" });
    const list = await getRequestDetails(null, { provider: "openai" });
    expect(list.details[0]).toMatchObject({ apiKeyId: "known", workspaceId: "w", userId: "u" });
    const raw = JSON.stringify(db.all("SELECT data FROM requestDetails"));
    // Legacy shape: trusted IDs preserved in JSON; raw-header sentinel gone.
    expect(raw).not.toContain(RAW);
    expect(JSON.parse(db.all("SELECT data FROM requestDetails")[0].data)).toMatchObject({
      apiKeyId: "known",
      workspaceId: "w",
      userId: "u",
    });
  });
});

describe("requestDetails capture sanitization", () => {
  it("removes credential headers by substring and redacts the ?key= query", async () => {
    const { sanitizeHeaders, sanitizeUrl } = (await import("@/lib/db/repos/requestDetailsRepo.js"))
      .__test__;
    const headers = {
      Authorization: "Bearer secret",
      "X-Api-Key": "secret",
      "X-Goog-Api-Key": "secret",
      "X-9r-Cli-Token": "secret",
      "X-9r-Peer-Token": "secret",
      // Legacy substring rule: ANY token-bearing header is removed, even one
      // no exact-name list could anticipate.
      "X-Custom-Session-Token": "secret",
      "X-Provider-Api-Key-Id": "secret",
      "Content-Type": "application/json",
    };
    const out = sanitizeHeaders(headers);
    for (const key of Object.keys(headers)) {
      if (key === "Content-Type") expect(out[key]).toBe(headers[key]);
      else expect(out).not.toHaveProperty(key);
    }
    expect(JSON.stringify(out)).not.toContain("secret");
    expect(headers.Authorization).toBe("Bearer secret"); // input untouched
    const url = sanitizeUrl("http://localhost/v1/chat?key=secret&model=x");
    expect(url).not.toContain("secret");
    expect(url).toContain("model=x");
  });
});
