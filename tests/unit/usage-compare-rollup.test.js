// YAN-1242 route-level compare parity: /api/usage/stats and /api/usage/savings
// with compare=previous for 7d/30d/60d must return currentTotals exactly equal
// to the pre-change history readers (getUsageTotals / getSavingsTotals over
// [periodStart, now]), while `previous` switches to whole calendar days. The
// partial-day sliver the old elapsed-length window missed is documented here:
// a row inside it counts for the rollup previous and did not before.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { periodStart, previousPeriodRange } from "@/shared/utils/period.js";
import { rebuildRollupFromHistoryUnscoped } from "@/lib/db/repos/usageRollupRepo.js";

const scopeHolder = vi.hoisted(() => ({ scope: null }));
vi.mock("@/lib/usage/scope.js", () => ({ usageScope: async () => scopeHolder.scope }));

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let NOW;
let db;
let adapter;

beforeAll(() => {
  // Pin a DST zone so local-day expectations never depend on the host zone.
  process.env.TZ = "America/New_York";
  NOW = new Date(2026, 8, 29, 12, 30).getTime(); // local Tue 2026-09-29 12:30
});

afterAll(() => {
  delete process.env.TZ;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-compare-rollup-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
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
  adapter.run(
    `INSERT INTO usageHistory(timestamp, provider, model, endpoint, promptTokens, completionTokens, cost, status, tokens, meta, workspaceId, userId)
     VALUES(?, 'openai', 'gpt-x', '/v1/chat/completions', 10, 5, 0.5, 'ok', '{}', ?, ?, ?)`,
    [
      new Date(timestamp).toISOString(),
      typeof meta === "string" || meta === null ? meta : JSON.stringify(meta),
      workspaceId,
      userId,
    ],
  );
}

const localMidnightAgo = (n) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

describe("stats compare parity (7d–60d)", () => {
  const call = async (query) => {
    const { GET } = await import("../../src/app/api/usage/stats/route.js");
    return GET(new Request(`http://localhost/api/usage/stats?${query}`));
  };

  it.each(["7d", "30d", "60d"])(
    "%s currentTotals match history; previous is calendar-aligned incl. the sliver",
    async (period) => {
      const N = { "7d": 7, "30d": 30, "60d": 60 }[period];
      const currentStart = periodStart(period, NOW);
      const prevCalendarStart = localMidnightAgo(2 * N - 1);
      const prevCalendarEnd = localMidnightAgo(N - 1);
      // The old elapsed-length previous window starts mid-day; the sliver is
      // [prevCalendarStart, oldPrev.start), which only the rollup previous sees.
      const sliverTs = prevCalendarStart + 6 * 3600_000;
      expect(sliverTs).toBeLessThan(previousPeriodRange(period, NOW).start);

      seed(currentStart, saved(10));
      seed(currentStart + 3600_000, saved(20));
      seed(NOW - 60_000, saved(30));
      seed(prevCalendarStart, saved(40));
      seed(sliverTs, saved(50));
      seed(prevCalendarEnd - 1000, saved(60));
      seed(prevCalendarStart - 1000, saved(700)); // older than any window
      rebuildRollupFromHistoryUnscoped(adapter);

      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
      try {
        const body = await (await call(`period=${period}&compare=previous`)).json();
        // Current totals: exactly the pre-change history output.
        expect(body.currentTotals).toEqual(
          await db.getUsageTotals(null, { start: currentStart, end: NOW }),
        );
        // Previous: whole calendar days, including the sliver row (50)…
        expect(body.previous).toEqual(
          await db.getUsageTotals(null, { start: prevCalendarStart, end: prevCalendarEnd }),
        );
        // …which the old elapsed-length window provably saw fewer of.
        expect(
          (await db.getUsageTotals(null, previousPeriodRange(period, NOW))).requests,
        ).toBeLessThan(3);
      } finally {
        nowSpy.mockRestore();
      }
    },
  );

  it("keeps scoped currentTotals and previous inside a workspace/user scope", async () => {
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
    const start = periodStart("7d", NOW);
    const prevCalendar = { start: localMidnightAgo(13), end: localMidnightAgo(6) };
    seed(start, saved(1), { workspaceId: "ws-a", userId: "u1" });
    seed(start, saved(10), { workspaceId: "ws-a", userId: "u2" });
    seed(start, saved(100), { workspaceId: "ws-b", userId: "u1" });
    seed(prevCalendar.start, saved(2), { workspaceId: "ws-a", userId: "u1" });
    seed(prevCalendar.start, saved(20), { workspaceId: "ws-b", userId: "u1" });
    rebuildRollupFromHistoryUnscoped(adapter);

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      scopeHolder.scope = { workspaceId: "ws-a" };
      const wsBody = await (await call("period=7d&compare=previous")).json();
      expect(wsBody.currentTotals).toEqual(
        await db.getUsageTotals(scopeHolder.scope, { start, end: NOW }),
      );
      expect(wsBody.previous).toEqual(await db.getUsageTotals(scopeHolder.scope, prevCalendar));

      scopeHolder.scope = { workspaceId: "ws-a", userId: "u1" };
      const userBody = await (await call("period=7d&compare=previous")).json();
      expect(userBody.currentTotals).toEqual(
        await db.getUsageTotals(scopeHolder.scope, { start, end: NOW }),
      );
      expect(userBody.previous).toEqual(await db.getUsageTotals(scopeHolder.scope, prevCalendar));
      expect(userBody.currentTotals.requests).toBe(1);
      expect(userBody.previous.requests).toBe(1);
    } finally {
      nowSpy.mockRestore();
      scopeHolder.scope = null;
    }
  });
});

describe("savings compare parity (7d–60d)", () => {
  const call = async (query) => {
    const { GET } = await import("../../src/app/api/usage/savings/route.js");
    return GET(new Request(`http://localhost/api/usage/savings?${query}`));
  };

  it.each(["7d", "30d", "60d"])(
    "%s currentTotals match history; previous is calendar-aligned incl. the sliver",
    async (period) => {
      const N = { "7d": 7, "30d": 30, "60d": 60 }[period];
      const currentStart = periodStart(period, NOW);
      const prevCalendarStart = localMidnightAgo(2 * N - 1);
      const prevCalendarEnd = localMidnightAgo(N - 1);
      const sliverTs = prevCalendarStart + 6 * 3600_000;
      expect(sliverTs).toBeLessThan(previousPeriodRange(period, NOW).start);

      seed(currentStart, saved(10, 20));
      seed(NOW - 60_000, saved(30));
      seed(prevCalendarStart, saved(40));
      seed(sliverTs, saved(50));
      seed(prevCalendarEnd - 1000, saved(60));
      seed(prevCalendarStart - 1000, saved(700));
      rebuildRollupFromHistoryUnscoped(adapter);

      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
      try {
        const body = await (await call(`period=${period}&compare=previous`)).json();
        // Current totals: exactly the pre-change history output (the old route
        // used getSavingsTotals with an inclusive end).
        expect(body.currentTotals).toEqual(
          await db.getSavingsTotals(null, { start: currentStart, end: NOW + 1 }),
        );
        expect(body.previous).toEqual({
          tokensSavedEst: 150,
          requestsWithSavings: 3,
        });
        // The old elapsed-length previous window provably saw fewer of them.
        expect(
          (await db.getSavingsTotals(null, previousPeriodRange(period, NOW))).tokensSavedEst,
        ).toBeLessThan(150);
      } finally {
        nowSpy.mockRestore();
      }
    },
  );

  it("keeps scoped compare totals inside a workspace/user scope", async () => {
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
    const start = periodStart("7d", NOW);
    const prevCalendar = { start: localMidnightAgo(13), end: localMidnightAgo(6) };
    seed(start, saved(1), { workspaceId: "ws-a", userId: "u1" });
    seed(start, saved(10), { workspaceId: "ws-a", userId: "u2" });
    seed(start, saved(100), { workspaceId: "ws-b", userId: "u1" });
    seed(prevCalendar.start, saved(2), { workspaceId: "ws-a", userId: "u1" });
    seed(prevCalendar.start, saved(20), { workspaceId: "ws-b", userId: "u1" });
    rebuildRollupFromHistoryUnscoped(adapter);

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      scopeHolder.scope = { workspaceId: "ws-a" };
      const wsBody = await (await call("period=7d&compare=previous")).json();
      expect(wsBody.currentTotals).toEqual({ tokensSavedEst: 11, requestsWithSavings: 2 });
      expect(wsBody.previous).toEqual({ tokensSavedEst: 2, requestsWithSavings: 1 });

      scopeHolder.scope = { workspaceId: "ws-a", userId: "u1" };
      const userBody = await (await call("period=7d&compare=previous")).json();
      expect(userBody.currentTotals).toEqual({ tokensSavedEst: 1, requestsWithSavings: 1 });
      expect(userBody.previous).toEqual({ tokensSavedEst: 2, requestsWithSavings: 1 });
    } finally {
      nowSpy.mockRestore();
      scopeHolder.scope = null;
    }
  });
});
