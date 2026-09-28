import { describe, it, expect } from "vitest";

import {
  summarizeRouting,
  applyProviderOverride,
  removeProviderOverride,
} from "@/app/(dashboard)/dashboard/settings/sections/routingSettings.js";

describe("summarizeRouting", () => {
  it("describes fill-first defaults in plain language", () => {
    const text = summarizeRouting({});
    expect(text).toContain("priority order");
    expect(text).toContain("Combos try models in order");
  });

  it("describes round-robin with the sticky limit", () => {
    const text = summarizeRouting({ fallbackStrategy: "round-robin", stickyRoundRobinLimit: 5 });
    expect(text).toContain("rotate");
    expect(text).toContain("5");
  });

  it("describes weighted routing", () => {
    const text = summarizeRouting({ fallbackStrategy: "weighted", stickyRoundRobinLimit: 3 });
    expect(text).toContain("quota");
  });

  it("falls back to fill-first wording for unknown strategies", () => {
    expect(summarizeRouting({ fallbackStrategy: "nope" })).toContain("priority order");
  });

  it("describes combo round-robin with its sticky limit", () => {
    const text = summarizeRouting({
      comboStrategy: "round-robin",
      comboStickyRoundRobinLimit: 2,
    });
    expect(text).toContain("Combos rotate");
    expect(text).toContain("2");
  });

  it("explains fusion/weighted combos without claiming the toggle owns them", () => {
    expect(summarizeRouting({ comboStrategy: "fusion" })).toContain("fuse");
    expect(summarizeRouting({ comboStrategy: "weighted" })).toContain("Combos");
  });

  it("counts provider overrides", () => {
    expect(summarizeRouting({})).not.toContain("override");
    expect(
      summarizeRouting({ providerStrategies: { anthropic: { fallbackStrategy: "weighted" } } }),
    ).toContain("1 provider override");
    expect(
      summarizeRouting({
        providerStrategies: {
          anthropic: { fallbackStrategy: "weighted" },
          openai: { fallbackStrategy: "round-robin" },
        },
      }),
    ).toContain("2 provider overrides");
  });
});

describe("applyProviderOverride", () => {
  it("adds a new override", () => {
    expect(
      applyProviderOverride({}, "anthropic", {
        fallbackStrategy: "round-robin",
        stickyRoundRobinLimit: 5,
      }),
    ).toEqual({
      anthropic: { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 5 },
    });
  });

  it("edits strategy and sticky in place", () => {
    const map = { anthropic: { fallbackStrategy: "fill-first", stickyRoundRobinLimit: 3 } };
    expect(
      applyProviderOverride(map, "anthropic", {
        fallbackStrategy: "weighted",
        stickyRoundRobinLimit: 1,
      }),
    ).toEqual({ anthropic: { fallbackStrategy: "weighted", stickyRoundRobinLimit: 1 } });
  });

  it("clearing both routing keys drops an empty entry", () => {
    const map = { anthropic: { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 2 } };
    expect(
      applyProviderOverride(map, "anthropic", {
        fallbackStrategy: "",
        stickyRoundRobinLimit: "",
      }),
    ).toEqual({});
  });

  it("preserves unrelated override keys (proxy pool, rotation)", () => {
    const map = { anthropic: { proxyPoolId: "pool-1", rotateStrategy: "round-robin" } };
    expect(
      applyProviderOverride(map, "anthropic", {
        fallbackStrategy: "weighted",
        stickyRoundRobinLimit: "",
      }),
    ).toEqual({
      anthropic: {
        proxyPoolId: "pool-1",
        rotateStrategy: "round-robin",
        fallbackStrategy: "weighted",
      },
    });
  });

  it("leaves other providers untouched", () => {
    const map = { openai: { fallbackStrategy: "fill-first" } };
    expect(
      applyProviderOverride(map, "anthropic", {
        fallbackStrategy: "round-robin",
        stickyRoundRobinLimit: 2,
      }),
    ).toEqual({
      openai: { fallbackStrategy: "fill-first" },
      anthropic: { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 2 },
    });
  });
});

describe("removeProviderOverride", () => {
  it("removes the whole entry when only routing keys exist", () => {
    const map = {
      anthropic: { fallbackStrategy: "weighted", stickyRoundRobinLimit: 1 },
      openai: { fallbackStrategy: "fill-first" },
    };
    expect(removeProviderOverride(map, "anthropic")).toEqual({
      openai: { fallbackStrategy: "fill-first" },
    });
  });

  it("keeps unrelated keys and drops the provider only when empty", () => {
    const map = { anthropic: { fallbackStrategy: "weighted", proxyPoolId: "pool-1" } };
    expect(removeProviderOverride(map, "anthropic")).toEqual({
      anthropic: { proxyPoolId: "pool-1" },
    });
  });

  it("is a no-op for unknown providers", () => {
    const map = { openai: { fallbackStrategy: "fill-first" } };
    expect(removeProviderOverride(map, "ghost")).toEqual(map);
  });
});
