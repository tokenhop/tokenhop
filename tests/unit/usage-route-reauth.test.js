// YAN-1038 L2: the usage route's refresh helper treats {error} as not refreshed
// and never refreshes a connection that needs re-authentication.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refreshCredentials: vi.fn(),
  needsRefresh: vi.fn(() => true),
  update: vi.fn(async () => null),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/db/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getProviderConnectionByIdUnscoped: vi.fn(),
  updateProviderConnectionUnscoped: mocks.update,
  getConnection: vi.fn(),
}));
vi.mock("@/lib/users/workspaceScope.js", () => ({ loadScoped: vi.fn() }));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: vi.fn() }));
vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    needsRefresh: mocks.needsRefresh,
    refreshCredentials: mocks.refreshCredentials,
  }),
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn() }));
vi.mock("@/sse/services/quotaSnapshotSync", () => ({
  buildQuotaSnapshotView: vi.fn(),
  fetchAndPersistClaudePlanTier: vi.fn(),
  getSnapshot: vi.fn(),
  recordUsageSnapshot: vi.fn(),
}));
vi.mock("@/sse/services/accountSelection", () => ({ effectiveWeightFor: vi.fn() }));
vi.mock("@/shared/services/weightedTargets", () => ({ isWeightedProvider: vi.fn() }));
vi.mock("@/lib/quota/forecastStore.js", () => ({ getQuotaForecasts: vi.fn() }));

const { refreshAndUpdateCredentials, GET } = await import(
  "@/app/api/usage/[connectionId]/route.js"
);
const { loadScoped } = await import("@/lib/users/workspaceScope.js");
const { getUsageForProvider } = await import("open-sse/services/usage.js");
const { resolveConnectionProxyConfig } = await import("@/lib/network/connectionProxy");
const { recordUsageSnapshot, buildQuotaSnapshotView } = await import(
  "@/sse/services/quotaSnapshotSync"
);

const conn = (extra = {}) => ({
  id: "c1",
  provider: "codex",
  authType: "oauth",
  accessToken: "at-1",
  refreshToken: "rt-1",
  ...extra,
});

beforeEach(() => vi.clearAllMocks());

describe("refreshAndUpdateCredentials", () => {
  it("does not report refreshed:true (or persist) for an {error} result", async () => {
    mocks.refreshCredentials.mockResolvedValue({
      error: "unrecoverable_refresh_error",
      code: "refresh_token_reused",
    });
    const r = await refreshAndUpdateCredentials(conn(), true);
    expect(r.refreshed).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("throws on an {error} result when there is no access token to fall back on", async () => {
    mocks.refreshCredentials.mockResolvedValue({ error: "unrecoverable_refresh_error" });
    await expect(
      refreshAndUpdateCredentials(conn({ accessToken: undefined }), true),
    ).rejects.toThrow(/re-authorize/i);
  });

  it("skips a flagged connection before attempting any refresh", async () => {
    const flagged = conn({
      reauthRequired: { reason: "refresh_token_rejected", code: "refresh_token_reused", at: "x" },
    });
    const r = await refreshAndUpdateCredentials(flagged, true);
    expect(r).toEqual({ connection: flagged, refreshed: false });
    expect(mocks.refreshCredentials).not.toHaveBeenCalled();
  });

  it("still refreshes a healthy connection", async () => {
    mocks.refreshCredentials.mockResolvedValue({ accessToken: "at-2", expiresIn: 3600 });
    const r = await refreshAndUpdateCredentials(conn(), true);
    expect(r.refreshed).toBe(true);
    expect(mocks.update).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ accessToken: "at-2" }),
    );
  });
});

describe("GET /api/usage/[connectionId] probe start (YAN-1049)", () => {
  it("passes a probeStartedAt captured before the usage fetch", async () => {
    const apikey = { id: "g1", provider: "glm", authType: "apikey", apiKey: "k" };
    loadScoped.mockResolvedValue({ scope: null, row: apikey });
    resolveConnectionProxyConfig.mockResolvedValue({});
    buildQuotaSnapshotView.mockReturnValue({ windows: [] });
    let fetchStartedAt;
    getUsageForProvider.mockImplementation(async () => {
      fetchStartedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { quotas: { "Session (5h)": { remainingPercentage: 50 } } };
    });

    const res = await GET(new Request("http://localhost/api/usage/g1"), {
      params: Promise.resolve({ connectionId: "g1" }),
    });

    expect(res.status).toBe(200);
    expect(recordUsageSnapshot).toHaveBeenCalledTimes(1);
    const { probeStartedAt } = recordUsageSnapshot.mock.calls[0][0];
    expect(Number.isFinite(probeStartedAt)).toBe(true);
    expect(probeStartedAt).toBeLessThanOrEqual(fetchStartedAt);
  });
});
