// Savings milestone toast (YAN-408): crossing detection, one acknowledgement
// per install persisted in settings, and the lifetime savings counter in the
// usage repo. Uses the per-file isolated DATA_DIR (see tests/README.md).
import { describe, it, expect, beforeAll, vi } from "vitest";

import { SAVINGS_MILESTONES } from "../../src/shared/constants/savingsMilestones.js";
import {
  pendingSavingsMilestone,
  normalizeAckedMilestone,
} from "../../src/lib/savingsMilestones.js";

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => ({ status: init?.status || 200, body, init }) },
}));

const { rowSavedFromSavings } = await import("@/lib/db/repos/usageRepo.js");

describe("SAVINGS_MILESTONES", () => {
  it("is the 100k / 1M / 10M ladder", () => {
    expect(SAVINGS_MILESTONES).toEqual([100_000, 1_000_000, 10_000_000]);
  });
});

describe("pendingSavingsMilestone", () => {
  it("returns null below the first milestone", () => {
    expect(pendingSavingsMilestone(0, 0)).toBeNull();
    expect(pendingSavingsMilestone(99_999, 0)).toBeNull();
  });

  it("returns the milestone once crossed", () => {
    expect(pendingSavingsMilestone(100_000, 0)).toBe(100_000);
    expect(pendingSavingsMilestone(123_456, 0)).toBe(100_000);
  });

  it("returns null for an acknowledged milestone", () => {
    expect(pendingSavingsMilestone(100_000, 100_000)).toBeNull();
    expect(pendingSavingsMilestone(150_000, 100_000)).toBeNull();
  });

  it("returns the highest crossed-but-unacknowledged milestone", () => {
    expect(pendingSavingsMilestone(1_500_000, 100_000)).toBe(1_000_000);
    expect(pendingSavingsMilestone(1_500_000, 0)).toBe(1_000_000);
    expect(pendingSavingsMilestone(10_000_000, 1_000_000)).toBe(10_000_000);
    expect(pendingSavingsMilestone(50_000_000, 10_000_000)).toBeNull();
  });

  it("rejects garbage inputs without throwing", () => {
    expect(pendingSavingsMilestone(NaN, NaN)).toBeNull();
    expect(pendingSavingsMilestone("1M", "x")).toBeNull();
  });
});

describe("normalizeAckedMilestone", () => {
  it("coerces to a positive integer milestone value", () => {
    expect(normalizeAckedMilestone(undefined)).toBe(0);
    expect(normalizeAckedMilestone(100_000)).toBe(100_000);
    expect(normalizeAckedMilestone("100000")).toBe(100_000);
    expect(normalizeAckedMilestone(-5)).toBe(0);
    expect(normalizeAckedMilestone(Number.NaN)).toBe(0);
    expect(normalizeAckedMilestone(100.9)).toBe(100);
  });
});

describe("rowSavedFromSavings", () => {
  it("sums only positive per-method savings", () => {
    expect(
      rowSavedFromSavings({
        byMethod: { rtk: { tokensSavedEst: 100 }, headroom: { tokensSavedEst: 50 } },
      }),
    ).toBe(150);
    expect(
      rowSavedFromSavings({
        byMethod: { rtk: { tokensSavedEst: 100 }, headroom: { tokensSavedEst: -3 } },
      }),
    ).toBe(100);
  });

  it("returns 0 for missing or empty savings", () => {
    expect(rowSavedFromSavings(null)).toBe(0);
    expect(rowSavedFromSavings({ byMethod: {} })).toBe(0);
    expect(rowSavedFromSavings({ tokensSavedEst: 999 })).toBe(0);
  });
});

describe("milestone state with the real DB", () => {
  let db;
  let milestones;
  let route;

  beforeAll(async () => {
    db = await import("@/lib/db/index.js");
    await db.initDb?.();
    milestones = await import("@/lib/savingsMilestones.js");
    route = await import("../../src/app/api/shell/savings-milestone/route.js");
  });

  async function seedSavings(savedTokens, timestamp = new Date().toISOString()) {
    await db.saveRequestUsage({
      provider: "openai",
      model: "gpt-4",
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      endpoint: "/v1/chat",
      status: "ok",
      timestamp,
      savings: {
        tokensSavedEst: savedTokens,
        tokensBeforeEst: savedTokens * 2,
        byMethod: { rtk: { tokensSavedEst: savedTokens, tokensBeforeEst: savedTokens * 2 } },
      },
    });
  }

  it("backfills the lifetime counter from pre-counter rows exactly once", async () => {
    // Direct inserts simulate an install upgraded with existing history and
    // no counter yet. Must run before any saveRequestUsage/getSavingsLifetime.
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { stringifyJson } = await import("@/lib/db/helpers/jsonCol.js");
    const adapter = await getAdapter();
    for (const saved of [10_000, 95_000]) {
      adapter.run(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          new Date().toISOString(),
          "openai",
          "gpt-4",
          null,
          null,
          "/v1/chat",
          10,
          5,
          0,
          "ok",
          stringifyJson({ prompt_tokens: 10, completion_tokens: 5 }),
          stringifyJson({
            savings: {
              tokensSavedEst: saved,
              byMethod: { rtk: { tokensSavedEst: saved, tokensBeforeEst: saved } },
            },
          }),
        ],
      );
    }
    expect(await db.getSavingsLifetime()).toBe(105_000);
    // Idempotent: a second read does not double-count.
    expect(await db.getSavingsLifetime()).toBe(105_000);
    // New rows increment the initialized counter (not another backfill).
    await seedSavings(5);
    expect(await db.getSavingsLifetime()).toBe(105_005);
  });

  it("counts lifetime savings from newly recorded rows", async () => {
    await seedSavings(40_000);
    await seedSavings(80_000);
    expect(await db.getSavingsLifetime()).toBe(225_005);
  });

  it("claims a pending milestone atomically and only once", async () => {
    await db.updateSettings({ savingsMilestoneAck: 0 });
    // Lifetime 225_005, nothing acked → 100k pending.
    expect(await milestones.claimSavingsMilestone(100_000)).toBe(100_000);
    expect((await db.getSettings()).savingsMilestoneAck).toBe(100_000);
    // A racing second claim gets null: the milestone is already acknowledged.
    expect(await milestones.claimSavingsMilestone(100_000)).toBeNull();
    // Claiming a milestone that isn't the current pending one is a no-op
    // (nothing is pending above 100k here).
    expect(await milestones.claimSavingsMilestone(1_000_000)).toBeNull();
    expect((await db.getSettings()).savingsMilestoneAck).toBe(100_000);
    // Invalid milestones are rejected.
    await expect(milestones.claimSavingsMilestone(500)).rejects.toThrow(/milestone/i);
  });

  it("acknowledges a milestone once and persists it in settings", async () => {
    await db.updateSettings({ savingsMilestoneAck: 100_000 });

    const result = await milestones.claimSavingsMilestone(1_000_000);
    expect(result).toBeNull(); // nothing pending: lifetime 225_005 < 1M
    expect((await db.getSettings()).savingsMilestoneAck).toBe(100_000);
  });

  it("POST validates the milestone input server-side", async () => {
    const call = (body) => route.POST({ json: async () => body });
    expect(await call({ milestone: 12345 })).toMatchObject({ status: 400 });
    expect(await call({ milestone: "100000" })).toMatchObject({ status: 400 });
    expect(await call({})).toMatchObject({ status: 400 });
    expect(await call(null)).toMatchObject({ status: 400 });
    await expect(
      route.POST({ json: () => Promise.reject(new Error("bad json")) }),
    ).resolves.toMatchObject({ status: 400 });
  });

  it("POST claims a valid milestone with no double-fire", async () => {
    await db.updateSettings({ savingsMilestoneAck: 0 });
    const first = await route.POST({ json: async () => ({ milestone: 100_000 }) });
    expect(first.status).toBe(200);
    // Claim succeeded for this call: 225_005 lifetime, 100k pending → claimed.
    expect(first.body).toEqual({ claimedMilestone: 100_000 });
    expect((await db.getSettings()).savingsMilestoneAck).toBe(100_000);
    // A racing call after the claim gets null (no second toast).
    const second = await route.POST({ json: async () => ({ milestone: 100_000 }) });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ claimedMilestone: null });
  });

  it("shell summary reports the pending milestone from lifetime + ack", async () => {
    const { GET } = await import("../../src/app/api/shell/summary/route.js");
    // Lifetime 225_005 with everything acked → no pending milestone, but the
    // block is present so clients can clear a shown toast.
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.body.savings).toEqual({ pendingMilestone: null });
    expect(res.body.traffic.total).toBeTypeOf("number");
  });
});

describe("claimSavingsMilestoneOnServer", () => {
  let claim;
  beforeAll(async () => {
    ({ claimSavingsMilestoneOnServer: claim } = await import(
      "../../src/shared/components/SavingsMilestoneWatcher.js"
    ));
  });

  it("resolves true only when the server claims the milestone for this client", async () => {
    const claimFetch = () =>
      Promise.resolve({ ok: true, json: async () => ({ claimedMilestone: 100_000 }) });
    expect(await claim(100_000, claimFetch)).toBe(true);
    const claimedElsewhere = () =>
      Promise.resolve({ ok: true, json: async () => ({ claimedMilestone: null }) });
    expect(await claim(100_000, claimedElsewhere)).toBe(false);
  });

  it("rejects on a failed request so the caller retries", async () => {
    const notOk = () => Promise.resolve({ ok: false, status: 500 });
    await expect(claim(100_000, notOk)).rejects.toThrow(/claim failed: 500/);
    const offline = () => Promise.reject(new Error("network down"));
    await expect(claim(100_000, offline)).rejects.toThrow(/network down/);
  });
});
