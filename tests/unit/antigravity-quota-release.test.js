// YAN-1050: a positive exact-model usage poll releases an Antigravity
// CACHE_BLOCK that only the (unreachable) error path could otherwise replace.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionsUnscoped: vi.fn(),
  getSettings: vi.fn(async () => ({})),
  getAntigravityUsage: vi.fn(),
}));

vi.mock("@/lib/db/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getProviderConnectionsUnscoped: mocks.getProviderConnectionsUnscoped,
  getProviderConnectionByIdUnscoped: vi.fn(async () => null),
  mutateProviderConnectionUnscoped: vi.fn(),
  getSettings: mocks.getSettings,
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnectionUnscoped: vi.fn(),
  getEffectivePreferences: mocks.getSettings,
  mutateBillingLockUnscoped: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("open-sse/services/usage/google.js", () => ({
  getAntigravityUsage: mocks.getAntigravityUsage,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { getAntigravityQuotaCache, handleAntigravityQuotaError } = await import(
  "@/sse/services/antigravityQuota.js"
);
const { getProviderCredentials } = await import("@/sse/services/auth.js");
const { recordUsageSnapshot } = await import("@/sse/services/quotaSnapshotSync.js");
const { clearQuotaSnapshots } = await import("open-sse/services/quotaSnapshot.js");

const MODEL = "claude-opus-4-6-thinking";
const OTHER = "gemini-3-pro-high";
const NOW = Date.parse("2026-08-26T00:00:00.000Z");
const RESET = new Date(NOW + 4 * 3_600_000).toISOString();

let seq = 0;
let connId;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  getAntigravityQuotaCache().clear();
  clearQuotaSnapshots();
  seq += 1;
  connId = `ag-${seq}`;
  mocks.getProviderConnectionsUnscoped.mockResolvedValue([
    { id: connId, email: `${connId}@example.com`, isActive: true },
  ]);
  mocks.getAntigravityUsage.mockResolvedValue({
    quotas: { [MODEL]: { remainingPercentage: 0, resetAt: RESET } },
  });
  await expect(handleAntigravityQuotaError(connId, 429, MODEL, "token", {})).resolves.toBe(
    Date.parse(RESET),
  );
  await expect(getProviderCredentials("antigravity", null, MODEL)).resolves.toMatchObject({
    allRateLimited: true,
  });
  vi.setSystemTime(NOW + 60_000);
});

afterEach(() => {
  vi.useRealTimers();
});

const poll = (quotas, probeStartedAt = NOW + 30_000) =>
  recordUsageSnapshot({
    connectionId: connId,
    provider: "antigravity",
    usage: { quotas },
    probeStartedAt,
  });

const cached = () => getAntigravityQuotaCache().get(connId)?.[MODEL];

describe("Antigravity exact-cache release on a positive poll", () => {
  it("releases the block when the exact model reports headroom", async () => {
    await poll({ [MODEL]: { remainingPercentage: 60, resetAt: RESET } });
    expect(cached()).toBeUndefined();
    await expect(getProviderCredentials("antigravity", null, MODEL)).resolves.toMatchObject({
      connectionId: connId,
    });
  });

  it("keeps the block for a 100% (unknown) reading", async () => {
    await poll({ [MODEL]: { remainingPercentage: 100, resetAt: RESET } });
    expect(cached()).toMatchObject({ remainingPercentage: 0 });
  });

  it("keeps the block for empty quotas", async () => {
    await poll({});
    expect(cached()).toMatchObject({ remainingPercentage: 0 });
  });

  it("keeps the block when only another model reports headroom", async () => {
    await poll({ [OTHER]: { remainingPercentage: 60, resetAt: RESET } });
    expect(cached()).toMatchObject({ remainingPercentage: 0 });
  });

  it("keeps the block when the exact model is still exhausted", async () => {
    await poll({ [MODEL]: { remainingPercentage: 0, resetAt: RESET } });
    expect(cached()).toMatchObject({ remainingPercentage: 0 });
  });

  it("keeps a blocked Gemini model blocked on a positive gemini_weekly overlay", async () => {
    const gemini = "gemini-3-pro-high";
    mocks.getAntigravityUsage.mockResolvedValue({
      quotas: { [gemini]: { remainingPercentage: 0, resetAt: RESET } },
    });
    vi.setSystemTime(NOW + 2 * 60_000); // past the 30s per-connection refresh gate
    await handleAntigravityQuotaError(connId, 429, gemini, "token", {});
    expect(getAntigravityQuotaCache().get(connId)?.[gemini]).toMatchObject({
      remainingPercentage: 0,
    });

    await poll({ gemini_weekly: { remainingPercentage: 60, resetAt: RESET } }, NOW + 3 * 60_000);
    expect(getAntigravityQuotaCache().get(connId)?.[gemini]).toMatchObject({
      remainingPercentage: 0,
    });
  });

  it("keeps the block when the probe started before the block was written", async () => {
    await poll({ [MODEL]: { remainingPercentage: 60, resetAt: RESET } }, NOW - 1);
    expect(cached()).toMatchObject({ remainingPercentage: 0 });
  });

  it("keeps the block without a probe start timestamp", async () => {
    await recordUsageSnapshot({
      connectionId: connId,
      provider: "antigravity",
      usage: { quotas: { [MODEL]: { remainingPercentage: 60, resetAt: RESET } } },
    });
    expect(cached()).toMatchObject({ remainingPercentage: 0 });
  });

  it("never releases a strike-synthesized block", async () => {
    const strikeModel = "gemini-3-flash";
    vi.setSystemTime(NOW + 10 * 60_000);
    mocks.getAntigravityUsage.mockResolvedValue({
      quotas: { [strikeModel]: { remainingPercentage: 90, resetAt: RESET } },
    });
    // Strikes: quota API says 90% but generation keeps 429-ing (#3681). The
    // 30s refresh gate lets each strike reuse the cached optimistic reading.
    for (let i = 0; i < 3; i++) {
      await handleAntigravityQuotaError(connId, 429, strikeModel, "token", {});
    }
    const strike = getAntigravityQuotaCache().get(connId)?.[strikeModel];
    expect(strike).toMatchObject({ remainingPercentage: 0 });

    await poll({ [strikeModel]: { remainingPercentage: 90, resetAt: RESET } }, NOW + 11 * 60_000);
    expect(getAntigravityQuotaCache().get(connId)?.[strikeModel]).toMatchObject({
      remainingPercentage: 0,
    });
  });
});
