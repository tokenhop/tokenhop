import { describe, expect, it } from "vitest";
import {
  formatTokens,
  formatUptime,
  reasonLabel,
  statusLabel,
} from "@/app/(dashboard)/dashboard/pxpipe/pxpipePresentation";

describe("pxpipePresentation", () => {
  it("formats token counts", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1500)).toBe("1.5K");
    expect(formatTokens(2500000)).toBe("2.50M");
  });

  it("formats uptime", () => {
    expect(formatUptime(0)).toBe("—");
    expect(formatUptime(-5)).toBe("—");
    expect(formatUptime(5 * 60000)).toBe("5m");
    expect(formatUptime(130 * 60000)).toBe("2h10m");
  });

  it("resolves status labels", () => {
    expect(statusLabel(null, null)).toBe("—");
    expect(statusLabel({ installed: false }, null)).toBe("Not installed");
    expect(statusLabel({ installed: true, running: true }, { healthy: true })).toBe("Healthy");
    expect(statusLabel({ installed: true, running: true }, { healthy: false })).toBe("Running");
    expect(statusLabel({ installed: true, running: false }, null)).toBe("Stopped");
  });

  it("maps skip reasons, falling back to raw", () => {
    expect(reasonLabel("timeout")).toBe("Compression timed out");
    expect(reasonLabel("weird_future")).toBe("weird_future");
  });
});
