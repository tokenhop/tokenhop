import { describe, expect, it } from "vitest";
import { interpolateCount, formatCount } from "../../src/shared/components/countUpMath.js";
import {
  formatCompact,
  formatInt,
  formatMoney,
} from "../../src/app/(dashboard)/dashboard/home/format.js";

describe("CountUp interpolation and formatter parity", () => {
  it("starts at the previous value and ends at the target after 600ms", () => {
    expect(interpolateCount(100, 200, 0)).toBe(100);
    expect(interpolateCount(100, 200, 600)).toBe(200);
    expect(interpolateCount(200, 100, 600)).toBe(100);
  });

  it("uses cubic ease-out and clamps time", () => {
    expect(interpolateCount(0, 100, 300)).toBeCloseTo(87.5);
    expect(interpolateCount(0, 100, -10)).toBe(0);
    expect(interpolateCount(0, 100, 1000)).toBe(100);
  });

  it("uses the caller's formatter at every frame and at rest", () => {
    for (const formatter of [formatCompact, formatInt, formatMoney]) {
      expect(formatCount(2584, formatter)).toBe(formatter(2584));
      expect(formatCount(interpolateCount(100, 2584, 300), formatter)).toBe(
        formatter(interpolateCount(100, 2584, 300)),
      );
    }
  });
});
