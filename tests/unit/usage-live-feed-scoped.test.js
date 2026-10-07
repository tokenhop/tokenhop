// YAN-370: the live feed's pending counters and ring are keyed by workspace;
// a scoped subscriber sees only its own workspace, null merges all (today).
import { beforeEach, describe, expect, it } from "vitest";

let feed;

beforeEach(async () => {
  // Fresh in-memory state BEFORE the import: the module persists it on
  // globals and captures the reference at load.
  global._pendingByWorkspace = {};
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
