import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import { createProviderConnectionUnscoped } from "@/lib/db/index.js";
import {
  clearQuotaSnapshots,
  getSnapshot,
  recordHeaderWindows,
  recordProbeWindows,
  restoreSnapshot,
} from "open-sse/services/quotaSnapshot.js";
import { computeForecastFromHistory } from "@/lib/quota/forecast.js";
import { _resetQuotaForecastStore, getQuotaForecasts } from "@/lib/quota/forecastStore.js";
import {
  _resetQuotaHistoryWriteCache,
  getConnectionQuotaHistory,
  listConnectionQuotaHistoryRows,
} from "@/lib/db/repos/quotaHistoryRepo.js";
import {
  _resetQuotaHistoryHydration,
  hydrateQuotaSnapshotsFromHistory,
  registerQuotaHistoryHeaderObserver,
} from "@/shared/services/quotaHistoryHydration.js";
import { _resetQuotaSnapshotSync, recordUsageSnapshot } from "@/sse/services/quotaSnapshotSync.js";

const NOW = Date.UTC(2026, 10, 20, 18, 0, 0);
const MIN = 60_000;
const HOUR = 3_600_000;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  clearQuotaSnapshots();
  _resetQuotaForecastStore();
  _resetQuotaSnapshotSync();
  _resetQuotaHistoryWriteCache();
  _resetQuotaHistoryHydration();
  const db = await getAdapter();
  db.run(`DELETE FROM quotaHistory`);
  db.run(`DELETE FROM providerConnections`);
});

afterEach(() => {
  _resetQuotaHistoryHydration();
  vi.useRealTimers();
});

describe("restart survival: snapshots, forecasts, and rate-limit cache", () => {
  it("restores live snapshots and runway forecasts after a simulated process restart", async () => {
    const conn = await createProviderConnectionUnscoped({
      provider: "claude",
      authType: "oauth",
      name: "Work Claude",
      accessToken: "sk-test-token",
    });
    const resetAt = new Date(NOW + 4 * HOUR).toISOString();

    // Record 4 probes spaced 10m apart (100% -> 85% -> 70% -> 55% remaining = 90%/h burn)
    const remainingSeries = [100, 85, 70, 55];
    for (let i = 0; i < remainingSeries.length; i++) {
      vi.setSystemTime(NOW - (remainingSeries.length - 1 - i) * 10 * MIN);
      await recordUsageSnapshot({
        connectionId: conn.id,
        provider: "claude",
        usage: {
          quotas: {
            "session (5h)": {
              remainingPercentage: remainingSeries[i],
              resetAt,
            },
          },
        },
        fallbackTier: "pro",
      });
    }

    // Verify history was persisted
    const historyBefore = await getConnectionQuotaHistory(null, conn.id, { now: NOW });
    expect(historyBefore["session (5h)"]).toHaveLength(4);
    expect(historyBefore["session (5h)"].map((p) => p.usedPct)).toEqual([0, 15, 30, 45]);

    // Simulate process restart: wipe every in-memory store
    clearQuotaSnapshots();
    _resetQuotaForecastStore();
    _resetQuotaHistoryWriteCache();
    _resetQuotaHistoryHydration();
    expect(getSnapshot(conn.id, NOW)).toBeNull();
    expect(getQuotaForecasts(conn.id, NOW)).toEqual({});

    // Hydrate from persisted quotaHistory on startup
    const hydrated = await hydrateQuotaSnapshotsFromHistory({ now: NOW + MIN });
    expect(hydrated.snapshotsRestored).toBe(1);
    expect(hydrated.forecastSamplesRestored).toBe(4);

    // Snapshot survived restart with exact latest reading, planTier, and true updatedAt
    const restored = getSnapshot(conn.id, NOW + MIN);
    expect(restored).not.toBeNull();
    expect(restored.provider).toBe("claude");
    expect(restored.planTier).toBe("pro");
    expect(restored.updatedAt).toBe(NOW);
    expect(restored.windows).toHaveLength(1);
    expect(restored.windows[0]).toMatchObject({
      kind: "5h",
      quotaKey: "session (5h)",
      source: "probe",
      observedAt: NOW,
    });
    expect(restored.windows[0].usedFraction).toBeCloseTo(0.45, 6);

    // Runway forecast survived restart too
    const forecast = getQuotaForecasts(conn.id, NOW + MIN)["session (5h)"];
    expect(forecast).toMatchObject({
      state: "will-run-out",
      reason: null,
      remainingPct: 55,
      sampleCount: 4,
    });
    expect(forecast.burnPctPerHour).toBeCloseTo(90, 0);

    // Rate-limit cache was seeded on hydrate, so an immediate probe 1m later does not double-write
    vi.setSystemTime(NOW + MIN);
    await recordUsageSnapshot({
      connectionId: conn.id,
      provider: "claude",
      usage: { quotas: { "session (5h)": { remainingPercentage: 50, resetAt } } },
    });
    const rowsAfter = await listConnectionQuotaHistoryRows(null, conn.id, { now: NOW + 2 * MIN });
    expect(rowsAfter).toHaveLength(4);
  });

  it("does not resurrect expired windows and never overwrites a fresher live snapshot", async () => {
    const conn = await createProviderConnectionUnscoped({
      provider: "codex",
      authType: "oauth",
      name: "Expired & Fresh",
    });
    const db = await getAdapter();
    // Expired window (resetsAt in the past)
    db.run(
      `INSERT INTO quotaHistory (connectionId, provider, windowKind, quotaKey, usedFraction, resetsAt, source, ts)
       VALUES (?, 'codex', '5h', 'session', 0.9, ?, 'probe', ?)`,
      [conn.id, NOW - 10 * MIN, NOW - 2 * HOUR],
    );
    // Live weekly window persisted 20m ago
    db.run(
      `INSERT INTO quotaHistory (connectionId, provider, windowKind, quotaKey, usedFraction, resetsAt, source, ts)
       VALUES (?, 'codex', '7d', 'weekly', 0.3, ?, 'probe', ?)`,
      [conn.id, NOW + 5 * 24 * HOUR, NOW - 20 * MIN],
    );

    // Live probe already arrived 1m ago with 0.5 used
    recordProbeWindows(
      conn.id,
      "codex",
      [{ kind: "7d", usedFraction: 0.5, resetsAt: NOW + 5 * 24 * HOUR }],
      { planTier: "plus" },
      NOW - MIN,
    );

    await hydrateQuotaSnapshotsFromHistory({ now: NOW });
    const snap = getSnapshot(conn.id, NOW);
    // Fresher live snapshot (0.5 at NOW-1m) won over older persisted row (0.3 at NOW-20m)
    expect(snap.updatedAt).toBe(NOW - MIN);
    expect(snap.windows).toHaveLength(1);
    expect(snap.windows[0]).toMatchObject({ kind: "7d", usedFraction: 0.5 });

    // restoreSnapshot directly skips completely expired snapshots
    expect(
      restoreSnapshot(
        "other-conn",
        "codex",
        [{ kind: "5h", usedFraction: 0.8, resetsAt: NOW - 1000, observedAt: NOW - HOUR }],
        {},
        NOW,
      ),
    ).toBeNull();
  });

  it("persists header-derived quota windows via the fail-open header observer", async () => {
    const conn = await createProviderConnectionUnscoped({
      provider: "groq",
      authType: "apikey",
      name: "Groq Headers",
    });
    registerQuotaHistoryHeaderObserver();

    recordHeaderWindows(
      conn.id,
      "groq",
      [{ kind: "requests", usedFraction: 0.6, resetsAt: NOW + 15 * MIN }],
      NOW,
    );

    // Observer is async fire-and-forget; flush microtasks
    await Promise.resolve();
    await Promise.resolve();

    const rows = await listConnectionQuotaHistoryRows(null, conn.id, { now: NOW + 1000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connectionId: conn.id,
      provider: "groq",
      windowKind: "requests",
      source: "header",
      usedFraction: 0.6,
    });
  });
});

describe("computeForecastFromHistory (burn rate / runway from stored rows)", () => {
  it("computes will-run-out burn rate and emptyAt from persisted quotaHistory rows", () => {
    const resetAt = NOW + 5 * HOUR;
    // Used rises 0.10 → 0.20 → 0.30 → 0.40 over 30m (remaining drops 90 → 60 = 60%/h)
    const rows = [
      { ts: NOW - 30 * MIN, usedFraction: 0.1, resetsAt: resetAt },
      { ts: NOW - 20 * MIN, usedFraction: 0.2, resetsAt: resetAt },
      { ts: NOW - 10 * MIN, usedFraction: 0.3, resetsAt: resetAt },
      { ts: NOW, usedFraction: 0.4, resetsAt: resetAt },
    ];
    const forecast = computeForecastFromHistory(rows, { now: NOW });
    expect(forecast).toMatchObject({
      state: "will-run-out",
      reason: null,
      remainingPct: 60,
      sampleCount: 4,
      sampleSpanMs: 30 * MIN,
    });
    expect(forecast.burnPctPerHour).toBeCloseTo(60, 1);
    expect(Date.parse(forecast.emptyAt)).toBeCloseTo(NOW + HOUR, -3);
  });

  it("detects window reset rollovers so pre-reset samples do not skew post-reset burn rate", () => {
    const oldReset = NOW - 35 * MIN;
    const newReset = NOW + 5 * HOUR;
    const rows = [
      // Previous window near exhaustion
      { ts: NOW - 50 * MIN, usedFraction: 0.9, resetsAt: oldReset },
      { ts: NOW - 40 * MIN, usedFraction: 0.98, resetsAt: oldReset },
      // Window reset: used drops back to 0.05 and rises slowly (6%/h → on-track for 5h window)
      { ts: NOW - 30 * MIN, usedFraction: 0.05, resetsAt: newReset },
      { ts: NOW - 15 * MIN, usedFraction: 0.065, resetsAt: newReset },
      { ts: NOW, usedFraction: 0.08, resetsAt: newReset },
    ];
    const forecast = computeForecastFromHistory(rows, { now: NOW });
    expect(forecast).toMatchObject({
      state: "on-track",
      reason: null,
      sampleCount: 3,
    });
    expect(forecast.burnPctPerHour).toBeCloseTo(6, 1);
  });

  it("returns idle when consumption is flat and unknown when samples are insufficient", () => {
    const resetAt = NOW + 5 * HOUR;
    const flat = [
      { ts: NOW - 30 * MIN, usedFraction: 0.2, resetsAt: resetAt },
      { ts: NOW - 15 * MIN, usedFraction: 0.2, resetsAt: resetAt },
      { ts: NOW, usedFraction: 0.2, resetsAt: resetAt },
    ];
    expect(computeForecastFromHistory(flat, { now: NOW })).toMatchObject({ state: "idle" });

    const sparse = [
      { ts: NOW - 5 * MIN, usedFraction: 0.2, resetsAt: resetAt },
      { ts: NOW, usedFraction: 0.3, resetsAt: resetAt },
    ];
    expect(computeForecastFromHistory(sparse, { now: NOW })).toMatchObject({
      state: "unknown",
      reason: "insufficient-data",
    });
  });
});
