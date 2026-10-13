import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import {
  getPricingForModel,
  getUserPricing,
  resetPricing,
  updatePricing,
} from "@/lib/db/repos/pricingRepo.js";
import { getPricingForModel as resolveDefaults } from "../../open-sse/providers/pricing.js";

// Pre-targeting implementation: keep this oracle independent of the row lookup.
async function fullMapPricing(provider, model) {
  if (!model) return null;
  const userPricing = await getUserPricing();
  const user = provider && userPricing[provider]?.[model];
  const defaults = resolveDefaults(provider, model);
  if (user && defaults) return { ...defaults, ...user };
  if (user) return user;
  return defaults;
}

describe("targeted pricing reads", () => {
  let db;

  beforeEach(async () => {
    db = await getAdapter();
    db.run("DELETE FROM kv WHERE scope = 'pricing'");
    await updatePricing({
      openai: {
        "gpt-4o": { input: 0, cached: 9 },
        "vendor/gpt-4o": { input: 7 },
      },
      "custom-provider": { "private-model": { input: 3, output: 8 } },
      oa: { "gpt-4o": { input: 11 } },
    });
  });

  it.each([
    ["openai", "gpt-4o"],
    ["custom-provider", "private-model"],
    ["absent-provider", "gpt-4o"],
    [null, "gpt-4o"],
    [undefined, "deepseek/deepseek-chat"],
    ["", "gpt-4o"],
    ["openai", "unknown-private-model"],
    ["openai", null],
    ["openai", ""],
    // Provider aliases and model prefixes stay exact for user overrides;
    // canonical/pattern normalization belongs only to the default resolver.
    ["oa", "gpt-4o"],
    ["openai", "vendor/gpt-4o"],
    ["openai", "other/gpt-4o"],
    ["openai", "gpt-4o-2024-08-06"],
    ["openai", "GPT-4O"],
    ["deepseek", "deepseek/deepseek-chat"],
    ["minimax", "MiniMax-M2.5"],
    ["minimax", "minimax-m2.5"],
  ])("matches full-map lookup for %s / %s", async (provider, model) => {
    expect(await getPricingForModel(provider, model)).toEqual(
      await fullMapPricing(provider, model),
    );
  });

  it("merges partial overrides, including explicit zero, over defaults", async () => {
    expect(await getPricingForModel("openai", "gpt-4o")).toEqual({
      ...resolveDefaults("openai", "gpt-4o"),
      input: 0,
      cached: 9,
    });
    expect(await getPricingForModel("custom-provider", "private-model")).toEqual({
      input: 3,
      output: 8,
    });
  });

  it("exposes updates and resets on the next call without caching", async () => {
    expect((await getPricingForModel("openai", "gpt-4o")).input).toBe(0);
    await updatePricing({ openai: { "gpt-4o": { input: 19 } } });
    expect(await getPricingForModel("openai", "gpt-4o")).toEqual({
      ...resolveDefaults("openai", "gpt-4o"),
      input: 19,
    });
    await resetPricing("openai", "gpt-4o");
    expect(await getPricingForModel("openai", "gpt-4o")).toEqual(
      resolveDefaults("openai", "gpt-4o"),
    );
  });

  it("uses only scope/key SQL reads, never a full pricing scope scan", async () => {
    const get = vi.spyOn(db, "get");
    const all = vi.spyOn(db, "all");
    try {
      await getPricingForModel("openai", "gpt-4o");
      await getPricingForModel("absent-provider", "gpt-4o");
      await getPricingForModel(null, "gpt-4o");
      await getPricingForModel("openai", null);
      expect(all).not.toHaveBeenCalled();
      expect(get.mock.calls).toEqual([
        ["SELECT value FROM kv WHERE scope = ? AND key = ?", ["pricing", "openai"]],
        ["SELECT value FROM kv WHERE scope = ? AND key = ?", ["pricing", "absent-provider"]],
      ]);
    } finally {
      get.mockRestore();
      all.mockRestore();
    }
  });
});
