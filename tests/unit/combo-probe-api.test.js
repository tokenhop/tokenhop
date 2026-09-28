import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  buildProbeBody,
  checkProbeRateLimit,
  resetProbeRateLimit,
  summarizeProbe,
  PROBE_MAX_TOKENS,
  PROBE_RATE_LIMIT_MS,
} from "../../src/sse/services/comboProbe.js";

beforeEach(() => {
  resetProbeRateLimit();
});

describe("buildProbeBody", () => {
  it("builds a minimal non-streaming body with capped tokens", () => {
    const probeBody = buildProbeBody("coder");
    expect(probeBody.model).toBe("coder");
    expect(probeBody.stream).toBe(false);
    expect(probeBody.max_tokens).toBe(PROBE_MAX_TOKENS);
    expect(probeBody.messages).toHaveLength(1);
    expect(probeBody.tools).toBeUndefined();
  });
});

describe("checkProbeRateLimit", () => {
  it("allows the first run, blocks the second within the window", () => {
    const t0 = 1_000_000;
    expect(checkProbeRateLimit("combo-1", t0).allowed).toBe(true);
    const second = checkProbeRateLimit("combo-1", t0 + PROBE_RATE_LIMIT_MS - 1);
    expect(second.allowed).toBe(false);
    expect(second.retryAfterMs).toBe(1);
  });

  it("allows again after the window, and tracks combos independently", () => {
    const t0 = 2_000_000;
    expect(checkProbeRateLimit("combo-1", t0).allowed).toBe(true);
    expect(checkProbeRateLimit("combo-2", t0 + 1).allowed).toBe(true);
    expect(checkProbeRateLimit("combo-1", t0 + PROBE_RATE_LIMIT_MS).allowed).toBe(true);
  });
});

describe("summarizeProbe", () => {
  it("summarizes first-step success", () => {
    expect(summarizeProbe([{ outcome: "served", status: 200, errorType: null }], 1200)).toBe(
      "Answered in 1.20s on the first step. No fallback needed.",
    );
  });

  it("summarizes a single fallback with the unseen 429", () => {
    expect(
      summarizeProbe(
        [
          { outcome: "skipped", status: 429, errorType: "rate limited" },
          { outcome: "served", status: 200, errorType: null },
        ],
        1380,
      ),
    ).toBe("Fell back once and answered in 1.38s. Your client never saw the 429.");
  });

  it("summarizes all-fail", () => {
    expect(
      summarizeProbe(
        [
          { outcome: "skipped", status: 503, errorType: "upstream error" },
          { outcome: "skipped", status: 503, errorType: "upstream error" },
        ],
        500,
      ),
    ).toBe("All 2 steps failed after 0.50s. Nothing was served.");
  });
});

describe("POST /api/combos/[id]/test validation + rate limit", () => {
  async function loadRoute(mocks = {}) {
    vi.resetModules();
    vi.doMock("@/lib/localDb", () => ({
      getComboById: mocks.getComboById || (async () => null),
      getSettings: async () => ({}),
    }));
    vi.doMock("@/sse/services/comboProbe.js", async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        runComboProbe: mocks.runComboProbe || actual.runComboProbe,
        checkProbeRateLimit: mocks.checkProbeRateLimit || actual.checkProbeRateLimit,
      };
    });
    return import("@/app/api/combos/[id]/test/route.js");
  }

  it("404s on unknown combo", async () => {
    const { POST } = await loadRoute();
    const res = await POST({}, { params: Promise.resolve({ id: "nope" }) });
    expect(res.status).toBe(404);
  });

  it("400s on malformed id", async () => {
    const { POST } = await loadRoute();
    const res = await POST({}, { params: Promise.resolve({ id: "" }) });
    expect(res.status).toBe(400);
  });

  it("429s when rate limited, with Retry-After", async () => {
    const { POST } = await loadRoute({
      getComboById: async () => ({ id: "c1", name: "coder", models: ["p/a"] }),
      checkProbeRateLimit: () => ({ allowed: false, retryAfterMs: 8000 }),
    });
    const res = await POST({}, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("8");
  });

  it("returns the probe timeline on success", async () => {
    const fake = {
      comboName: "coder",
      strategy: "fallback",
      attempts: [{ model: "p/a", status: 200, outcome: "served" }],
      served: { model: "p/a", status: 200, outcome: "served" },
      totalMs: 120,
      summary: "Answered in 0.12s on the first step. No fallback needed.",
    };
    const { POST } = await loadRoute({
      getComboById: async () => ({ id: "c1", name: "coder", models: ["p/a"] }),
      runComboProbe: async () => fake,
    });
    const res = await POST({}, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.comboName).toBe("coder");
    expect(json.attempts).toHaveLength(1);
    expect(json.ranAt).toBeDefined();
  });

  it("maps probe errors to their status", async () => {
    const { POST } = await loadRoute({
      getComboById: async () => ({ id: "c1", name: "coder", models: [] }),
      runComboProbe: async () => {
        const error = new Error("Combo has no models");
        error.status = 400;
        throw error;
      },
    });
    const res = await POST({}, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(400);
  });
});
