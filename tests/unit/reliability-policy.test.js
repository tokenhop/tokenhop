import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  RELIABILITY_DEFAULTS,
  getReliabilityPolicy,
  resolveRetryForStatus,
} from "../../open-sse/config/reliabilityPolicy.js";
import * as errorConfig from "../../open-sse/config/errorConfig.js";
import * as runtimeConfig from "../../open-sse/config/runtimeConfig.js";

const ENV_KEYS = [
  "STREAM_FIRST_CHUNK_TIMEOUT_MS",
  "STREAM_STALL_TIMEOUT_MS",
  "FETCH_CONNECT_TIMEOUT_MS",
];
const savedEnv = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("YAN-311 reliability defaults parity", () => {
  it("retryPolicy equals today's DEFAULT_RETRY_CONFIG", () => {
    expect(RELIABILITY_DEFAULTS.retryPolicy).toEqual({
      502: { tries: 3, delayMs: 3000 },
      503: { tries: 3, delayMs: 2000 },
      504: { tries: 2, delayMs: 3000 },
    });
    expect(runtimeConfig.DEFAULT_RETRY_CONFIG[502]).toEqual({ attempts: 3, delayMs: 3000 });
    expect(runtimeConfig.DEFAULT_RETRY_CONFIG[503]).toEqual({ attempts: 3, delayMs: 2000 });
    expect(runtimeConfig.DEFAULT_RETRY_CONFIG[504]).toEqual({ attempts: 2, delayMs: 3000 });
    expect(runtimeConfig.DEFAULT_RETRY_CONFIG[429]).toEqual({ attempts: 0, delayMs: 0 });
  });

  it("cooldowns equal today's constants", () => {
    expect(RELIABILITY_DEFAULTS.cooldowns).toEqual({
      rateLimitCapMs: 1800000,
      longMs: 120000,
      shortMs: 5000,
      transientMs: 30000,
    });
    expect(errorConfig.MAX_RATE_LIMIT_COOLDOWN_MS).toBe(1800000);
    expect(errorConfig.TRANSIENT_COOLDOWN_MS).toBe(30000);
    expect(errorConfig.COOLDOWN_MS).toEqual({
      unauthorized: 120000,
      paymentRequired: 120000,
      notFound: 120000,
      transient: 30000,
      requestNotAllowed: 5000,
    });
  });

  it("backoff equals today's BACKOFF_CONFIG", () => {
    expect(RELIABILITY_DEFAULTS.backoff).toEqual({ startMs: 2000, maxMs: 300000, levels: 15 });
    expect(errorConfig.BACKOFF_CONFIG).toEqual({ base: 2000, max: 300000, maxLevel: 15 });
  });

  it("streamTimeouts equal today's env defaults", () => {
    expect(RELIABILITY_DEFAULTS.streamTimeouts).toEqual({
      firstChunkMs: 200000,
      stallMs: 360000,
      connectMs: 60000,
    });
  });
});

describe("YAN-311 resolved policy precedence", () => {
  it("stored overrides apply over defaults", () => {
    const policy = getReliabilityPolicy({
      retryPolicy: { 502: { tries: 5, delayMs: 1000 } },
      backoff: { startMs: 500 },
    });
    expect(policy.retryPolicy[502]).toEqual({ tries: 5, delayMs: 1000 });
    expect(policy.retryPolicy[503]).toEqual({ tries: 3, delayMs: 2000 });
    expect(policy.backoff.startMs).toBe(500);
    expect(policy.backoff.maxMs).toBe(300000);
  });

  it("env wins over stored for stream timeouts", () => {
    process.env.STREAM_STALL_TIMEOUT_MS = "60000";
    const policy = getReliabilityPolicy({ streamTimeouts: { stallMs: 111111 } });
    expect(policy.streamTimeouts.stallMs).toBe(60000);
  });

  it("429 never retries regardless of stored overrides", () => {
    const entry = resolveRetryForStatus(
      getReliabilityPolicy({ retryPolicy: { 429: { tries: 9, delayMs: 9 } } }),
      429,
    );
    expect(entry).toEqual({ attempts: 0, delayMs: 0 });
  });

  it("502 resolves to configured tries/delay", () => {
    const entry = resolveRetryForStatus(
      getReliabilityPolicy({ retryPolicy: { 502: { tries: 5, delayMs: 1000 } } }),
      502,
    );
    expect(entry).toEqual({ attempts: 5, delayMs: 1000 });
  });
});

describe("YAN-311 retry shape consistency (tries/attempts)", () => {
  it("default 503 resolves to 3 attempts for the Codex SSE path", async () => {
    const { DEFAULT_RETRY_CONFIG, resolveRetryEntry } = await import(
      "../../open-sse/config/runtimeConfig.js"
    );
    const { getActiveReliabilityPolicy, setReliabilityOverrides } = await import(
      "../../open-sse/config/reliabilityPolicy.js"
    );
    setReliabilityOverrides(null);
    try {
      const policy503 = resolveRetryForStatus(getActiveReliabilityPolicy(), 503);
      const retryConfig = { ...DEFAULT_RETRY_CONFIG, 503: policy503 };
      expect(resolveRetryEntry(retryConfig[503])).toEqual({ attempts: 3, delayMs: 2000 });
    } finally {
      setReliabilityOverrides(null);
    }
  });

  it("configured 503 tries are honored by the Codex SSE retry config", async () => {
    const { DEFAULT_RETRY_CONFIG, resolveRetryEntry } = await import(
      "../../open-sse/config/runtimeConfig.js"
    );
    const {
      getActiveReliabilityPolicy,
      resolveRetryForStatus: resolve,
      setReliabilityOverrides,
    } = await import("../../open-sse/config/reliabilityPolicy.js");
    setReliabilityOverrides({ retryPolicy: { 503: { tries: 7, delayMs: 111 } } });
    try {
      const retryConfig = {
        ...DEFAULT_RETRY_CONFIG,
        503: resolve(getActiveReliabilityPolicy(), 503),
      };
      expect(resolveRetryEntry(retryConfig[503])).toEqual({ attempts: 7, delayMs: 111 });
    } finally {
      setReliabilityOverrides(null);
    }
  });

  it("resolveRetryEntry tolerates raw policy { tries } entries", async () => {
    const { resolveRetryEntry } = await import("../../open-sse/config/runtimeConfig.js");
    expect(resolveRetryEntry({ tries: 3, delayMs: 2000 })).toEqual({
      attempts: 3,
      delayMs: 2000,
    });
  });
});
