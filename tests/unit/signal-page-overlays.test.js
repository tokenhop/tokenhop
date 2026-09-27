import { describe, expect, it, vi } from "vitest";
import {
  formatCreditDate,
  formatTimeRemaining,
} from "../../src/app/(dashboard)/dashboard/quota/lib/resetCreditFormat.js";

describe("reset credit expiry", () => {
  it("formats missing and invalid values", () => {
    expect(formatCreditDate(null)).toBe("N/A");
    expect(formatCreditDate("bad-date")).toBe("N/A");
    expect(formatTimeRemaining("bad-date")).toBe("N/A");
  });

  it("shows expired and rounded-up remaining hours", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
      expect(formatTimeRemaining("2026-09-25T11:00:00Z")).toBe("Expired");
      expect(formatTimeRemaining("2026-09-25T12:00:01Z")).toBe("1h");
      expect(formatTimeRemaining("2026-09-26T14:00:00Z")).toBe("1d 2h");
    } finally {
      vi.useRealTimers();
    }
  });
});
