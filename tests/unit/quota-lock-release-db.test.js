// YAN-1049: a positive usage poll releases a persisted quota-reset model lock,
// against the real SQLite layer. Only quota-owned locks (with metadata) are
// released, only by a poll that started after the lock, and only when the
// matching window shows headroom.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const scopeMock = vi.hoisted(() => ({ connections: null }));
vi.mock("@/lib/users/workspaceScope.js", () => ({
  scopedConnections: async (_request, _capability, filter) => ({
    scope: null,
    connections: await scopeMock.connections(filter),
  }),
}));

let db;
let auth;
let sync;
let release;

const GITHUB_MONTHLY =
  "You've reached your additional usage limit for your plan. Go to GitHub settings for details.";
const META_ALL = "modelLockMeta___all";
const positiveGithub = { quotas: { premium_interactions: { remainingPercentage: 40 } } };

beforeAll(async () => {
  db = await import("@/lib/db/index.js");
  await db.initDb();
  scopeMock.connections = (filter) => db.getProviderConnectionsUnscoped(filter);
  auth = await import("../../src/sse/services/auth.js");
  sync = await import("../../src/sse/services/quotaSnapshotSync.js");
  release = await import("../../src/sse/services/quotaLockRelease.js");
}, 30000); // first auth.js import pulls the real module graph

let seq = 0;
async function githubConn() {
  seq += 1;
  return db.createProviderConnectionUnscoped({
    provider: "github",
    authType: "oauth",
    email: `gh-${seq}@example.com`,
    accessToken: `tok-${seq}`,
  });
}

async function codexConn() {
  seq += 1;
  return db.createProviderConnectionUnscoped({
    provider: "codex",
    authType: "oauth",
    email: `cx-${seq}@example.com`,
    accessToken: `tok-${seq}`,
  });
}

const row = (id) => db.getProviderConnectionByIdUnscoped(id);

async function lockGithubMonthly(id) {
  await auth.markAccountUnavailable(id, 402, GITHUB_MONTHLY, "github", "claude-x");
  const locked = await row(id);
  expect(locked.modelLock___all).toBeTruthy();
  expect(locked[META_ALL]).toMatchObject({
    reason: "quota_reset",
    window: "quota:premium_interactions",
  });
  return locked;
}

describe("quota lock release on a positive poll", () => {
  it("releases the GitHub monthly lock when a newer poll shows premium headroom", async () => {
    const conn = await githubConn();
    const locked = await lockGithubMonthly(conn.id);

    await sync.recordUsageSnapshot({
      connectionId: conn.id,
      provider: "github",
      usage: positiveGithub,
      probeStartedAt: locked[META_ALL].lockedAt + 1,
    });

    const after = await row(conn.id);
    expect(after.modelLock___all ?? null).toBeNull();
    expect(after[META_ALL] ?? null).toBeNull();
    expect(after.testStatus).toBe("active");
    expect(after.lastError ?? null).toBeNull();
  });

  it("releases a Codex provider-reset lock when every applicable window has headroom", async () => {
    const conn = await codexConn();
    await auth.markAccountUnavailable(
      conn.id,
      429,
      "usage limit reached",
      "codex",
      "gpt-5",
      Date.now() + 5 * 3_600_000,
    );
    const locked = await row(conn.id);
    expect(locked["modelLockMeta_gpt-5"]).toMatchObject({ reason: "quota_reset", window: null });

    await sync.recordUsageSnapshot({
      connectionId: conn.id,
      provider: "codex",
      usage: {
        quotas: {
          session: { remainingPercentage: 70, windowMinutes: 300 },
          weekly: { remainingPercentage: 20, windowMinutes: 10080 },
        },
      },
      probeStartedAt: locked["modelLockMeta_gpt-5"].lockedAt + 1,
    });

    const after = await row(conn.id);
    expect(after["modelLock_gpt-5"] ?? null).toBeNull();
    expect(after["modelLockMeta_gpt-5"] ?? null).toBeNull();
  });

  it("keeps the lock when the poll started before the lock (stale poll)", async () => {
    const conn = await githubConn();
    const locked = await lockGithubMonthly(conn.id);
    await sync.recordUsageSnapshot({
      connectionId: conn.id,
      provider: "github",
      usage: positiveGithub,
      probeStartedAt: locked[META_ALL].lockedAt - 1,
    });
    expect((await row(conn.id)).modelLock___all).toBe(locked.modelLock___all);
  });

  it("keeps the lock without a poll start timestamp", async () => {
    const conn = await githubConn();
    const locked = await lockGithubMonthly(conn.id);
    await sync.recordUsageSnapshot({
      connectionId: conn.id,
      provider: "github",
      usage: positiveGithub,
    });
    expect((await row(conn.id)).modelLock___all).toBe(locked.modelLock___all);
  });

  it("keeps the lock when the matching window is still exhausted", async () => {
    const conn = await githubConn();
    const locked = await lockGithubMonthly(conn.id);
    await sync.recordUsageSnapshot({
      connectionId: conn.id,
      provider: "github",
      usage: { quotas: { premium_interactions: { remainingPercentage: 0 } } },
      probeStartedAt: locked[META_ALL].lockedAt + 1,
    });
    expect((await row(conn.id)).modelLock___all).toBe(locked.modelLock___all);
  });

  it("never releases the GitHub monthly lock from chat/completions readings alone", async () => {
    const conn = await githubConn();
    const locked = await lockGithubMonthly(conn.id);
    // Free/limited plan format: no premium_interactions key at all.
    await sync.recordUsageSnapshot({
      connectionId: conn.id,
      provider: "github",
      usage: {
        quotas: { chat: { remainingPercentage: 60 }, completions: { remainingPercentage: 80 } },
      },
      probeStartedAt: locked[META_ALL].lockedAt + 1,
    });
    // Unlimited premium reading (null used fraction) next to positive chat.
    await sync.recordUsageSnapshot({
      connectionId: conn.id,
      provider: "github",
      usage: {
        quotas: {
          chat: { remainingPercentage: 60 },
          premium_interactions: { used: 0, total: 0, unlimited: true },
        },
      },
      probeStartedAt: locked[META_ALL].lockedAt + 1,
    });
    expect((await row(conn.id)).modelLock___all).toBe(locked.modelLock___all);
  });

  it("keeps a null-window Codex lock when one applicable window is still exhausted", async () => {
    const conn = await codexConn();
    await auth.markAccountUnavailable(
      conn.id,
      429,
      "usage limit reached",
      "codex",
      "gpt-5",
      Date.now() + 5 * 3_600_000,
    );
    const locked = await row(conn.id);
    await sync.recordUsageSnapshot({
      connectionId: conn.id,
      provider: "codex",
      usage: {
        quotas: {
          session: { remainingPercentage: 0, windowMinutes: 300 },
          weekly: { remainingPercentage: 50, windowMinutes: 10080 },
        },
      },
      probeStartedAt: locked["modelLockMeta_gpt-5"].lockedAt + 1,
    });
    expect((await row(conn.id))["modelLock_gpt-5"]).toBe(locked["modelLock_gpt-5"]);
  });

  it("keeps a Codex lock while the usage payload says limitReached", async () => {
    const conn = await codexConn();
    await auth.markAccountUnavailable(
      conn.id,
      429,
      "usage limit reached",
      "codex",
      "gpt-5",
      Date.now() + 5 * 3_600_000,
    );
    const locked = await row(conn.id);
    await sync.recordUsageSnapshot({
      connectionId: conn.id,
      provider: "codex",
      usage: {
        limitReached: true,
        quotas: {
          session: { remainingPercentage: 1, windowMinutes: 300 },
          weekly: { remainingPercentage: 50, windowMinutes: 10080 },
        },
      },
      probeStartedAt: locked["modelLockMeta_gpt-5"].lockedAt + 1,
    });
    expect((await row(conn.id))["modelLock_gpt-5"]).toBe(locked["modelLock_gpt-5"]);
  });

  it("never releases from a header-sourced snapshot", async () => {
    const conn = await codexConn();
    await auth.markAccountUnavailable(
      conn.id,
      429,
      "usage limit reached",
      "codex",
      "gpt-5",
      Date.now() + 5 * 3_600_000,
    );
    const locked = await row(conn.id);
    await sync.recordUsageSnapshot({
      connectionId: conn.id,
      provider: "codex",
      source: "header",
      usage: {
        quotas: {
          session: { remainingPercentage: 90, windowMinutes: 300 },
          weekly: { remainingPercentage: 90, windowMinutes: 10080 },
        },
      },
      probeStartedAt: locked["modelLockMeta_gpt-5"].lockedAt + 1,
    });
    expect((await row(conn.id))["modelLock_gpt-5"]).toBe(locked["modelLock_gpt-5"]);
  });

  it("keeps the lock when the poll only reports another window kind", async () => {
    const conn = await codexConn();
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const lockedAt = Date.now() - 1000;
    await db.updateProviderConnectionUnscoped(conn.id, {
      "modelLock_gpt-5": until,
      "modelLockMeta_gpt-5": { reason: "quota_reset", window: "7d", lockedAt, generation: 1 },
    });
    await sync.recordUsageSnapshot({
      connectionId: conn.id,
      provider: "codex",
      usage: { quotas: { session: { remainingPercentage: 90, windowMinutes: 300 } } },
      probeStartedAt: lockedAt + 1,
    });
    expect((await row(conn.id))["modelLock_gpt-5"]).toBe(until);
  });

  it("never releases a lock without quota metadata (e.g. a 5xx lock)", async () => {
    const conn = await githubConn();
    await auth.markAccountUnavailable(conn.id, 503, "Service unavailable", "github", "claude-x");
    const locked = await row(conn.id);
    expect(locked["modelLock_claude-x"]).toBeTruthy();
    expect(locked["modelLockMeta_claude-x"] ?? null).toBeNull();

    await sync.recordUsageSnapshot({
      connectionId: conn.id,
      provider: "github",
      usage: positiveGithub,
      probeStartedAt: Date.now() + 1000,
    });
    expect((await row(conn.id))["modelLock_claude-x"]).toBe(locked["modelLock_claude-x"]);
  });

  it("a non-quota lock on the same key drops stale quota metadata", async () => {
    const conn = await codexConn();
    await auth.markAccountUnavailable(
      conn.id,
      429,
      "usage limit reached",
      "codex",
      "gpt-5",
      Date.now() + 5 * 3_600_000,
    );
    await auth.markAccountUnavailable(conn.id, 503, "Service unavailable", "codex", "gpt-5");
    expect((await row(conn.id))["modelLockMeta_gpt-5"] ?? null).toBeNull();
  });

  it("does not release when a newer generation was written after the plan", async () => {
    const conn = await githubConn();
    const locked = await lockGithubMonthly(conn.id);
    const metadataRow = await row(conn.id);
    const readings = new Map([["premium_interactions", 0.5]]);
    const plan = release.planQuotaLockRelease(
      metadataRow,
      [],
      locked[META_ALL].lockedAt + 1,
      readings,
    );
    expect(plan.map((c) => c.lockKey)).toEqual(["modelLock___all"]);

    // Concurrent re-lock between the plan and the transactional apply.
    await auth.markAccountUnavailable(conn.id, 402, GITHUB_MONTHLY, "github", "claude-x");
    const relocked = await row(conn.id);
    expect(relocked[META_ALL].generation).toBeGreaterThan(locked[META_ALL].generation);

    const result = await release.applyQuotaLockRelease(conn.id, plan);
    expect(result.released).toEqual([]);
    expect((await row(conn.id)).modelLock___all).toBe(relocked.modelLock___all);
  });

  it("leaves billingLock, reauth state and isActive untouched", async () => {
    const conn = await githubConn();
    const locked = await lockGithubMonthly(conn.id);
    const billingLock = { reason: "credit_exhausted", generation: 7 };
    await db.updateProviderConnectionUnscoped(conn.id, {
      billingLock,
      billingLockGeneration: 7,
      reauthRequired: { reason: "refresh_rejected" },
    });
    await sync.recordUsageSnapshot({
      connectionId: conn.id,
      provider: "github",
      usage: positiveGithub,
      probeStartedAt: locked[META_ALL].lockedAt + 1,
    });
    const after = await row(conn.id);
    expect(after.modelLock___all ?? null).toBeNull();
    expect(after.billingLock).toEqual(billingLock);
    expect(after.billingLockGeneration).toBe(7);
    expect(after.reauthRequired).toEqual({ reason: "refresh_rejected" });
    expect(after.isActive).toBe(true);
  });

  it("clearAccountError drops the metadata with the lock", async () => {
    const conn = await githubConn();
    await lockGithubMonthly(conn.id);
    await auth.clearAccountError(conn.id, await row(conn.id), "claude-x");
    const after = await row(conn.id);
    expect(after.modelLock___all ?? null).toBeNull();
    expect(after[META_ALL] ?? null).toBeNull();
  });

  it("the activation reset (testStatus active) drops the metadata", async () => {
    const conn = await githubConn();
    await lockGithubMonthly(conn.id);
    await db.updateProviderConnectionUnscoped(conn.id, { testStatus: "active" });
    const after = await row(conn.id);
    expect(after.modelLock___all ?? null).toBeNull();
    expect(after[META_ALL] ?? null).toBeNull();
  });

  it("the manual cooldown clear drops the metadata", async () => {
    const conn = await codexConn();
    await auth.markAccountUnavailable(
      conn.id,
      429,
      "usage limit reached",
      "codex",
      "gpt-5",
      Date.now() + 5 * 3_600_000,
    );
    const { POST } = await import("@/app/api/models/availability/route.js");
    const res = await POST(
      new Request("http://localhost/api/models/availability", {
        method: "POST",
        body: JSON.stringify({ action: "clearCooldown", provider: "codex", model: "gpt-5" }),
      }),
    );
    expect(res.status).toBe(200);
    const after = await row(conn.id);
    expect(after["modelLock_gpt-5"] ?? null).toBeNull();
    expect(after["modelLockMeta_gpt-5"] ?? null).toBeNull();
  });

  it("clearQuotaOwnedLocks (reset-credit spend) clears only quota-owned locks", async () => {
    const conn = await codexConn();
    await auth.markAccountUnavailable(
      conn.id,
      429,
      "usage limit reached",
      "codex",
      "gpt-5",
      Date.now() + 5 * 3_600_000,
    );
    await auth.markAccountUnavailable(conn.id, 503, "Service unavailable", "codex", "gpt-4o");
    await release.clearQuotaOwnedLocks(conn.id, { before: Date.now() + 1 });
    const after = await row(conn.id);
    expect(after["modelLock_gpt-5"] ?? null).toBeNull();
    expect(after["modelLockMeta_gpt-5"] ?? null).toBeNull();
    expect(after["modelLock_gpt-4o"]).toBeTruthy();
    expect(after.testStatus).toBe("unavailable");
  });

  it("clearQuotaOwnedLocks keeps a quota lock written after the spend started", async () => {
    const conn = await codexConn();
    const spendStartedAt = Date.now() - 1000;
    await auth.markAccountUnavailable(
      conn.id,
      429,
      "usage limit reached",
      "codex",
      "gpt-5",
      Date.now() + 5 * 3_600_000,
    );
    const locked = await row(conn.id);
    expect(locked["modelLockMeta_gpt-5"].lockedAt).toBeGreaterThan(spendStartedAt);
    const { released } = await release.clearQuotaOwnedLocks(conn.id, { before: spendStartedAt });
    expect(released).toEqual([]);
    const after = await row(conn.id);
    expect(after["modelLock_gpt-5"]).toBe(locked["modelLock_gpt-5"]);
    expect(after["modelLockMeta_gpt-5"]).toEqual(locked["modelLockMeta_gpt-5"]);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});
