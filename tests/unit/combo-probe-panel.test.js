import { describe, it, expect } from "vitest";

import {
  formatProbeLatency,
  probeLastRunLabel,
} from "../../src/shared/components/combos/routeTestFormat.js";

describe("formatProbeLatency", () => {
  it("formats sub-second as ms", () => {
    expect(formatProbeLatency(180)).toBe("180ms");
    expect(formatProbeLatency(0)).toBe("0ms");
  });

  it("formats seconds with two decimals", () => {
    expect(formatProbeLatency(1200)).toBe("1.20s");
    expect(formatProbeLatency(1380)).toBe("1.38s");
  });

  it("handles bad input", () => {
    expect(formatProbeLatency(NaN)).toBe("—");
    expect(formatProbeLatency(-5)).toBe("—");
  });
});

describe("probeLastRunLabel", () => {
  it("returns null when never run", () => {
    expect(probeLastRunLabel(null)).toBeNull();
    expect(probeLastRunLabel("bogus")).toBeNull();
  });

  it("formats relative labels", () => {
    const now = new Date("2026-09-26T12:00:00Z").getTime();
    expect(probeLastRunLabel(new Date(now - 5000).toISOString(), now)).toBe("Last run just now");
    expect(probeLastRunLabel(new Date(now - 120000).toISOString(), now)).toBe("Last run 2 min ago");
  });
});
