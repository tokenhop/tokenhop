import { describe, it, expect } from "vitest";
import {
  cachedShare,
  formatCompact,
  formatInt,
  formatLatency,
  formatMoney,
  formatReset,
  maskApiKey,
  timeAgo,
} from "@/app/(dashboard)/dashboard/home/format.js";

describe("home format helpers", () => {
  it("compacts large numbers", () => {
    expect(formatCompact(2481)).toBe("2.5k");
    expect(formatCompact(4_200_000)).toBe("4.2M");
    expect(formatCompact(812)).toBe("812");
    expect(formatCompact(Number.NaN)).toBe("0");
  });

  it("groups integers", () => {
    expect(formatInt(2481)).toBe("2,481");
    expect(formatInt(Number.NaN)).toBe("0");
  });

  it("formats money estimates", () => {
    expect(formatMoney(18.4)).toBe("$18.40");
    expect(formatMoney(Number.NaN)).toBe("$0.00");
  });

  it("formats latency", () => {
    expect(formatLatency(1800)).toBe("1.8s");
    expect(formatLatency(320)).toBe("320ms");
    expect(formatLatency(-1)).toBe("—");
  });

  it("reports relative time", () => {
    const now = Date.now();
    expect(timeAgo(new Date(now - 2000).toISOString(), now)).toBe("now");
    expect(timeAgo(new Date(now - 41000).toISOString(), now)).toBe("41s");
    expect(timeAgo(new Date(now - 61_000).toISOString(), now)).toBe("1m");
    expect(timeAgo("bogus", now)).toBe("—");
  });

  it("masks keys like the endpoint page", () => {
    expect(maskApiKey("sk-9router-a41cdef0")).toBe("sk-9ro•••••••••def0");
    expect(maskApiKey("short")).toBe("s••••");
    expect(maskApiKey(null)).toBe("—");
  });

  it("formats quota reset text", () => {
    const now = new Date("2026-09-26T12:00:00Z").getTime();
    expect(formatReset(new Date(now + 3 * 3600_000 + 12 * 60_000).toISOString(), now)).toBe(
      "Resets in 3h 12m",
    );
    expect(formatReset(new Date(now + 30 * 60_000).toISOString(), now)).toBe("Resets in 30m");
    expect(formatReset(new Date(now + 5 * 24 * 3600_000).toISOString(), now)).toBe("Resets Oct 1");
    expect(formatReset(null, now)).toBe("");
    expect(formatReset("bogus", now)).toBe("");
  });

  it("computes cached share", () => {
    expect(cachedShare(38, 100)).toBe(38);
    expect(cachedShare(0, 0)).toBeNull();
  });
});
