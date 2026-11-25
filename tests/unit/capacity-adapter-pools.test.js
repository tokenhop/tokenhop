// YAN-692: only the pools for the capabilities a request needs may feed it.
import { describe, it, expect } from "vitest";
import {
  augmentModelsWithCapacityAdapter,
  capacityAdapterBridgeModels,
} from "../../open-sse/services/capacityAdapter.js";

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

describe("capacityAdapterBridgeModels (YAN-2467)", () => {
  const VISION = "cmc/moonshotai/Kimi-K3";
  const vision = { capacityAdapter: { vision: { enabled: true, models: [VISION] } } };

  it("names configured adapter models already in the list, not other members", () => {
    expect(capacityAdapterBridgeModels([TEXT_ONLY, VISION], ["vision"], vision)).toEqual([VISION]);
  });

  it("is empty without a hard capability or with the pool off", () => {
    expect(capacityAdapterBridgeModels([TEXT_ONLY, VISION], [], vision)).toEqual([]);
    const off = { capacityAdapter: { vision: { enabled: false, models: [VISION] } } };
    expect(capacityAdapterBridgeModels([TEXT_ONLY, VISION], ["vision"], off)).toEqual([]);
  });

  it("only uses the pools of the capabilities the request needs", () => {
    const audio = { capacityAdapter: { audioInput: { enabled: true, models: [VISION] } } };
    expect(capacityAdapterBridgeModels([TEXT_ONLY, VISION], ["vision"], audio)).toEqual([]);
  });
});
