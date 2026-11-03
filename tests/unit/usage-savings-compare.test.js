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

function seed(
  timestamp,
  meta,
  { workspaceId = null, userId = null, provider = null, model = null } = {},
) {
  adapter.run(
    `INSERT INTO usageHistory(timestamp, workspaceId, userId, provider, model, meta) VALUES(?, ?, ?, ?, ?, ?)`,
    [
      new Date(timestamp).toISOString(),
      workspaceId,
      userId,
      provider,
      model,
      typeof meta === "string" || meta === null ? meta : JSON.stringify(meta),
    ],
  );
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
      costSavedEst: null,
    });
  });

  it("sums positive methods only and counts a multi-method row once", async () => {
    seed(NOW - 10, saved(5, 7, -3, 0));
    seed(NOW - 20, saved(0, -4));
    expect(await db.getSavingsTotals(null, { start: NOW - 100, end: NOW })).toEqual({
      tokensSavedEst: 12,
      requestsWithSavings: 1,
      costSavedEst: null,
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
      costSavedEst: null,
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
    expect(current).toEqual({ tokensSavedEst: 3, requestsWithSavings: 2, costSavedEst: null });
    expect(previous).toEqual({ tokensSavedEst: 30, requestsWithSavings: 2, costSavedEst: null });
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
      costSavedEst: null,
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
    expect(body.currentTotals).toEqual({
      tokensSavedEst: 50,
      requestsWithSavings: 1,
      costSavedEst: null,
    });
    expect(body.previous).toEqual({
      tokensSavedEst: 0,
      requestsWithSavings: 0,
      costSavedEst: null,
    });
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
      costSavedEst: null,
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
      expect(body.currentTotals).toEqual({
        tokensSavedEst: 1,
        requestsWithSavings: 1,
        costSavedEst: null,
      });
      expect(body.previous).toEqual({
        tokensSavedEst: 2,
        requestsWithSavings: 1,
        costSavedEst: null,
      });
    } finally {
      nowSpy.mockRestore();
      scopeHolder.scope = null;
    }
  });
});

describe("getRollupSavingsTotals with days pruned before tracking", () => {
  const range = { from: "2026-09-23", to: "2026-09-29" }; // previous = 09-16..09-22
  const untracked = (dateKey) =>
    adapter.run(
      `INSERT INTO usageRollup (dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint, requests, lastUsedAt)
       VALUES (?, '', '', 'local-no-key', 'p', 'm', 'c', '/e', 5, '')`,
      [dateKey],
    );

  it("returns the previous window when every rollup day is tracked", async () => {
    seed(new Date(2026, 8, 20, 12).getTime(), saved(7));
    seed(new Date(2026, 8, 25, 12).getTime(), saved(3));
    const out = await db.getRollupSavingsTotals(null, range);
    expect(out.currentTotals.tokensSavedEst).toBe(3);
    expect(out.previous).toEqual({ tokensSavedEst: 7, requestsWithSavings: 1, costSavedEst: null });
  });

  it("returns previous: null when the previous window has an untracked day", async () => {
    seed(new Date(2026, 8, 25, 12).getTime(), saved(3));
    untracked("2026-09-18");
    const out = await db.getRollupSavingsTotals(null, range);
    expect(out.currentTotals.tokensSavedEst).toBe(3);
    expect(out.previous).toBeNull();
  });

  it("keeps previous when the untracked day is outside the previous window", async () => {
    seed(new Date(2026, 8, 20, 12).getTime(), saved(7));
    untracked("2026-09-25"); // current window, not previous
    untracked("2026-09-15"); // before previous window
    const out = await db.getRollupSavingsTotals(null, range);
    expect(out.previous).toEqual({ tokensSavedEst: 7, requestsWithSavings: 1, costSavedEst: null });
  });
});

describe("compare totals costSavedEst (YAN-1237)", () => {
  const priced = { provider: "openai", model: "gpt-4o-mini" };

  it("history path (24h): currentTotals/previous price like getUsageSavings", async () => {
    const start = periodStart("24h", NOW);
    const prev = previousPeriodRange("24h", NOW);
    seed(start, saved(1000), priced);
    seed(NOW - 1000, saved(2000), priced);
    seed(prev.start, saved(4000), { provider: "nope", model: "nope" }); // unpriced
    seed(prev.end - 1, saved(500), { provider: "nope", model: "nope" }); // unpriced

    const [headline, current, previous] = await Promise.all([
      db.getUsageSavings(null, "24h", NOW),
      db.getSavingsTotals(null, { start, end: NOW + 1 }),
      db.getSavingsTotals(null, prev),
    ]);
    expect(headline.costSavedEst).toBeGreaterThan(0);
    expect(current.costSavedEst).toBe(headline.costSavedEst);
    // Previous window: both rows are on unknown pricing, so tokens count but
    // no dollars are invented.
    expect(previous.costSavedEst).toBeNull();
    expect(previous.tokensSavedEst).toBe(4500);
  });

  it("rollup path (7d): currentTotals/previous price like getUsageSavings", async () => {
    const range = { from: "2026-09-23", to: "2026-09-29" }; // previous = 09-16..09-22
    seed(new Date(2026, 8, 20, 12).getTime(), saved(3000), priced); // previous
    seed(new Date(2026, 8, 21, 12).getTime(), saved(600), { provider: "nope", model: "nope" });
    seed(new Date(2026, 8, 25, 12).getTime(), saved(1000), priced); // current

    const headline = await db.getUsageSavings(null, "7d", NOW);
    expect(headline.costSavedEst).toBeGreaterThan(0);
    const out = await db.getRollupSavingsTotals(null, range);
    expect(out.currentTotals.costSavedEst).toBe(headline.costSavedEst);
    expect(out.previous.tokensSavedEst).toBe(3600);
    // gpt-4o-mini input is 0.15 $/1M tokens.
    expect(out.currentTotals.costSavedEst).toBeCloseTo(1000 * 0.15e-6, 9);
    expect(out.previous.costSavedEst).toBeCloseTo(3000 * 0.15e-6, 9);
  });

  it("is null when no group in the window had resolvable pricing", async () => {
    seed(new Date(2026, 8, 25, 12).getTime(), saved(1000), {
      provider: "nope",
      model: "nope",
    });
    const out = await db.getRollupSavingsTotals(null, { from: "2026-09-23", to: "2026-09-29" });
    expect(out.currentTotals.costSavedEst).toBeNull();
    expect(out.previous.costSavedEst).toBeNull();
    // History path, same rule: an unpriced row inside the window counts
    // tokens but contributes no dollars.
    seed(NOW - 500, saved(700), { provider: "nope", model: "nope" });
    const hist = await db.getSavingsTotals(null, { start: NOW - 1000, end: NOW + 1 });
    expect(hist.tokensSavedEst).toBeGreaterThan(0);
    expect(hist.costSavedEst).toBeNull();
  });
});
