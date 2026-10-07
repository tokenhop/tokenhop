// Usage stats must never return raw client API keys, and must keep distinct
// keys (which all share the `sk-{machineId}` prefix) in separate rows.
import { beforeAll, describe, expect, it, vi } from "vitest";

let db;
let keyA;
let keyB;

beforeAll(async () => {
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  keyA = await db.createApiKey("Key A", "machine01");
  keyB = await db.createApiKey("Key B", "machine01");
  const base = Date.now() - 60_000;
  const save = (apiKey, model, i) =>
    db.saveRequestUsageUnscoped({
      provider: "openai",
      model,
      apiKey,
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      endpoint: "/v1/chat/completions",
      status: "ok",
      timestamp: new Date(base + i * 1000).toISOString(),
    });
  await save(keyA.key, "gpt-4o", 0);
  await save(keyB.key, "gpt-4o", 1);
  await save(null, "gpt-4o", 2);
  await save(null, "gpt-4o-mini", 3);
});

describe.each(["24h", "7d"])("getUsageStats(%s) byApiKey", (period) => {
  it("separates keys and no-key models without leaking raw keys", async () => {
    const stats = await db.getUsageStats(null, period);
    const rows = Object.values(stats.byApiKey);
    const json = JSON.stringify(stats);
    expect(json).not.toContain(keyA.key);
    expect(json).not.toContain(keyB.key);

    expect(rows.find((r) => r.keyName === "Key A")?.requests).toBe(1);
    expect(rows.find((r) => r.keyName === "Key B")?.requests).toBe(1);
    const noKey = rows.filter((r) => r.apiKeyKey === "local-no-key");
    expect(noKey.map((r) => r.rawModel).sort()).toEqual(["gpt-4o", "gpt-4o-mini"]);
    for (const r of rows) expect(r.lastUsed).toContain("T");
  });
});
