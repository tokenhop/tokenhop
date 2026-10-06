import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  getProviderConnectionByIdUnscoped: vi.fn(),
  updateProviderConnectionUnscoped: vi.fn(async () => true),
  getProviderConnectionsUnscoped: vi.fn(async () => []),
  getProviderConnectionByIdSync: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: mocks.json },
}));

vi.mock("open-sse/index.js", () => ({}), { virtual: true });

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({})),
  getProviderConnectionsUnscoped: mocks.getProviderConnectionsUnscoped,
  getProviderConnectionByIdUnscoped: mocks.getProviderConnectionByIdUnscoped,
  getCombos: vi.fn(async () => []),
  updateProviderConnectionUnscoped: mocks.updateProviderConnectionUnscoped,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));

vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: vi.fn(async (connection) => ({ connection, refreshed: false })),
}));

vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: vi.fn(),
}));

vi.mock("open-sse/services/usage/claude.js", () => ({
  fetchClaudePlanTier: vi.fn(async () => "default_claude_max_20x"),
}));

describe("weighted account overrides", () => {
  let sync;
  let store;
  let PUT;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ({ PUT } = await import("../../src/app/api/providers/[id]/route.js"));
    store = await import("open-sse/services/quotaSnapshot.js");
    sync = await import("../../src/sse/services/quotaSnapshotSync.js");
    store.clearQuotaSnapshots();
    sync._resetQuotaSnapshotSync();
    mocks.getProviderConnectionsUnscoped.mockResolvedValue([]);
  });

  function putRequest(id, providerSpecificData) {
    return new Request(`https://tokenhop.local/api/providers/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerSpecificData }),
    });
  }

  it("accepts weight and manual tier while preserving unrelated psd fields", async () => {
    mocks.getProviderConnectionByIdUnscoped.mockResolvedValue({
      id: "c1",
      provider: "claude",
      providerSpecificData: { region: "us", weight: 2 },
    });

    const response = await PUT(
      putRequest("c1", {
        planTier: "default_claude_max_20x",
        planTierManual: true,
        weight: 5,
      }),
      { params: Promise.resolve({ id: "c1" }) },
    );

    expect(response.body).not.toHaveProperty("error");
    // YAN-365: the route sends a PSD delta (only changed keys); the repo merges
    // onto live siblings, so unrelated `region` is preserved without being sent.
    expect(mocks.updateProviderConnectionUnscoped).toHaveBeenCalledWith("c1", {
      providerSpecificData: {
        planTier: "default_claude_max_20x",
        planTierManual: true,
        weight: 5,
      },
    });
  });

  it("clears weighted overrides with null without touching other psd fields", async () => {
    mocks.getProviderConnectionByIdUnscoped.mockResolvedValue({
      id: "c1",
      provider: "claude",
      providerSpecificData: { region: "us", weight: 5, planTier: "pro", planTierManual: true },
    });

    store.recordProbeWindows("c1", "claude", [{ kind: "5h", usedFraction: 0.2 }], {
      planTier: "pro",
    });
    await PUT(putRequest("c1", { weight: null, planTier: null, planTierManual: null }), {
      params: Promise.resolve({ id: "c1" }),
    });

    // YAN-365: delta with explicit nulls (repo deletes those live keys); `region`
    // is untouched because it is absent from the patch.
    expect(mocks.updateProviderConnectionUnscoped).toHaveBeenCalledWith("c1", {
      providerSpecificData: { weight: null, planTier: null, planTierManual: null },
    });
    expect(store.getSnapshot("c1").planTier).toBeNull();
    expect(store.getSnapshot("c1").windows).toHaveLength(1);
  });

  it("clears a manual snapshot tier when plan alone is reset", async () => {
    mocks.getProviderConnectionByIdUnscoped.mockResolvedValue({
      id: "c1",
      provider: "claude",
      providerSpecificData: { planTier: "pro", planTierManual: true },
    });
    store.recordProbeWindows("c1", "claude", [], { planTier: "pro" });

    await PUT(putRequest("c1", { planTier: null }), {
      params: Promise.resolve({ id: "c1" }),
    });

    expect(store.getSnapshot("c1").planTier).toBeNull();
  });

  it("rejects out-of-range weights, unknown tiers, and dangerous keys", async () => {
    mocks.getProviderConnectionByIdUnscoped.mockResolvedValue({
      id: "c1",
      provider: "claude",
      providerSpecificData: {},
    });

    for (const psd of [
      { weight: 1001 },
      { weight: -1 },
      { weight: "5" },
      { planTier: "enterprise" },
      { planTierManual: "yes" },
      JSON.parse('{"__proto__":{"weight":1}}'),
      JSON.parse('{"constructor":{"weight":1}}'),
    ]) {
      const response = await PUT(putRequest("c1", psd), {
        params: Promise.resolve({ id: "c1" }),
      });

      expect(response.status).toBe(400);
    }
    expect(mocks.updateProviderConnectionUnscoped).not.toHaveBeenCalled();
  });

  it("does not refresh a blocked snapshot from a fallback tier alone", async () => {
    const observedAt = Date.now() - 60_000;
    store.recordProbeWindows(
      "codex-blocked",
      "codex",
      [{ kind: "5h", usedFraction: 1, resetsAt: Date.now() + 600_000 }],
      {},
      observedAt,
    );

    await sync.recordUsageSnapshot({
      connectionId: "codex-blocked",
      provider: "codex",
      usage: { plan: "unknown", quotas: {} },
      fallbackTier: "pro",
    });

    expect(store.getSnapshot("codex-blocked")).toMatchObject({
      updatedAt: observedAt,
      planTier: null,
      windows: [expect.objectContaining({ usedFraction: 1 })],
    });
  });

  it("never overwrites a manual plan tier during auto detection", async () => {
    mocks.getProviderConnectionByIdUnscoped.mockResolvedValue({
      id: "codex-manual",
      providerSpecificData: { planTier: "plus", planTierManual: true },
    });

    await sync.recordUsageSnapshot({
      connectionId: "codex-manual",
      provider: "codex",
      usage: { plan: "Pro", quotas: {} },
    });

    expect(mocks.updateProviderConnectionUnscoped).not.toHaveBeenCalled();
    expect(store.getSnapshot("codex-manual")).toMatchObject({ planTier: "pro" });
  });

  it("preserves manual overrides on OAuth re-login while updating fresh tokens", async () => {
    const { createProviderConnectionUnscoped } = await import(
      "../../src/lib/db/repos/connectionsRepo.js"
    );
    const created = await createProviderConnectionUnscoped({
      provider: "claude",
      authType: "oauth",
      email: "user@example.com",
      name: "First",
      providerSpecificData: {
        planTier: "pro",
        planTierManual: true,
        weight: 7,
        region: "us",
      },
    });

    const relogin = await createProviderConnectionUnscoped({
      provider: "claude",
      authType: "oauth",
      email: "user@example.com",
      name: "Second",
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
      providerSpecificData: { accessToken: "fresh-access" },
    });

    expect(relogin.id).toBe(created.id);
    expect(relogin.accessToken).toBe("fresh-access");
    expect(relogin.refreshToken).toBe("fresh-refresh");
    expect(relogin.providerSpecificData).toMatchObject({
      planTier: "pro",
      planTierManual: true,
      weight: 7,
      region: "us",
      accessToken: "fresh-access",
    });
  });

  it("clears stale auto-detected tier on OAuth re-login so it re-detects", async () => {
    const { createProviderConnectionUnscoped } = await import(
      "../../src/lib/db/repos/connectionsRepo.js"
    );
    const created = await createProviderConnectionUnscoped({
      provider: "claude",
      authType: "oauth",
      email: "auto@example.com",
      providerSpecificData: {
        planTier: "pro",
        planTierCheckedAt: 123,
        weight: 3,
        connectionProxyUrl: "http://proxy.local:8080",
      },
    });

    const relogin = await createProviderConnectionUnscoped({
      provider: "claude",
      authType: "oauth",
      email: "auto@example.com",
      accessToken: "fresh-access",
      providerSpecificData: { accessToken: "fresh-access" },
    });

    expect(relogin.id).toBe(created.id);
    expect(relogin.providerSpecificData).not.toHaveProperty("planTier");
    expect(relogin.providerSpecificData).not.toHaveProperty("planTierCheckedAt");
    expect(relogin.providerSpecificData).toMatchObject({
      weight: 3,
      connectionProxyUrl: "http://proxy.local:8080",
      accessToken: "fresh-access",
    });
  });
});
