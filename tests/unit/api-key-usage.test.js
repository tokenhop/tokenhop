// getApiKeyUsage: per-key lastUsed + requests-today from usageHistory,
// feeding the Endpoint & keys table (GET /api/keys).
import { describe, it, expect, beforeAll } from "vitest";

let db;

beforeAll(async () => {
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

describe("getApiKeyUsage", () => {
  it("omits keys that never made a request", async () => {
    const key = await db.createApiKey("idle", "machine-idle");
    const usage = await db.getApiKeyUsage();
    expect(usage.lastUsed[key.key]).toBeUndefined();
    expect(usage.today[key.key]).toBeUndefined();
  });

  it("counts today's requests and returns the latest timestamp per key", async () => {
    const key = await db.createApiKey("busy", "machine-busy");
    const other = await db.createApiKey("other", "machine-busy");
    const entry = { provider: "openai", model: "gpt-4o", status: "ok", tokens: {} };

    await db.saveRequestUsage({ ...entry, apiKey: key.key });
    await db.saveRequestUsage({ ...entry, apiKey: key.key });
    await db.saveRequestUsage({ ...entry, apiKey: other.key });
    await db.saveRequestUsage({ ...entry }); // no key: excluded

    const usage = await db.getApiKeyUsage();
    expect(usage.today[key.key]).toBe(2);
    expect(usage.today[other.key]).toBe(1);
    expect(typeof usage.lastUsed[key.key]).toBe("string");
    expect(Number.isNaN(Date.parse(usage.lastUsed[key.key]))).toBe(false);
  });
});
