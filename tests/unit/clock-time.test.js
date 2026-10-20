import { describe, expect, it } from "vitest";
import { clockTime } from "../../open-sse/utils/clockTime.js";

describe("clockTime", () => {
  it("prints zero-padded local 24h HH:MM:SS", () => {
    expect(clockTime(new Date(2026, 0, 1, 0, 5, 9))).toBe("00:05:09");
    expect(clockTime(new Date(2026, 0, 1, 7, 0, 0))).toBe("07:00:00");
    expect(clockTime(new Date(2026, 0, 1, 23, 59, 59))).toBe("23:59:59");
  });

  it("defaults to now", () => {
    expect(clockTime()).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});
