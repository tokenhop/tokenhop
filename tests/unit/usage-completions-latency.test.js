// YAN-743: edit-prediction latency and empty-result rate come from usageHistory
// meta for every period (the day rollup has no latency).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let db;

beforeAll(async () => {
  // Pin the clock (Date only, timers stay real) so a local-midnight rollover
  // between fixtures and assertions can't move the 7d calendar cutoff.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  const base = Date.now() - 60_000;
  const save = (i, endpoint, meta, out = 5, timestamp = new Date(base + i * 1000)) =>
    db.saveRequestUsageUnscoped({
      provider: "openai",
      model: "gpt-4o-mini",
      tokens: { prompt_tokens: 10, completion_tokens: out },
      endpoint,
      status: "ok",
      timestamp: timestamp.toISOString(),
      meta,
    });
  await save(0, "completions", { latencyMs: 100 });
  await save(1, "completions", { latencyMs: 300 });
  await save(2, "completions", { latencyMs: 200, empty: true }, 0);
  await save(3, "completions", { latencyMs: 1000 });
  await save(4, "/v1/chat/completions", { latencyMs: 5000 });
  // Just before the 7d calendar window (local midnight 6 days ago) but inside a
  // rolling 7*24h window: must be excluded like the rollup rows are.
  const edge = new Date();
  edge.setHours(0, 0, 0, 0);
  edge.setDate(edge.getDate() - 6);
  await save(5, "completions", { latencyMs: 9000 }, 5, new Date(edge.getTime() - 60_000));
});

afterAll(() => {
  vi.useRealTimers();
});

describe.each(["24h", "7d"])("getUsageStats(%s) completions latency", (period) => {
  it("reports avg, p50 and empty rate on the completions rows only", async () => {
    const stats = await db.getUsageStats(null, period);
    const rows = Object.values(stats.byEndpoint);
    const fim = rows.find((r) => r.endpoint === "completions");
    const chat = rows.find((r) => r.endpoint === "/v1/chat/completions");
    expect(fim).toMatchObject({
      requests: 4,
      latencyAvgMs: 400,
      latencyP50Ms: 250,
      emptyRate: 0.25,
    });
    expect(chat.latencyP50Ms).toBeUndefined();
    expect(stats.endpointLatency).toEqual({
      completions: { latencyAvgMs: 400, latencyP50Ms: 250, emptyRate: 0.25, samples: 4 },
    });
  });
});
