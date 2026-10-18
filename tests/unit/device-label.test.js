import { describe, expect, it } from "vitest";
import { coarseIp, describeDevice } from "@/lib/users/deviceLabel.js";

const FIREFOX_LINUX =
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0";
const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const EDGE_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

describe("describeDevice", () => {
  it.each([
    [FIREFOX_LINUX, "Firefox on Linux"],
    [CHROME_WIN, "Chrome on Windows"],
    [SAFARI_IPHONE, "Safari on iOS"],
    [EDGE_WIN, "Edge on Windows"],
    [CHROME_ANDROID, "Chrome on Android"],
    [SAFARI_MAC, "Safari on macOS"],
    ["curl/8.4.0", "Browser on Unknown OS"],
  ])("labels %#", (ua, label) => {
    expect(describeDevice(ua)).toBe(label);
  });

  it.each([undefined, null, "", "   ", 42, {}])("returns Unknown device for %j", (ua) => {
    expect(describeDevice(ua)).toBe("Unknown device");
  });

  it("handles a 10 kB UA without leaking it", () => {
    const label = describeDevice("A".repeat(10 * 1024));
    expect(label).toBe("Browser on Unknown OS");
    expect(label.length).toBeLessThanOrEqual(64);
  });

  it("ignores needles hidden past the 256-char cap", () => {
    expect(describeDevice(`${"A".repeat(300)} Firefox/1 Linux`)).toBe("Browser on Unknown OS");
  });

  it("never echoes a script UA", () => {
    const label = describeDevice("<script>alert(1)</script>");
    expect(label).toBe("Browser on Unknown OS");
    expect(label).not.toMatch(/[<>]/);
  });
});

describe("coarseIp", () => {
  it("masks IPv4 to /24", () => {
    expect(coarseIp("203.0.113.77")).toBe("203.0.113.0/24");
  });

  it("masks IPv6 to /48", () => {
    expect(coarseIp("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe("2001:db8:85a3::/48");
  });

  it("expands :: compression", () => {
    expect(coarseIp("2001:db8::1")).toBe("2001:db8:0::/48");
    expect(coarseIp("::1")).toBe("0:0:0::/48");
    expect(coarseIp("fe80::1")).toBe("fe80:0:0::/48");
    expect(coarseIp("2001:db8:1:2:3:4:5::")).toBe("2001:db8:1::/48");
  });

  it("treats IPv4-mapped IPv6 as IPv4", () => {
    expect(coarseIp("::ffff:203.0.113.77")).toBe("203.0.113.0/24");
    expect(coarseIp("::ffff:cb00:714d")).toBe("203.0.113.0/24");
  });

  it.each(["unknown", "", "not-an-ip", "999.1.1.1", "1.2.3", null, undefined, 42, {}])(
    "returns null for %j",
    (ip) => {
      expect(coarseIp(ip)).toBeNull();
    },
  );
});
