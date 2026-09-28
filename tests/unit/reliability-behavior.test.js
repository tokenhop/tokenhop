import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const { setReliabilityOverrides } = await import("../../open-sse/config/reliabilityPolicy.js");
const { checkFallbackError, getQuotaCooldown } = await import(
  "../../open-sse/services/accountFallback.js"
);
const { RELIABILITY_DEFAULTS } = await import("../../open-sse/config/reliabilityPolicy.js");

function res(status) {
  return { status, headers: { get: () => "" } };
}

beforeEach(() => {
  fetchMock.mockReset();
  setReliabilityOverrides(null);
  vi.useRealTimers();
});

describe("YAN-311 behavioral: configured 502 retries with fake timers", () => {
  it("retries 502 configured tries with the configured delay", async () => {
    vi.useFakeTimers();
    try {
      setReliabilityOverrides({ retryPolicy: { 502: { tries: 2, delayMs: 1500 } } });
      const ex = new BaseExecutor("test", { baseUrl: "https://x/api" });
      fetchMock.mockResolvedValue(res(502));
      const pending = ex.execute({
        model: "m",
        body: {},
        stream: false,
        credentials: { apiKey: "k" },
      });
      // Two configured retries: initial + 2 retries = 3 fetches, each delayed 1500ms.
      await vi.advanceTimersByTimeAsync(1499);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1500);
      const out = await pending;
      expect(out.response.status).toBe(502);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
      setReliabilityOverrides(null);
    }
  });

  it("tries: 0 disables retries", async () => {
    setReliabilityOverrides({ retryPolicy: { 502: { tries: 0, delayMs: 0 } } });
    const ex = new BaseExecutor("test", { baseUrl: "https://x/api" });
    fetchMock.mockResolvedValue(res(502));
    const out = await ex.execute({
      model: "m",
      body: {},
      stream: false,
      credentials: { apiKey: "k" },
    });
    expect(out.response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("YAN-311 behavioral: 429 cooldown + never retry", () => {
  it("429 maps to backoff cooldown and custom values apply", () => {
    const first = checkFallbackError(429, "rate limit", 0);
    expect(first.shouldFallback).toBe(true);
    expect(first.cooldownMs).toBe(getQuotaCooldown(1));
    const second = checkFallbackError(429, "rate limit", first.newBackoffLevel);
    expect(second.cooldownMs).toBeGreaterThan(first.cooldownMs);
    // Custom backoff drives cooldowns.
    setReliabilityOverrides({ backoff: { startMs: 1000, maxMs: 8000, levels: 3 } });
    try {
      expect(checkFallbackError(429, "x", 0).cooldownMs).toBe(1000);
      expect(checkFallbackError(429, "x", 99).newBackoffLevel).toBe(3);
    } finally {
      setReliabilityOverrides(null);
    }
  });

  it("custom cooldowns apply to long (401) and transient (500) paths", () => {
    setReliabilityOverrides({
      cooldowns: { ...RELIABILITY_DEFAULTS.cooldowns, longMs: 60000, transientMs: 10000 },
    });
    try {
      expect(checkFallbackError(401, "", 0).cooldownMs).toBe(60000);
      expect(checkFallbackError(500, "boom", 0).cooldownMs).toBe(10000);
    } finally {
      setReliabilityOverrides(null);
    }
  });
});
