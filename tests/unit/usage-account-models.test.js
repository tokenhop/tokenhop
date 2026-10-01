// YAN-64: day summaries (7d/30d/60d/all) must keep one byAccount row per
// account+model, matching the 24h path, instead of collapsing an account's
// usage into its last-used model.
import { beforeAll, describe, expect, it, vi } from "vitest";

let db;

beforeAll(async () => {
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  const base = Date.now() - 60_000;
  const models = ["gpt-4o", "gpt-4o", "gpt-4o-mini"];
  for (const [i, model] of models.entries()) {
    await db.saveRequestUsage({
      provider: "openai",
      model,
      connectionId: "conn-yan64-0001",
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      endpoint: "/v1/chat/completions",
      status: "ok",
      timestamp: new Date(base + i * 1000).toISOString(),
    });
  }
});

describe.each(["24h", "7d"])("getUsageStats(%s) byAccount", (period) => {
  it("splits an account's usage per model", async () => {
    const stats = await db.getUsageStats(period);
    const rows = Object.values(stats.byAccount).filter((r) => r.connectionId === "conn-yan64-0001");
    const byModel = Object.fromEntries(rows.map((r) => [r.rawModel, r.requests]));
    expect(byModel).toEqual({ "gpt-4o": 2, "gpt-4o-mini": 1 });
  });
});

it("still reads day rows saved before YAN-64 (bare connectionId key)", async () => {
  const { getAdapter } = await import("@/lib/db/driver.js");
  const adapter = await getAdapter();
  const day = {
    byAccount: { "conn-legacy-0001": { requests: 4, rawModel: "gpt-4o", provider: "openai" } },
  };
  adapter.run(`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?)`, [
    "2000-01-01",
    JSON.stringify(day),
  ]);
  const stats = await db.getUsageStats("all");
  const row = Object.values(stats.byAccount).find((r) => r.connectionId === "conn-legacy-0001");
  expect(row).toMatchObject({ rawModel: "gpt-4o", requests: 4 });
});
