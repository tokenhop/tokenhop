// getLastActivity: newest usageHistory timestamp (or null on empty DB).
// Repo + route shape for GET /api/usage/last-activity.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-last-activity-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb?.();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const OLDER = "2026-01-01T00:00:00.000Z";
const NEWER = "2026-09-20T12:00:00.000Z";

async function seedOutOfOrder() {
  // Newer row inserted FIRST: latest must win by timestamp, not insert order.
  await db.saveRequestUsageUnscoped({
    provider: "openai",
    model: "gpt-4",
    tokens: { prompt_tokens: 10, completion_tokens: 5 },
    endpoint: "/v1/chat/completions",
    status: "ok",
    timestamp: NEWER,
  });
  await db.saveRequestUsageUnscoped({
    provider: "openai",
    model: "gpt-4",
    tokens: { prompt_tokens: 10, completion_tokens: 5 },
    endpoint: "/v1/chat/completions",
    status: "ok",
    timestamp: OLDER,
  });
}

describe("getLastActivity", () => {
  it("empty DB → null", async () => {
    expect(await db.getLastActivity(null)).toBeNull();
  });

  it("route returns 200 { lastRequestAt: null } on empty DB", async () => {
    const { GET } = await import("../../src/app/api/usage/last-activity/route.js");
    const res = await GET(new Request("http://localhost/api/usage/last-activity"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lastRequestAt: null });
  });

  it("latest timestamp wins even when inserted first", async () => {
    await seedOutOfOrder();
    expect(await db.getLastActivity(null)).toBe(NEWER);
  });

  it("route returns the latest timestamp", async () => {
    const { GET } = await import("../../src/app/api/usage/last-activity/route.js");
    const res = await GET(new Request("http://localhost/api/usage/last-activity"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lastRequestAt: NEWER });
  });
});
