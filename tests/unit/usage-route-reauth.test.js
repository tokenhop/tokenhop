// YAN-1038 L2: the usage route's refresh helper treats {error} as not refreshed
// and never refreshes a connection that needs re-authentication.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refreshCredentials: vi.fn(),
  needsRefresh: vi.fn(() => true),
  update: vi.fn(async () => null),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionByIdUnscoped: vi.fn(),
  updateProviderConnectionUnscoped: mocks.update,
}));
vi.mock("@/lib/db/index.js", () => ({ getConnection: vi.fn() }));
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

const { refreshAndUpdateCredentials } = await import("@/app/api/usage/[connectionId]/route.js");

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
