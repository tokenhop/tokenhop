import { describe, it, expect } from "vitest";
import { computeHomeSummary } from "../../src/lib/home/summary.js";

describe("computeHomeSummary", () => {
  const history = [
    // In current 7d window
    {
      timestamp: new Date("2026-09-25T10:00:00Z").toISOString(),
      promptTokens: 100,
      completionTokens: 50,
      cost: 0.1,
      savings: {
        tokensSavedEst: 200,
        tokensBeforeEst: 800,
        byMethod: { rtk: { tokensSavedEst: 200 } },
      },
      comboName: "coder",
    },
    {
      timestamp: new Date("2026-09-24T10:00:00Z").toISOString(),
      promptTokens: 200,
      completionTokens: 80,
      cost: 0.2,
      savings: {
        tokensSavedEst: 300,
        tokensBeforeEst: 1200,
        byMethod: { headroom: { tokensSavedEst: 300 } },
      },
      comboName: "coder",
    },
    {
      timestamp: new Date("2026-09-22T10:00:00Z").toISOString(),
      promptTokens: 50,
      completionTokens: 20,
      cost: 0.05,
      comboName: "fast-chat",
    },
    // In previous 7d window (8 to 14 days ago)
    {
      timestamp: new Date("2026-09-17T10:00:00Z").toISOString(),
      promptTokens: 100,
      completionTokens: 50,
      cost: 0.1,
    },
    // Outside both windows
    {
      timestamp: new Date("2026-08-01T10:00:00Z").toISOString(),
      promptTokens: 500,
      completionTokens: 200,
      cost: 0.5,
    },
  ];

  const combos = [
    { name: "coder", models: ["cc/claude-sonnet-4-6", "cx/gpt-5.1-codex"] },
    { name: "fast-chat", models: ["gc/gemini-2.5-flash", "deepseek/deepseek-chat"] },
    { name: "unused", models: ["m1", "m2"] },
  ];

  const comboStrategies = {
    coder: { fallbackStrategy: "fallback" },
    "fast-chat": { fallbackStrategy: "round-robin" },
  };

  const fixedNow = new Date("2026-09-26T12:00:00Z").getTime();

  it("calculates current and previous requests and delta", () => {
    const res = computeHomeSummary({
      history,
      combos,
      comboStrategies,
      period: "7d",
      now: fixedNow,
    });

    expect(res.currentRequests).toBe(3);
    expect(res.previousRequests).toBe(1);
    expect(res.requestsDelta).toEqual({ delta: 2, pct: 200 });
  });

  it("aggregates savings for the period", () => {
    const res = computeHomeSummary({
      history,
      combos,
      comboStrategies,
      period: "7d",
      now: fixedNow,
    });

    expect(res.savings.tokensSavedEst).toBe(500);
    expect(res.savings.byMethod.rtk.tokensSavedEst).toBe(200);
    expect(res.savings.byMethod.headroom.tokensSavedEst).toBe(300);
  });

  it("picks the top 2 combos with their strategy and model chain", () => {
    const res = computeHomeSummary({
      history,
      combos,
      comboStrategies,
      period: "7d",
      now: fixedNow,
    });

    expect(res.topCombos.length).toBe(2);
    expect(res.topCombos[0].name).toBe("coder");
    expect(res.topCombos[0].requests).toBe(2);
    expect(res.topCombos[0].strategy).toBe("fallback");
    expect(res.topCombos[1].name).toBe("fast-chat");
    expect(res.topCombos[1].requests).toBe(1);
  });
});
