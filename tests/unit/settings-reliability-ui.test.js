import { describe, it, expect } from "vitest";
import {
  COOLDOWN_FIELDS,
  RELIABILITY_KEYS,
  RELIABILITY_UI_DEFAULTS,
  TIMEOUT_FIELDS,
  formatMs,
  mergeLeaf,
} from "@/app/(dashboard)/dashboard/settings/sections/reliabilityHelpers.js";
import { RELIABILITY_DEFAULTS } from "../../open-sse/config/reliabilityPolicy.js";

describe("YAN-311 reliability UI helpers", () => {
  it("UI defaults mirror the engine defaults", () => {
    expect(RELIABILITY_UI_DEFAULTS).toEqual(RELIABILITY_DEFAULTS);
    expect(RELIABILITY_KEYS).toEqual(Object.keys(RELIABILITY_DEFAULTS));
  });

  it("field lists cover every cooldown and timeout key", () => {
    expect(COOLDOWN_FIELDS.map((f) => f.key).sort()).toEqual(
      Object.keys(RELIABILITY_DEFAULTS.cooldowns).sort(),
    );
    expect(TIMEOUT_FIELDS.map((f) => f.key)).toEqual(
      Object.keys(RELIABILITY_DEFAULTS.streamTimeouts),
    );
  });

  it("mergeLeaf replaces one nested leaf without mutating the base", () => {
    const base = { 502: { tries: 3, delayMs: 3000 }, 503: { tries: 3, delayMs: 2000 } };
    const next = mergeLeaf(base, ["502", "tries"], 5);
    expect(next).toEqual({ 502: { tries: 5, delayMs: 3000 }, 503: { tries: 3, delayMs: 2000 } });
    expect(base[502].tries).toBe(3);
    expect(mergeLeaf(undefined, ["stallMs"], 1000)).toEqual({ stallMs: 1000 });
  });

  it("formatMs renders compact durations", () => {
    expect(formatMs(500)).toBe("500ms");
    expect(formatMs(3000)).toBe("3s");
    expect(formatMs(120000)).toBe("2min");
    expect(formatMs(1800000)).toBe("30min");
    expect(formatMs(86400000)).toBe("24h");
  });
});
