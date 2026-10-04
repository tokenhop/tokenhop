import crypto from "node:crypto";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import { saveRequestUsage, getUsageStatsUnscoped } from "@/lib/db/repos/usageRepo.js";
import { insertHashedApiKeySync } from "@/lib/db/repos/apiKeysRepo.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import {
  getRequestDetailById,
  getRequestDetails,
  saveRequestDetail,
} from "@/lib/db/repos/requestDetailsRepo.js";
import { TABLES, buildCreateTableSql } from "@/lib/db/schema.js";

const NOW = new Date(Date.now() - 60_000).toISOString();
const MASTER = crypto.randomBytes(32);
const KID = masterKeyId(MASTER);
const RAW = `th_${"A".repeat(32)}`;
const LATE_RAW = `sk-${"b".repeat(32)}`;
const digest = (raw) => hashApiKey(raw, deriveApiKeyHashKey(MASTER));

let db;
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
  db.exec("DELETE FROM usageDaily");
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
    await saveRequestUsage(entry({ apiKeyId: "known", workspaceId: "w", userId: "u" }));
    expect(db.get("SELECT apiKey FROM usageHistory").apiKey).toBe("known");
    expect(db.get("SELECT meta FROM usageHistory").meta).toContain('"workspaceId":"w"');
    const day = JSON.parse(db.get("SELECT data FROM usageDaily").data);
    expect(Object.keys(day.byApiKey)).toEqual([`known|gpt-4o|openai`]);
    const all = db
      .all("SELECT apiKey AS a FROM usageHistory UNION ALL SELECT data FROM usageDaily")
      .map((r) => JSON.stringify(r))
      .join();
    expect(all).not.toContain("th_");
  });

  it("late raw from a known key resolves to its id; unknown raw becomes a keyed pseudonym", async () => {
    await saveRequestUsage(entry({ apiKey: RAW }));
    await saveRequestUsage(entry({ apiKey: LATE_RAW, model: "gpt-4o-mini" }));
    const keys = db.all("SELECT apiKey FROM usageHistory").map((r) => r.apiKey);
    expect(keys[0]).toBe("known");
    expect(keys[1].startsWith("historical:")).toBe(true);
    expect(JSON.stringify(keys)).not.toContain(LATE_RAW);
    const day = JSON.parse(db.get("SELECT data FROM usageDaily").data);
    expect(day.byApiKey[`known|gpt-4o|openai`].requests).toBe(1);
    expect(day.byApiKey[`${keys[1]}|gpt-4o-mini|openai`].requests).toBe(1);
  });

  it("raw and explicit id must agree; mismatch fails closed with no write", async () => {
    await expect(saveRequestUsage(entry({ apiKey: RAW, apiKeyId: "other" }))).rejects.toThrow();
    expect(db.get("SELECT COUNT(*) AS n FROM usageHistory").n).toBe(0);
    expect(db.get("SELECT COUNT(*) AS n FROM usageDaily").n).toBe(0);
  });

  it("invalid durable marker fails closed; no raw or row is written", async () => {
    db.run("DELETE FROM _meta WHERE key = 'apiKeysHashKid'");
    await expect(saveRequestUsage(entry({ apiKey: RAW }))).rejects.toThrow();
    expect(db.get("SELECT COUNT(*) AS n FROM usageHistory").n).toBe(0);
  });

  it("missing master key fails closed; no raw or row is written", async () => {
    // Fresh DATA_DIR never provisioned a key file; env is cleared in
    // afterEach and here, so loadMasterKey has nothing to load.
    delete process.env.TOKENHOP_MASTER_KEY;
    await expect(saveRequestUsage(entry({ apiKey: RAW, apiKeyId: "known" }))).rejects.toThrow(
      /\[master-key\]/,
    );
    expect(db.get("SELECT COUNT(*) AS n FROM usageHistory").n).toBe(0);
    expect(db.get("SELECT COUNT(*) AS n FROM usageDaily").n).toBe(0);
    expect(JSON.stringify(db.all("SELECT value FROM _meta"))).not.toContain(RAW);
  });

  it("stats join by id in hashed state: names resolve, counts preserved, no raw", async () => {
    await saveRequestUsage(entry({ apiKeyId: "known" }));
    await saveRequestUsage(entry({ apiKeyId: "known", model: "gpt-4o-mini" }));
    const stats = await getUsageStatsUnscoped("24h");
    const rows = Object.values(stats.byApiKey);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.keyName === "Known")).toBe(true);
    expect(rows.reduce((s, r) => s + r.requests, 0)).toBe(2);
    expect(JSON.stringify(stats)).not.toContain("th_");
  });

  it("no credential keys into the local-no-key bucket", async () => {
    await saveRequestUsage(entry({}));
    const day = JSON.parse(db.get("SELECT data FROM usageDaily").data);
    expect(Object.keys(day.byApiKey)).toEqual([`local-no-key|gpt-4o|openai`]);
  });

  it("valid hashed schema with zero key rows still accepts usage writes", async () => {
    db.exec("DELETE FROM apiKeys");
    await saveRequestUsage(entry({})); // request without a key
    await saveRequestUsage(entry({ apiKey: LATE_RAW, model: "gpt-4o-mini" }));
    expect(db.get("SELECT COUNT(*) AS n FROM usageHistory").n).toBe(2);
    expect(db.get("SELECT apiKey FROM usageHistory WHERE apiKey IS NULL")).toBeTruthy();
    const pseudonym = db.get("SELECT apiKey FROM usageHistory WHERE apiKey IS NOT NULL").apiKey;
    expect(pseudonym.startsWith("historical:")).toBe(true);
    expect(JSON.stringify(db.all("SELECT apiKey, meta FROM usageHistory"))).not.toContain(LATE_RAW);
  });
});

describe("usage sinks under legacy storage", () => {
  beforeEach(() => {
    // Shared per-file DB: the hashed describe leaves a hashed-shaped apiKeys
    // table behind. Legacy storage means the legacy raw-key schema.
    db.exec("DROP TABLE IF EXISTS apiKeys");
    db.exec(buildCreateTableSql("apiKeys", TABLES.apiKeys));
  });

  it("raw keys persist and stats mask exactly as before", async () => {
    await saveRequestUsage(entry({ apiKey: RAW }));
    expect(db.get("SELECT apiKey FROM usageHistory").apiKey).toBe(RAW);
    const day = JSON.parse(db.get("SELECT data FROM usageDaily").data);
    expect(Object.keys(day.byApiKey)).toEqual([`${RAW}|gpt-4o|openai`]);
    const stats = await getUsageStatsUnscoped("24h");
    const row = Object.values(stats.byApiKey)[0];
    expect(row.requests).toBe(1);
    expect(row.keyName.startsWith(RAW.slice(0, 8))).toBe(true);
  });

  it("stats projection matches HEAD: named, unnamed fallback, unknown raw", async () => {
    const NAMED = `th_${"N".repeat(32)}`;
    const UNNAMED = `th_${"U".repeat(32)}`;
    db.run("INSERT INTO apiKeys(id,key,name,createdAt) VALUES ('n', ?, 'Named', ?)", [NAMED, NOW]);
    db.run("INSERT INTO apiKeys(id,key,name,createdAt) VALUES ('u', ?, NULL, ?)", [UNNAMED, NOW]);
    await saveRequestUsage(entry({ apiKey: NAMED }));
    await saveRequestUsage(entry({ apiKey: UNNAMED, model: "gpt-4o-mini" }));
    await saveRequestUsage(entry({ apiKey: RAW, model: "gpt-4.1" }));
    const stats = await getUsageStatsUnscoped("24h");
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
    // HEAD: unknown raw gets the key-<hash> id and masked (hash6) label.
    const unknown = rows.find((r) => r.apiKeyKey.startsWith("key-"));
    expect(unknown.apiKeyMasked).toBe(`${RAW.slice(0, 8)}***`);
    expect(unknown.keyName.startsWith(`${RAW.slice(0, 8)}*** (`)).toBe(true);
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
    await saveRequestDetail({
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
    const viaId = await getRequestDetailById("rd-ids-1");
    expect(viaId).toMatchObject({ apiKeyId: "known", workspaceId: "w", userId: "u" });
    const list = await getRequestDetails({ provider: "openai" });
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
