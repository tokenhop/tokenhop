// YAN-692: only the pools for the capabilities a request needs may feed it.
import { describe, it, expect } from "vitest";
import { augmentModelsWithCapacityAdapter } from "../../open-sse/services/capacityAdapter.js";

const TEXT_ONLY = "cmc/deepseek/deepseek-v4-pro";

describe("capacity adapter pool scoping (YAN-692)", () => {
  it("an enabled empty Audio pool injects nothing into a vision request", () => {
    const settings = {
      capacityAdapter: { vision: { enabled: false }, audioInput: { enabled: true } },
    };
    expect(augmentModelsWithCapacityAdapter([TEXT_ONLY], ["vision"], settings)).toEqual([
      TEXT_ONLY,
    ]);
  });

  it("a vision model placed in the Audio pool doesn't serve vision requests", () => {
    const settings = {
      capacityAdapter: {
        vision: { enabled: false },
        audioInput: { enabled: true, models: ["cmc/moonshotai/Kimi-K3"] },
      },
    };
    expect(augmentModelsWithCapacityAdapter([TEXT_ONLY], ["vision"], settings)).toEqual([
      TEXT_ONLY,
    ]);
  });

  it("the Vision pool still serves vision requests", () => {
    const settings = {
      capacityAdapter: { vision: { enabled: true, models: ["cmc/moonshotai/Kimi-K3"] } },
    };
    expect(augmentModelsWithCapacityAdapter([TEXT_ONLY], ["vision"], settings)).toEqual([
      "cmc/moonshotai/Kimi-K3",
      TEXT_ONLY,
    ]);
  });
});
