import { describe, it, expect } from "vitest";

import {
  autoPingConnections,
  hiddenKeysForProvider,
  providersWithThinking,
  quotaProviders,
  setProviderThinkingMode,
  setQuotaHiddenKey,
  unionThinkingLevels,
} from "@/app/(dashboard)/dashboard/settings/sections/providersModelsHelpers.js";
import { mergeWithDefaults } from "@/lib/db/repos/settingsRepo.js";

const fakeLevels = (_provider, model) => {
  if (model === "plain") return null;
  if (model === "codex-mini") return ["low", "medium", "high", "xhigh"];
  return ["none", "low", "medium", "high"];
};

describe("providers models helpers", () => {
  it("defaults match the settings repo", () => {
    const merged = mergeWithDefaults({});
    expect(merged.enableObservability).toBe(false);
    expect(merged.observabilityMaxRecords).toBe(1000);
    expect(merged.observabilityBatchSize).toBe(20);
    expect(merged.observabilityFlushIntervalMs).toBe(5000);
    expect(merged.observabilityMaxJsonSize).toBe(5);
    expect(merged.mitmRouterBaseUrl).toBe("http://localhost:20128");
    expect(merged.quotaVisibility).toEqual({});
  });

  it("unions thinking levels without none, auto first, sorted", () => {
    expect(unionThinkingLevels("claude", ["plain"], fakeLevels)).toBe(null);
    expect(unionThinkingLevels("claude", ["m1", "m1", "plain"], fakeLevels)).toEqual([
      "auto",
      "high",
      "low",
      "medium",
    ]);
    expect(unionThinkingLevels("codex", ["codex-mini"], fakeLevels)).toEqual([
      "auto",
      "high",
      "low",
      "medium",
      "xhigh",
    ]);
  });

  it("lists only providers with reasoning models", () => {
    const modelsFor = (provider) => (provider === "claude" ? ["m1"] : ["plain"]);
    expect(providersWithThinking(["claude", "codex"], modelsFor, fakeLevels)).toEqual(["claude"]);
  });

  it("auto deletes the thinking entry (provider page shape)", () => {
    expect(setProviderThinkingMode({ claude: { mode: "high" } }, "claude", "auto")).toEqual({});
    expect(setProviderThinkingMode({}, "claude", "high")).toEqual({
      claude: { mode: "high" },
    });
    expect(setProviderThinkingMode({}, "claude", "")).toEqual({});
  });

  it("hides/shows quota keys (Usage page shape)", () => {
    const hidden = setQuotaHiddenKey({}, "claude", " weekly-5h ", true);
    expect(hidden).toEqual({ claude: { hidden: ["weekly-5h"] } });
    expect(setQuotaHiddenKey(hidden, "claude", "weekly-5h", false)).toEqual({});
    expect(() => setQuotaHiddenKey({}, "", "k", true)).toThrow();
    expect(() => setQuotaHiddenKey({}, "claude", "  ", true)).toThrow();
  });

  it("coerces auto-ping maps and reads quota helpers", () => {
    expect(autoPingConnections({ connections: { c1: true, c2: "yes" } })).toEqual({
      c1: true,
    });
    expect(autoPingConnections(undefined)).toEqual({});
    expect(autoPingConnections({ connections: [] })).toEqual({});
    expect(hiddenKeysForProvider({ claude: { hidden: ["a", 42] } }, "claude")).toEqual(["a"]);
    expect(hiddenKeysForProvider({}, "claude")).toEqual([]);
    expect(quotaProviders({ claude: { hidden: [] } })).toEqual(["claude"]);
    expect(quotaProviders(undefined)).toEqual([]);
  });
});
