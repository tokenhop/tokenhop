import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { periodStart, previousPeriodRange } from "@/shared/utils/period.js";
import { rebuildRollupFromHistoryUnscoped } from "@/lib/db/repos/usageRollupRepo.js";

const scopeHolder = vi.hoisted(() => ({ scope: null }));
vi.mock("@/lib/usage/scope.js", () => ({ usageScope: async () => scopeHolder.scope }));

const NOW = new Date(2026, 8, 29, 12, 30).getTime();
const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let adapter;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-savings-compare-"));
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

beforeEach(() => {
  adapter.run("DELETE FROM usageHistory");
  adapter.run("DELETE FROM usageRollup");
  adapter.run("DELETE FROM usageComboRollup");
});

const saved = (...tokens) => ({
  savings: {
    byMethod: Object.fromEntries(tokens.map((t, i) => [`m${i}`, { tokensSavedEst: t }])),
  },
});

function seed(timestamp, meta, { workspaceId = null, userId = null } = {}) {
  adapter.run(`INSERT INTO usageHistory(timestamp, workspaceId, userId, meta) VALUES(?, ?, ?, ?)`, [
    new Date(timestamp).toISOString(),
    workspaceId,
    userId,
    typeof meta === "string" || meta === null ? meta : JSON.stringify(meta),
  ]);
  // Raw history inserts simulate retained legacy rows; production writes fold
  // these measures transactionally. Rebuild keeps both sources in sync here.
  rebuildRollupFromHistoryUnscoped(adapter);
}

describe("getSavingsTotals", () => {
  it("uses a half-open [start, end) window", async () => {
    const start = NOW - 1000;
    seed(start - 1, saved(1));
    seed(start, saved(10));
    seed(NOW - 1, saved(100));
    seed(NOW, saved(1000));
    expect(await db.getSavingsTotals(null, { start, end: NOW })).toEqual({
      tokensSavedEst: 110,
      requestsWithSavings: 2,
    });
  });

  it("sums positive methods only and counts a multi-method row once", async () => {
    seed(NOW - 10, saved(5, 7, -3, 0));
    seed(NOW - 20, saved(0, -4));
    expect(await db.getSavingsTotals(null, { start: NOW - 100, end: NOW })).toEqual({
      tokensSavedEst: 12,
      requestsWithSavings: 1,
    });
  });

  it("ignores NULL, malformed and non-object meta without throwing", async () => {
    seed(NOW - 10, null);
    seed(NOW - 11, "{bad");
    seed(NOW - 12, { savings: { byMethod: { rtk: "abc" } } });
    seed(NOW - 13, { savings: { byMethod: { rtk: 5 } } });
    seed(NOW - 14, { savings: { byMethod: "x" } });
    seed(NOW - 15, saved(9));
    expect(await db.getSavingsTotals(null, { start: NOW - 100, end: NOW })).toEqual({
      tokensSavedEst: 9,
      requestsWithSavings: 1,
    });
  });

  it("matches getUsageSavings for the same rows", async () => {
    const start = periodStart("7d", NOW);
    seed(start, saved(10, 20));
    seed(NOW - 60000, saved(5));
    seed(NOW - 120000, saved(0));
    seed(start - 1, saved(999));
    const headline = await db.getUsageSavings(null, "7d", NOW);
    const totals = await db.getSavingsTotals(null, { start, end: NOW });
    expect(totals.tokensSavedEst).toBe(headline.tokensSavedEst);
    expect(totals.requestsWithSavings).toBe(headline.requestsWithSavings);
    expect(totals.tokensSavedEst).toBe(35);
  });

  it.each(["today", "24h", "7d"])("splits current and previous windows for %s", async (period) => {
    const start = periodStart(period, NOW);
    const prev = previousPeriodRange(period, NOW);
    seed(start, saved(1));
    seed(NOW - 1, saved(2));
    seed(prev.start, saved(10));
    seed(prev.end - 1, saved(20));
    seed(prev.start - 1, saved(1000));
    // Past the previous window: only inside the current one when it adjoins it.
    if (prev.end < start) seed(prev.end, saved(2000));
    const current = await db.getSavingsTotals(null, { start, end: NOW });
    const previous = await db.getSavingsTotals(null, prev);
    expect(current).toEqual({ tokensSavedEst: 3, requestsWithSavings: 2 });
    expect(previous).toEqual({ tokensSavedEst: 30, requestsWithSavings: 2 });
  });

  it("isolates by workspace and user", async () => {
    const range = { start: NOW - 1000, end: NOW };
    const at = new Date(NOW).toISOString();
    for (const u of ["u1", "u2"]) {
      adapter.run(
        "INSERT OR IGNORE INTO users(id, instanceRole, status, createdAt, updatedAt) VALUES (?, 'user', 'active', ?, ?)",
        [u, at, at],
      );
    }
    for (const w of ["ws-a", "ws-b"]) {
      adapter.run(
        "INSERT OR IGNORE INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES (?, ?, 'shared', ?, ?)",
        [w, w, at, at],
      );
    }
    seed(NOW - 10, saved(1), { workspaceId: "ws-a", userId: "u1" });
    seed(NOW - 10, saved(10), { workspaceId: "ws-a", userId: "u2" });
    seed(NOW - 10, saved(100), { workspaceId: "ws-b", userId: "u1" });
    expect((await db.getSavingsTotals(null, range)).tokensSavedEst).toBe(111);
    expect((await db.getSavingsTotals({ workspaceId: "ws-a" }, range)).tokensSavedEst).toBe(11);
    expect(await db.getSavingsTotals({ workspaceId: "ws-a", userId: "u1" }, range)).toEqual({
      tokensSavedEst: 1,
      requestsWithSavings: 1,
    });
    await expect(db.getSavingsTotals({}, range)).rejects.toThrow();
  });

  it("rejects invalid bounds", async () => {
    for (const range of [
      { start: Number.NaN, end: 1 },
      { start: 5, end: 1 },
      { start: 0, end: Number.POSITIVE_INFINITY },
      undefined,
    ]) {
      await expect(db.getSavingsTotals(null, range)).rejects.toThrow();
    }
  });
});

describe("savings route compare", () => {
  const call = async (query) => {
    const { GET } = await import("../../src/app/api/usage/savings/route.js");
    return GET(new Request(`http://localhost/api/usage/savings?${query}`));
  };

  it("adds currentTotals and previous when compare=previous", async () => {
    seed(Date.now() - 1000, saved(50));
    const res = await call("period=7d&compare=previous");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currentTotals).toEqual({ tokensSavedEst: 50, requestsWithSavings: 1 });
    expect(body.previous).toEqual({ tokensSavedEst: 0, requestsWithSavings: 0 });
    expect(body.tokensSavedEst).toBe(50);
  });

  it("omits compare fields by default", async () => {
    const body = await (await call("period=7d")).json();
    expect(body).not.toHaveProperty("previous");
    expect(body).not.toHaveProperty("currentTotals");
  });

  it("rejects an invalid compare value", async () => {
    const res = await call("period=7d&compare=bogus");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid compare" });
  });

  it("supports 90d from the daily rollup", async () => {
    seed(Date.now() - 1000, saved(50));
    const res = await call("period=90d&compare=previous");
    expect(res.status).toBe(200);
    expect((await res.json()).currentTotals).toEqual({
      tokensSavedEst: 50,
      requestsWithSavings: 1,
    });
  });

  it("keeps headline, currentTotals and previous inside the Users & teams scope", async () => {
    const at = new Date(NOW).toISOString();
    for (const u of ["u1", "u2"]) {
      adapter.run(
        "INSERT OR IGNORE INTO users(id, instanceRole, status, createdAt, updatedAt) VALUES (?, 'user', 'active', ?, ?)",
        [u, at, at],
      );
    }
    for (const w of ["ws-a", "ws-b"]) {
      adapter.run(
        "INSERT OR IGNORE INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES (?, ?, 'shared', ?, ?)",
        [w, w, at, at],
      );
    }
    const prev = previousPeriodRange("7d", NOW);
    const mine = { workspaceId: "ws-a", userId: "u1" };
    // Row stamped exactly at `now` counts in the headline and currentTotals.
    seed(NOW, saved(1), mine);
    seed(NOW - 1000, saved(10), { workspaceId: "ws-a", userId: "u2" });
    seed(NOW - 1000, saved(100), { workspaceId: "ws-b", userId: "u1" });
    seed(prev.start, saved(2), mine);
    seed(prev.start, saved(20), { workspaceId: "ws-a", userId: "u2" });
    seed(prev.start, saved(200), { workspaceId: "ws-b", userId: "u1" });

    scopeHolder.scope = mine;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      const body = await (await call("period=7d&compare=previous")).json();
      expect(body.tokensSavedEst).toBe(1);
      expect(body.currentTotals).toEqual({ tokensSavedEst: 1, requestsWithSavings: 1 });
      expect(body.previous).toEqual({ tokensSavedEst: 2, requestsWithSavings: 1 });
    } finally {
      nowSpy.mockRestore();
      scopeHolder.scope = null;
    }
  });
});
