// YAN-68 (GitHub #519): buffered request details were lost on SIGTERM/SIGINT —
// the repo's async shutdown handler yielded while the adapters' sync signal
// handlers closed the DB and exited. Now a sync flusher is registered on a
// global registry and the adapters run it before closing.
// NOTE: never emit SIGTERM here — process.exit kills the test worker.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shutdown-flush-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  // Large batch size so nothing auto-flushes — details stay in the buffer.
  await db.updateSettings({ enableObservability: true, observabilityBatchSize: 1000 });
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("request details — shutdown flush", () => {
  it("flushes buffered details synchronously on shutdown (no await)", async () => {
    for (let i = 0; i < 3; i++) {
      await db.saveRequestDetail({
        id: `sf-${i}`,
        provider: "openai",
        model: "gpt-4",
        status: "ok",
        tokens: {},
        request: {},
        response: {},
      });
    }

    // Run the registered shutdown flusher(s) the way an adapter would.
    const { runShutdownFlushers } = await import("@/lib/db/shutdownFlushers.js");
    runShutdownFlushers();

    // Query synchronously — no waiting for a flush timer.
    const { getAdapterSync } = await import("@/lib/db/driver.js");
    const row = getAdapterSync().get(`SELECT COUNT(*) as c FROM requestDetails`);
    expect(row.c).toBe(3);

    // Idempotent: buffer already drained, a second run writes nothing.
    runShutdownFlushers();
    expect(getAdapterSync().get(`SELECT COUNT(*) as c FROM requestDetails`).c).toBe(3);
  });
});
