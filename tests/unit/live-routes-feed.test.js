// getLiveRoutesFeed: windowed read for the Home live-routes map. Verifies the
// recording side (meta.userAgent), server-side key-name resolution (no raw
// key leaves), error-row status extraction and window filtering.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let adapter;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-live-routes-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  const { getAdapter } = await import("@/lib/db/driver.js");
  adapter = await getAdapter();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("getLiveRoutesFeed", () => {
  it("returns windowed usage + error rows with key names, never raw keys", async () => {
    const key = await db.createApiKey("nightly-job", "machine-test");
    await db.saveRequestUsage({
      provider: "openrouter",
      model: "m1",
      apiKey: key.key,
      userAgent: "claude-code/2.1.0",
      comboName: "coder",
      tokens: { prompt_tokens: 3, completion_tokens: 2 },
    });
    await db.saveRequestUsage({
      provider: "old",
      model: "m1",
      timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      tokens: { prompt_tokens: 1, completion_tokens: 1 },
    });
    adapter.run(
      `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [
        "err-1",
        new Date().toISOString(),
        "gemini-cli",
        "m1",
        null,
        "error",
        JSON.stringify({ response: { error: "rate limited", status: 429 } }),
      ],
    );

    const feed = await db.getLiveRoutesFeed();

    expect(feed.usageRows).toHaveLength(1);
    expect(feed.usageRows[0]).toMatchObject({
      provider: "openrouter",
      keyName: "nightly-job",
      userAgent: "claude-code/2.1.0",
      comboName: "coder",
    });
    expect(JSON.stringify(feed)).not.toContain(key.key);
    expect(feed.errorRows).toEqual([
      expect.objectContaining({ provider: "gemini-cli", status: 429 }),
    ]);
    db.recordFallbackHop({ comboName: "coder", provider: "gemini-cli", model: "m1", status: 409 });
    const again = await db.getLiveRoutesFeed();
    expect(again.fallbackHops).toEqual([
      expect.objectContaining({ comboName: "coder", provider: "gemini-cli", status: 409 }),
    ]);
  });
});
