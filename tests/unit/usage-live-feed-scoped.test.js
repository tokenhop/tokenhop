// YAN-370: the live feed's pending counters and ring are keyed by workspace;
// a scoped subscriber sees only its own workspace, null merges all (today).
import { beforeEach, describe, expect, it, vi } from "vitest";

let feed;

beforeEach(async () => {
  // Fresh in-memory state BEFORE the import: the module persists it on
  // globals and captures the reference at load.
  vi.resetModules();
  global._pendingByWorkspace = {};
  global._pendingByIdentity = {};
  global._pendingTimers = {};
  global._recentRing = { items: [], initialized: true };
  const { getAdapter } = await import("@/lib/db/driver.js");
  const db = await getAdapter();
  db.run(`DELETE FROM usageHistory`);
  feed = await import("@/lib/db/repos/usageLiveFeed.js");
});

describe("usage live feed scoping", () => {
  it("getLiveSnapshot keeps the caller's workspace only; null merges both", async () => {
    feed.trackPendingRequest("gpt-4o", "openai", "c1", true, false, "w1");
    feed.trackPendingRequest("claude", "anthropic", "c2", true, false, "w2");
    feed.pushToRing({ provider: "openai", tokens: { prompt_tokens: 1 }, workspaceId: "w1" });
    feed.pushToRing({ provider: "anthropic", tokens: { prompt_tokens: 1 }, workspaceId: "w2" });

    const w1 = await feed.getLiveSnapshot({ workspaceId: "w1" });
    expect(w1.activeRequests).toEqual([{ provider: "openai", count: 1 }]);
    expect(w1.lastProvider).toBe("openai");

    const w2 = await feed.getLiveSnapshot({ workspaceId: "w2" });
    expect(w2.activeRequests).toEqual([{ provider: "anthropic", count: 1 }]);
    expect(w2.lastProvider).toBe("anthropic");

    const all = await feed.getLiveSnapshot(null);
    expect(all.activeRequests).toEqual([
      { provider: "openai", count: 1 },
      { provider: "anthropic", count: 1 },
    ]);
    expect(["openai", "anthropic"]).toContain(all.lastProvider);
  });
});

describe("identity-scoped pending (YAN-376)", () => {
  const active = (snap) => snap.activeRequests;

  it("same connection/model for two users stays separated and cleans up per identity", async () => {
    feed.trackPendingRequest("gpt-4o", "openai", "c1", true, false, "w1", "u1", "k1");
    feed.trackPendingRequest("gpt-4o", "openai", "c1", true, false, "w1", "u2", "k2");

    expect(active(await feed.getLiveSnapshot({ workspaceId: "w1" }))).toEqual([
      { provider: "openai", count: 2 },
    ]);
    expect(active(await feed.getLiveSnapshot({ workspaceId: "w1", userId: "u1" }))).toEqual([
      { provider: "openai", count: 1 },
    ]);
    expect(active(await feed.getLiveSnapshot({ workspaceId: "w1", apiKeyId: "k2" }))).toEqual([
      { provider: "openai", count: 1 },
    ]);
    const { getUsageStats } = await import("@/lib/db/repos/usageStatsRepo.js");
    const stats = await getUsageStats({ workspaceId: "w1", userId: "u1" }, "24h");
    expect(stats.pending.byModel["gpt-4o (openai)"]).toBe(1);

    // u1 finishes: only u1's count drops; u2 still in flight.
    feed.trackPendingRequest("gpt-4o", "openai", "c1", false, false, "w1", "u1", "k1");
    expect(active(await feed.getLiveSnapshot({ workspaceId: "w1", userId: "u1" }))).toEqual([]);
    expect(active(await feed.getLiveSnapshot({ workspaceId: "w1", userId: "u2" }))).toEqual([
      { provider: "openai", count: 1 },
    ]);
    expect(active(await feed.getLiveSnapshot({ workspaceId: "w1" }))).toEqual([
      { provider: "openai", count: 1 },
    ]);
  });

  it("ring entries and errors from other users or keys are hidden", async () => {
    feed.pushToRing({
      provider: "openai",
      tokens: { prompt_tokens: 1 },
      workspaceId: "w1",
      userId: "u1",
      apiKeyId: "k1",
    });
    feed.pushToRing({
      provider: "anthropic",
      tokens: { prompt_tokens: 1 },
      workspaceId: "w1",
      userId: "u2",
      apiKeyId: "k2",
    });
    feed.trackPendingRequest("claude", "anthropic", "c2", true, false, "w1", "u2", "k2");
    feed.trackPendingRequest("claude", "anthropic", "c2", false, true, "w1", "u2", "k2");

    const u1 = await feed.getLiveSnapshot({ workspaceId: "w1", userId: "u1" });
    expect(u1.lastProvider).toBe("openai");
    expect(u1.errorProvider).toBe("");
    const k2 = await feed.getLiveSnapshot({ workspaceId: "w1", apiKeyId: "k2" });
    expect(k2.lastProvider).toBe("anthropic");
    expect(k2.errorProvider).toBe("anthropic");
  });
});
