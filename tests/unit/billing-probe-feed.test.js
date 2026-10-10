// YAN-1041: internal billing-probe requestDetails rows are accounting records,
// not user-request telemetry — they must not enter the Home live-routes errorRows
// (while normal user errors stay, and the probe row itself stays stored).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let adapter;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-billing-feed-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function detail(id, status, data) {
  adapter.run(
    `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      new Date().toISOString(),
      "anthropic",
      "claude-haiku-4-5-20251001",
      "c1",
      status,
      JSON.stringify(data),
    ],
  );
}

describe("live-routes feed excludes billing probes", () => {
  it("keeps user errors, drops billing-probe errors, retains probe rows + spend", async () => {
    detail("user-err", "error", { response: { status: 503 }, request: {} });
    detail("probe-err-req", "error", {
      request: { probe: "billing", endpoint: "/internal/billing-probe" },
      response: { status: 500 },
    });
    detail("probe-err-resp", "error", {
      response: { probe: "billing", kind: "error", status: 500 },
    });
    detail("probe-ok", "success", {
      tokens: { prompt_tokens: 8, completion_tokens: 1 },
      request: { probe: "billing" },
      response: { probe: "billing", kind: "success", cost: 0.000013 },
    });

    const feed = await db.getLiveRoutesFeed(null);
    expect(feed.errorRows).toHaveLength(1);
    expect(feed.errorRows[0]).toMatchObject({ provider: "anthropic", status: 503 });

    // Accounting rows are untouched: all four still stored, spend/tokens intact.
    const rows = adapter.all(`SELECT id, status, data FROM requestDetails ORDER BY id`);
    expect(rows.map((r) => r.id)).toEqual([
      "probe-err-req",
      "probe-err-resp",
      "probe-ok",
      "user-err",
    ]);
    const ok = JSON.parse(rows.find((r) => r.id === "probe-ok").data);
    expect(ok.tokens).toEqual({ prompt_tokens: 8, completion_tokens: 1 });
    expect(ok.response.cost).toBeGreaterThan(0);
  });
});
