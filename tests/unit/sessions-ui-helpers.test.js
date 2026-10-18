// YAN-751: pure helpers behind the My account → Sessions card.
import { describe, expect, it } from "vitest";
import {
  deviceIcon,
  formatLastActive,
  lastActiveAt,
  methodLabel,
  sortSessions,
} from "@/shared/utils/sessions";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

describe("sortSessions", () => {
  it("puts the current device first, then most recent activity", () => {
    const list = [
      { id: "a", createdAt: ago(300 * MIN), lastSeenAt: ago(60 * MIN) },
      { id: "b", createdAt: ago(10 * MIN), lastSeenAt: null },
      { id: "c", current: true, createdAt: ago(900 * MIN), lastSeenAt: ago(600 * MIN) },
    ];
    expect(sortSessions(list).map((s) => s.id)).toEqual(["c", "b", "a"]);
  });

  it("breaks ties by sign-in time then id, and does not mutate the input", () => {
    const t = ago(5 * MIN);
    const list = [
      { id: "z", createdAt: ago(20 * MIN), lastSeenAt: t },
      { id: "y", createdAt: ago(20 * MIN), lastSeenAt: t },
      { id: "x", createdAt: ago(10 * MIN), lastSeenAt: t },
    ];
    expect(sortSessions(list).map((s) => s.id)).toEqual(["x", "y", "z"]);
    expect(list.map((s) => s.id)).toEqual(["z", "y", "x"]);
    expect(sortSessions(undefined)).toEqual([]);
  });
});

describe("formatLastActive", () => {
  it.each([
    [0, "Active now"],
    [4 * MIN, "Active now"],
    [25 * MIN, "Active 25 min ago"],
    [59 * MIN, "Active 59 min ago"],
    [60 * MIN, "Active 1 h ago"],
    [23 * 60 * MIN, "Active 23 h ago"],
  ])("%i ms ago reads %s", (ms, text) => {
    expect(formatLastActive(ago(ms), NOW)).toBe(text);
  });

  it("falls back to a date after a day and never claims seconds", () => {
    expect(formatLastActive(ago(26 * 60 * MIN), NOW)).toMatch(/^Active \S/);
    expect(formatLastActive(ago(26 * 60 * MIN), NOW)).not.toMatch(/ago|now/);
  });

  it("treats future or bad input safely", () => {
    expect(formatLastActive(new Date(NOW + 5 * MIN).toISOString(), NOW)).toBe("Active now");
    expect(formatLastActive(null, NOW)).toBe("Active recently");
    expect(formatLastActive("garbage", NOW)).toBe("Active recently");
  });
});

describe("row helpers", () => {
  it("last active falls back to sign-in time", () => {
    expect(lastActiveAt({ createdAt: "c", lastSeenAt: null })).toBe("c");
    expect(lastActiveAt({ createdAt: "c", lastSeenAt: "l" })).toBe("l");
  });

  it("maps sign-in methods and hides unknown ones", () => {
    expect(methodLabel("pwd")).toBe("Password");
    expect(methodLabel("oidc")).toBe("OIDC");
    expect(methodLabel("saml")).toBe("SAML");
    expect(methodLabel("weird")).toBeNull();
    expect(methodLabel(null)).toBeNull();
  });

  it("picks a phone icon only for mobile systems", () => {
    expect(deviceIcon("Safari on iOS")).toBe("smartphone");
    expect(deviceIcon("Chrome on Android")).toBe("smartphone");
    expect(deviceIcon("Firefox on Linux")).toBe("computer");
    expect(deviceIcon(undefined)).toBe("computer");
  });
});
