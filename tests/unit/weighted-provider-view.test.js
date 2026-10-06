import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearQuotaSnapshots, recordProbeWindows } from "open-sse/services/quotaSnapshot.js";

const mocks = vi.hoisted(() => ({
  getProviderConnectionsUnscoped: vi.fn(),
  getProviderConnectionByIdUnscoped: vi.fn(),
  getUsageForProvider: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}), { virtual: true });
vi.mock("@/lib/db/repos/connectionsRepo.js", () => ({
  getProviderConnectionsMetadataUnscoped: mocks.getProviderConnectionsUnscoped,
}));
vi.mock("@/lib/db/repos/nodesRepo.js", () => ({
  getProviderNodesMetadataUnscoped: vi.fn(async () => []),
  listNodesMetadata: vi.fn(async () => []),
}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionByIdUnscoped: mocks.getProviderConnectionByIdUnscoped,
  updateProviderConnectionUnscoped: vi.fn(),
}));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: mocks.getUsageForProvider }));
vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: () => ({ needsRefresh: () => false }),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));
vi.mock("@/shared/services/weightedTargets", () => ({ isWeightedProvider: () => false }));
vi.mock("@/sse/services/quotaSnapshotSync", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    recordUsageSnapshot: vi.fn(async () => null),
  };
});

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => ({ status: init?.status || 200, body }) },
}));
vi.mock("@/models", () => ({
  getProviderConnectionsUnscoped: mocks.getProviderConnectionsUnscoped,
  getProviderNodesUnscoped: vi.fn(async () => []),
  createProviderConnectionUnscoped: vi.fn(),
  getProviderNodeByIdUnscoped: vi.fn(),
  getProxyPoolById: vi.fn(),
}));

const { GET } = await import("@/app/api/providers/route.js");

describe("GET /api/providers effectiveWeight", () => {
  beforeEach(() => clearQuotaSnapshots());

  it("adds decomposed weight using manual tier/weight and hides credentials", async () => {
    // Snapshot detected pro, but manual tier wins; one has manual weight override.
    recordProbeWindows("a", "claude", [{ kind: "5h", usedFraction: 0.5 }], { planTier: "pro" });
    mocks.getProviderConnectionsUnscoped.mockResolvedValue([
      {
        id: "a",
        provider: "claude",
        accessToken: "secret-a",
        refreshToken: "secret-r",
        providerSpecificData: { planTier: "default_claude_max_20x", planTierManual: true },
      },
      { id: "b", provider: "claude", apiKey: "secret-k", providerSpecificData: { weight: 3 } },
      { id: "c", provider: "claude", providerSpecificData: {} },
    ]);

    const { body } = await GET();
    const [a, b, c] = body.connections;

    expect(a.effectiveWeight).toEqual({
      weight: 10,
      base: 20,
      baseSource: "plan",
      headroom: 0.5,
      headroomSource: "probe",
      belowFloor: false,
    });
    expect(b.effectiveWeight).toMatchObject({
      weight: 3,
      baseSource: "manual",
      headroomSource: "static",
    });
    expect(c.effectiveWeight).toMatchObject({ weight: 1, baseSource: "default" });
    expect(JSON.stringify(body)).not.toMatch(/secret-/);
  });

  it("usage GET returns a stale base-weight view when no snapshot exists", async () => {
    mocks.getProviderConnectionByIdUnscoped.mockResolvedValue({
      id: "a",
      provider: "claude",
      authType: "oauth",
      providerSpecificData: { planTier: "default_claude_max_20x", planTierManual: true },
    });
    mocks.getUsageForProvider.mockResolvedValue({ quotas: {} });

    const { GET: usageGET } = await import("@/app/api/usage/[connectionId]/route.js");
    const res = await usageGET(new Request("http://localhost/api/usage/a"), {
      params: Promise.resolve({ connectionId: "a" }),
    });
    const body = await res.json();

    expect(body.quotaSnapshot).toMatchObject({
      planTier: "default_claude_max_20x",
      windows: [],
      stale: true,
      updatedAt: null,
    });
    expect(body.quotaSnapshot.effectiveWeight).toMatchObject({
      weight: 20,
      base: 20,
      baseSource: "plan",
      headroomSource: "static",
    });
  });
});
