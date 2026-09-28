import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

function res(status) {
  return { status, headers: { get: () => "" } };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.useRealTimers();
});

describe("YAN-311 cold boot: stored policy without dashboard visit", () => {
  it("first request honors non-default stored tries (502)", async () => {
    vi.resetModules();
    const { BaseExecutor } = await import("../../open-sse/executors/base.js");
    const { getActiveReliabilityPolicy } = await import(
      "../../open-sse/config/reliabilityPolicy.js"
    );
    const { ensureReliabilityPolicy } = await import("@/lib/reliability/initReliabilityPolicy.js");
    // Defaults before any boot (fail-open).
    expect(getActiveReliabilityPolicy().retryPolicy[502]).toEqual({ tries: 3, delayMs: 3000 });
    // Simulate cold API-only server: DB holds a non-default policy.
    await ensureReliabilityPolicy(async () => ({
      retryPolicy: { 502: { tries: 5, delayMs: 10 } },
    }));
    expect(getActiveReliabilityPolicy().retryPolicy[502]).toEqual({ tries: 5, delayMs: 10 });

    vi.useFakeTimers();
    try {
      const ex = new BaseExecutor("test", { baseUrl: "https://x/api" });
      fetchMock.mockResolvedValue(res(502));
      const pending = ex.execute({
        model: "m",
        body: {},
        stream: false,
        credentials: { apiKey: "k" },
      });
      // Initial + 5 retries = 6 fetches, each delayed 10ms.
      await vi.advanceTimersByTimeAsync(60);
      const out = await pending;
      expect(out.response.status).toBe(502);
      expect(fetchMock).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
      vi.resetModules();
    }
  });

  it("concurrent first requests share one boot sync", async () => {
    vi.resetModules();
    let calls = 0;
    const { ensureReliabilityPolicy } = await import("@/lib/reliability/initReliabilityPolicy.js");
    const slowGet = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { retryPolicy: { 502: { tries: 1, delayMs: 1 } } };
    };
    await Promise.all([ensureReliabilityPolicy(slowGet), ensureReliabilityPolicy(slowGet)]);
    expect(calls).toBe(1);
    vi.resetModules();
  });

  it("DB failure keeps defaults (fail-open)", async () => {
    vi.resetModules();
    const { getActiveReliabilityPolicy } = await import(
      "../../open-sse/config/reliabilityPolicy.js"
    );
    const { ensureReliabilityPolicy } = await import("@/lib/reliability/initReliabilityPolicy.js");
    await ensureReliabilityPolicy(async () => {
      throw new Error("db down");
    });
    expect(getActiveReliabilityPolicy().retryPolicy[502]).toEqual({ tries: 3, delayMs: 3000 });
    vi.resetModules();
  });
});
