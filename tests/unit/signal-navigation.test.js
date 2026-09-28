import { describe, it, expect } from "vitest";
import { summarizeProviderBadges } from "@/lib/shellSummary";
import {
  NAV_GROUPS,
  VISIBLE_MEDIA_KINDS,
  MEDIA_TABS,
  isActive,
  visibleGroups,
  visibleItems,
  badgeAriaLabel,
  formatBadge,
  getMediaTabHref,
} from "@/shared/constants/navigation.js";

describe("navigation data", () => {
  it("groups Route, Watch, Tune, Debug in order", () => {
    expect(NAV_GROUPS.map((g) => g.id)).toEqual(["route", "watch", "tune", "debug"]);
  });

  it("Home points to /dashboard and Endpoint to /dashboard/endpoint", () => {
    const route = NAV_GROUPS.find((g) => g.id === "route").items;
    expect(route.find((i) => i.id === "home").href).toBe("/dashboard");
    expect(route.find((i) => i.id === "endpoint").href).toBe("/dashboard/endpoint");
  });

  it("Settings points to /dashboard/settings with match prefixes", () => {
    const tune = NAV_GROUPS.find((g) => g.id === "tune").items;
    const settings = tune.find((i) => i.id === "settings");
    expect(settings.href).toBe("/dashboard/settings");
    expect(settings.matchPrefixes).toContain("/dashboard/profile");
    expect(settings.matchPrefixes).toContain("/dashboard/settings");
  });

  it("Media providers is a single entry", () => {
    const tune = NAV_GROUPS.find((g) => g.id === "tune").items;
    const media = tune.find((i) => i.id === "media");
    expect(media.href).toBe("/dashboard/media-providers");
  });

  it("Translator lives in Debug", () => {
    const debug = NAV_GROUPS.find((g) => g.id === "debug").items;
    expect(debug.map((i) => i.id)).toEqual(["translator"]);
  });
});

describe("isActive", () => {
  const home = { id: "home", href: "/dashboard", exact: true };
  const endpoint = {
    id: "endpoint",
    href: "/dashboard/endpoint",
    matchPrefixes: ["/dashboard/endpoint"],
  };
  const providers = { id: "providers", href: "/dashboard/providers" };
  const settings = {
    id: "settings",
    href: "/dashboard/settings",
    matchPrefixes: ["/dashboard/settings", "/dashboard/profile"],
  };

  it("Home is exact on /dashboard", () => {
    expect(isActive("/dashboard", home)).toBe(true);
    expect(isActive("/dashboard/endpoint", home)).toBe(false);
  });

  it("Endpoint active only on /dashboard/endpoint (Home owns /dashboard)", () => {
    expect(isActive("/dashboard", endpoint)).toBe(false);
    expect(isActive("/dashboard/endpoint", endpoint)).toBe(true);
  });

  it("the real nav config has Home exact and nothing else active on /dashboard", () => {
    const active = visibleItems({ enableTranslator: true }).filter((i) =>
      isActive("/dashboard", i),
    );
    expect(active.map((i) => i.id)).toEqual(["home"]);
  });

  it("segment-safe prefix: /dashboard/providers does not match /dashboard/providersX", () => {
    expect(isActive("/dashboard/providers", providers)).toBe(true);
    expect(isActive("/dashboard/providers/abc", providers)).toBe(true);
    expect(isActive("/dashboard/providersX", providers)).toBe(false);
  });

  it("Settings matches /dashboard/settings and legacy /dashboard/profile", () => {
    expect(isActive("/dashboard/settings", settings)).toBe(true);
    expect(isActive("/dashboard/settings#pricing", settings)).toBe(true);
    expect(isActive("/dashboard/profile", settings)).toBe(true);
    expect(isActive("/dashboard/skills", settings)).toBe(false);
  });
});

describe("visibleGroups / visibleItems", () => {
  it("hides Translator when disabled", () => {
    const groups = visibleGroups({ enableTranslator: false });
    expect(groups.find((g) => g.id === "debug").items).toEqual([]);
    expect(visibleItems({ enableTranslator: false }).some((i) => i.id === "translator")).toBe(
      false,
    );
  });

  it("shows Translator when enabled", () => {
    expect(visibleItems({ enableTranslator: true }).some((i) => i.id === "translator")).toBe(true);
  });
});

describe("formatBadge", () => {
  it("returns null for empty counts and caps large numbers", () => {
    expect(formatBadge(0)).toBeNull();
    expect(formatBadge(14)).toBe("14");
    expect(formatBadge(100)).toBe("99+");
  });
});

describe("media tabs", () => {
  it("lists visible kinds plus web fetch & search", () => {
    expect(VISIBLE_MEDIA_KINDS[0]).toBe("embedding");
    const last = MEDIA_TABS[MEDIA_TABS.length - 1];
    expect(last).toMatchObject({ id: "web", href: "/dashboard/media-providers/web" });
    expect(getMediaTabHref("embedding")).toBe("/dashboard/media-providers/embedding");
  });
});

describe("shell provider badges", () => {
  it("counts distinct providers with an enabled connection (shared health rule)", () => {
    const connections = [
      { provider: "openai", testStatus: "active" },
      { provider: "openai", testStatus: "success" },
      { provider: "anthropic", testStatus: "active" },
      // Needs-attention connections still count as connected under the unified rule.
      { provider: "codex", testStatus: "error" },
      { provider: "disabled-one", testStatus: "active", isActive: false },
    ];
    expect(summarizeProviderBadges(connections).connected).toBe(3);
  });

  it("reports how many providers need attention and the worst status", () => {
    const attention = (rows) => summarizeProviderBadges(rows).attention;
    expect(attention([{ provider: "openai", testStatus: "active" }])).toEqual({
      count: 0,
      status: null,
    });
    expect(
      attention([
        { provider: "openai", testStatus: "active" },
        { provider: "codex", testStatus: "error" },
        { provider: "gemini", testStatus: "mystery" },
        { provider: "off", testStatus: "error", isActive: false },
      ]),
    ).toEqual({ count: 2, status: "err" });
    expect(attention([{ provider: "gemini", testStatus: "mystery" }])).toEqual({
      count: 1,
      status: "warn",
    });
    expect(attention(null)).toEqual({ count: 0, status: null });
  });
});

describe("badgeAriaLabel", () => {
  it("names the count for screen readers", () => {
    expect(badgeAriaLabel("providers", 14)).toBe("14 connected providers");
    expect(badgeAriaLabel("combos", 4)).toBe("4 combos");
    expect(badgeAriaLabel("quota", 2)).toBe("2 accounts low on quota");
  });

  it("uses singular nouns and names attention items", () => {
    expect(badgeAriaLabel("quota", 1)).toBe("1 account low on quota");
    expect(badgeAriaLabel("combos", 1)).toBe("1 combo");
    expect(badgeAriaLabel("providers", 9, 2)).toBe("9 connected providers, 2 need attention");
    expect(badgeAriaLabel("providers", 9, 1)).toBe("9 connected providers, 1 needs attention");
  });

  it("returns null for empty counts or unknown keys", () => {
    expect(badgeAriaLabel("providers", 0)).toBeNull();
    expect(badgeAriaLabel("unknown", 3)).toBeNull();
  });
});
