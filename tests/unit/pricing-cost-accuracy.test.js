// Pricing / cost accuracy (YAN-66 double-billed reasoning, YAN-65 partial overrides).
// Convention: completion_tokens INCLUDES reasoning_tokens.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { calculateCostFromTokens } from "../../open-sse/providers/pricing.js";
import { canonicalizeUsage, extractUsage } from "../../open-sse/utils/usageTracking.js";

describe("calculateCostFromTokens reasoning-inclusive completion", () => {
  it("bills non-reasoning completion at output rate when no reasoning rate (YAN-66)", () => {
    // 1e6 completion of which 8e5 reasoning → 0.2e6 @10 = $2, reasoning @output = $8 → 10
    const cost = calculateCostFromTokens(
      { completion_tokens: 1e6, reasoning_tokens: 8e5 },
      { input: 1, output: 10 },
    );
    expect(cost).toBeCloseTo(10, 12);
  });

  it("bills reasoning at the reasoning rate when present", () => {
    const cost = calculateCostFromTokens(
      { completion_tokens: 1e6, reasoning_tokens: 8e5 },
      { input: 1, output: 10, reasoning: 20 },
    );
    expect(cost).toBeCloseTo((0.2e6 * 10 + 0.8e6 * 20) / 1e6, 12);
  });

  it("partial pricing with no output rate stays finite (YAN-65)", () => {
    const cost = calculateCostFromTokens(
      { prompt_tokens: 1e6, completion_tokens: 1e6 },
      { input: 5 },
    );
    expect(Number.isFinite(cost)).toBe(true);
    expect(cost).toBeCloseTo(5, 12);
  });

  it("honours an explicit zero reasoning rate", () => {
    const cost = calculateCostFromTokens(
      { completion_tokens: 1e6, reasoning_tokens: 1e6 },
      { input: 1, output: 10, reasoning: 0 },
    );
    expect(cost).toBe(0);
  });
});

describe("extractUsage xAI shape (reasoning outside completion_tokens)", () => {
  it("folds reasoning into completion when total = prompt + completion + reasoning", () => {
    const u = extractUsage({
      usage: {
        prompt_tokens: 279,
        completion_tokens: 6,
        total_tokens: 374,
        completion_tokens_details: { reasoning_tokens: 89 },
      },
    });
    expect(u.completion_tokens).toBe(95);
    expect(u.reasoning_tokens).toBe(89);
  });
});

describe("canonicalizeUsage nested-details fallbacks", () => {
  it("reads Responses input_tokens_details / output_tokens_details", () => {
    const out = canonicalizeUsage({
      input_tokens: 100,
      output_tokens: 10,
      input_tokens_details: { cached_tokens: 60 },
      output_tokens_details: { reasoning_tokens: 4 },
    });
    expect(out.prompt_tokens).toBe(100);
    expect(out.cached_tokens).toBe(60);
    expect(out.completion_tokens).toBe(10);
    expect(out.reasoning_tokens).toBe(4);
  });
});

describe("getPricingForModel merges user override over defaults (YAN-65)", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let db;
  let ossGetPricingForModel;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-pricing-accuracy-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    await db.initDb();
    ({ getPricingForModel: ossGetPricingForModel } = await import(
      "../../open-sse/providers/pricing.js"
    ));
  });

  afterAll(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("partial override keeps the default output rate", async () => {
    const defaults = ossGetPricingForModel("openai", "gpt-4o");
    await db.updatePricing({ openai: { "gpt-4o": { input: 5 } } });
    const merged = await db.getPricingForModel("openai", "gpt-4o");
    expect(merged.input).toBe(5);
    expect(merged.output).toBe(defaults.output);
  });
});
