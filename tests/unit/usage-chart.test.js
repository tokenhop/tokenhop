// getChartData bucket split: {label,input,cached,output,tokens,cost}.
// Prompt is cache-INCLUSIVE (open-sse/handlers/chatCore/requestDetail.js
// canonicalizeUsage), so tokens = input + output and cached is a subset of
// input. `tokens`+`cost` keys preserved; cost untouched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-chart-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.saveRequestUsage({
    provider: "openai",
    model: "gpt-4",
    tokens: { prompt_tokens: 100, completion_tokens: 50, cached_tokens: 30 },
    endpoint: "/v1/chat/completions",
    status: "ok",
  });
  await db.saveRequestUsage({
    provider: "anthropic",
    model: "cl-x",
    tokens: { input_tokens: 200, output_tokens: 60, cache_read_input_tokens: 40 },
    endpoint: "/v1/messages",
    status: "ok",
  });
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function sumBuckets(buckets) {
  return buckets.reduce(
    (a, b) => ({
      input: a.input + (b.input || 0),
      cached: a.cached + (b.cached || 0),
      output: a.output + (b.output || 0),
      tokens: a.tokens + (b.tokens || 0),
    }),
    { input: 0, cached: 0, output: 0, tokens: 0 },
  );
}

function expectBucketShape(buckets) {
  for (const b of buckets) {
    expect(b).toHaveProperty("label");
    expect(b).toHaveProperty("input");
    expect(b).toHaveProperty("cached");
    expect(b).toHaveProperty("output");
    expect(b).toHaveProperty("tokens");
    expect(b).toHaveProperty("cost");
    // tokens sum unchanged: prompt (cache-inclusive) + completion
    expect(b.tokens).toBe((b.input || 0) + (b.output || 0));
  }
}

describe("getChartData bucket split", () => {
  it("today: input/cached/output split, tokens = prompt + completion", async () => {
    const buckets = await db.getChartData("today");
    expect(buckets).toHaveLength(24);
    expectBucketShape(buckets);
    expect(sumBuckets(buckets)).toEqual({ input: 300, cached: 70, output: 110, tokens: 410 });
  });

  it("24h: same split via tokens JSON aliases", async () => {
    const buckets = await db.getChartData("24h");
    expect(buckets).toHaveLength(24);
    expectBucketShape(buckets);
    expect(sumBuckets(buckets)).toEqual({ input: 300, cached: 70, output: 110, tokens: 410 });
  });

  it("7d: day-JSON path carries the split", async () => {
    const buckets = await db.getChartData("7d");
    expect(buckets).toHaveLength(7);
    expectBucketShape(buckets);
    expect(buckets[buckets.length - 1]).toMatchObject({
      input: 300,
      cached: 70,
      output: 110,
      tokens: 410,
    });
  });
});
