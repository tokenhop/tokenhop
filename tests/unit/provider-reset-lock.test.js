// YAN-1048: a provider-reported quota reset (e.g. Codex usage_limit_reached
// resets_at) keeps the model lock until that reset, bounded by
// cooldowns.providerResetCapMs, instead of the 30-min rateLimitCapMs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => {
  const m = {
    getProviderConnectionsUnscoped: vi.fn(),
    updateProviderConnectionUnscoped: vi.fn(),
    getSettings: vi.fn(async () => ({})),
    live: {},
  };
  m.mutateProviderConnectionUnscoped = vi.fn(async (id, decide) => {
    const patch = decide(m.live);
    if (patch) await m.updateProviderConnectionUnscoped(id, patch);
    return { applied: !!patch, missing: false };
  });
  return m;
});

vi.mock("@/lib/db/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getProviderConnectionsUnscoped: dbMocks.getProviderConnectionsUnscoped,
  updateProviderConnectionUnscoped: dbMocks.updateProviderConnectionUnscoped,
  mutateProviderConnectionUnscoped: dbMocks.mutateProviderConnectionUnscoped,
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
  getEffectivePreferences: dbMocks.getSettings,
  mutateBillingLockUnscoped: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { getProviderCredentials, markAccountUnavailable } = await import(
  "../../src/sse/services/auth.js"
);
const { RELIABILITY_DEFAULTS, setReliabilityOverrides } = await import(
  "open-sse/config/reliabilityPolicy.js"
);
const { CodexExecutor } = await import("open-sse/executors/codex.js");

const NOW = Date.parse("2026-09-01T00:00:00.000Z");
const HOUR = 3_600_000;
const conn = { id: "c1", provider: "codex", authType: "oauth", email: "c1@example.com" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([{ ...conn }]);
});

afterEach(() => {
  setReliabilityOverrides(null);
  vi.useRealTimers();
});

const lastPatch = () => dbMocks.updateProviderConnectionUnscoped.mock.calls.at(-1)[1];

describe("provider-reported reset locks", () => {
  it("defaults providerResetCapMs to 7 days", () => {
    expect(RELIABILITY_DEFAULTS.cooldowns.providerResetCapMs).toBe(7 * 24 * HOUR);
  });

  it("locks until the reported reset and reports it after 31 minutes with no snapshot", async () => {
    const resetAt = NOW + 5 * HOUR;
    const r = await markAccountUnavailable(
      "c1",
      429,
      "usage limit reached",
      "codex",
      "gpt-5",
      resetAt,
    );
    expect(r.cooldownMs).toBe(5 * HOUR);
    const patch = lastPatch();
    expect(patch["modelLock_gpt-5"]).toBe(new Date(resetAt).toISOString());
    expect(patch["modelLockMeta_gpt-5"]).toMatchObject({
      reason: "quota_reset",
      window: null,
      lockedAt: NOW,
    });

    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([{ ...conn, ...patch }]);
    vi.setSystemTime(NOW + 31 * 60_000);
    const result = await getProviderCredentials("codex", null, "gpt-5");
    expect(result).toMatchObject({ allRateLimited: true });
    expect(Date.parse(result.retryAfter)).toBe(resetAt);
  });

  it("bounds the lock by providerResetCapMs", async () => {
    setReliabilityOverrides({ cooldowns: { providerResetCapMs: 2 * HOUR } });
    const r = await markAccountUnavailable(
      "c1",
      429,
      "usage limit reached",
      "codex",
      "gpt-5",
      NOW + 30 * 24 * HOUR,
    );
    expect(r.cooldownMs).toBe(2 * HOUR);
    expect(lastPatch()["modelLock_gpt-5"]).toBe(new Date(NOW + 2 * HOUR).toISOString());
  });

  it("keeps a 429 without a provider reset within the 30-min rate-limit cap and unowned", async () => {
    const r = await markAccountUnavailable("c1", 429, "Too many requests", "codex", "gpt-5");
    expect(r.cooldownMs).toBeGreaterThan(0);
    expect(r.cooldownMs).toBeLessThanOrEqual(RELIABILITY_DEFAULTS.cooldowns.rateLimitCapMs);
    const patch = lastPatch();
    expect(patch).not.toHaveProperty("modelLockMeta_gpt-5");

    // No provider reset: the account is selectable again after 31 minutes.
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([{ ...conn, ...patch }]);
    vi.setSystemTime(NOW + 31 * 60_000);
    const result = await getProviderCredentials("codex", null, "gpt-5");
    expect(result).toMatchObject({ connectionId: "c1" });
  });

  it("a non-quota lock over a quota lock clears metadata from the live row, not a stale read", async () => {
    // Stale pre-read: the row looked clean, so the old code kept the live metadata.
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([{ ...conn }]);
    dbMocks.live = {
      "modelLock_gpt-5": new Date(NOW + 5 * HOUR).toISOString(),
      "modelLockMeta_gpt-5": { reason: "quota_reset", window: null, lockedAt: NOW, generation: 9 },
    };
    try {
      await markAccountUnavailable("c1", 503, "Service unavailable", "codex", "gpt-5");
      expect(lastPatch()["modelLockMeta_gpt-5"]).toBeNull();

      // Same with no pre-read row at all (provider filter mismatch).
      dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([]);
      await markAccountUnavailable("c1", 503, "Service unavailable", "codex", "gpt-5");
      expect(lastPatch()["modelLockMeta_gpt-5"]).toBeNull();
    } finally {
      dbMocks.live = {};
    }
  });

  it("a quota lock takes its generation from the live previous metadata", async () => {
    dbMocks.live = {
      "modelLockMeta_gpt-5": {
        reason: "quota_reset",
        window: null,
        lockedAt: NOW,
        generation: NOW + 1000,
      },
    };
    try {
      await markAccountUnavailable("c1", 429, "usage limit", "codex", "gpt-5", NOW + HOUR);
      expect(lastPatch()["modelLockMeta_gpt-5"].generation).toBe(NOW + 1001);
    } finally {
      dbMocks.live = {};
    }
  });
});

describe("Codex usage_limit_reached reset parsing", () => {
  const parse = (error) =>
    new CodexExecutor().parseError(
      new Response("", { status: 429 }),
      JSON.stringify({ error: { type: "usage_limit_reached", message: "limit", ...error } }),
    );

  it("trusts a reset within the 8-day horizon", () => {
    expect(parse({ resets_at: (NOW + 5 * 24 * HOUR) / 1000 }).resetsAtMs).toBe(NOW + 5 * 24 * HOUR);
    expect(parse({ resets_in_seconds: 3600 }).resetsAtMs).toBe(NOW + HOUR);
  });

  it("caps a reset beyond 8 days like a plain rate limit", () => {
    const cap = RELIABILITY_DEFAULTS.cooldowns.rateLimitCapMs;
    expect(parse({ resets_at: (NOW + 9 * 24 * HOUR) / 1000 }).resetsAtMs).toBe(NOW + cap);
    // ms sent as seconds: absurdly far out.
    expect(parse({ resets_in_seconds: NOW }).resetsAtMs).toBe(NOW + cap);
  });

  it("ignores a past or now resets_at like before (normal backoff, no 30-min cap)", () => {
    // Host clock slightly ahead of upstream: resets_at already reached locally.
    expect(parse({ resets_at: (NOW - 2000) / 1000 }).resetsAtMs).toBeUndefined();
    expect(parse({ resets_at: NOW / 1000 }).resetsAtMs).toBeUndefined();
    expect(parse({ resets_in_seconds: 0 }).resetsAtMs).toBeUndefined();
    // A past resets_at still lets a valid resets_in_seconds through.
    expect(parse({ resets_at: (NOW - 2000) / 1000, resets_in_seconds: 60 }).resetsAtMs).toBe(
      NOW + 60_000,
    );
  });
});
