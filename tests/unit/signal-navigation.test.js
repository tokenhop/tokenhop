import { describe, it, expect } from "vitest";
import {
  countConnectedProviders,
  countLowQuotaAccounts,
  readTranslatorGate,
} from "@/shared/hooks/useShellStatus.js";
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

describe("shell status helpers", () => {
  it("counts distinct providers with an enabled connection (shared health rule)", () => {
    const connections = [
      { provider: "openai", testStatus: "active" },
      { provider: "openai", testStatus: "success" },
      { provider: "anthropic", testStatus: "active" },
      // Needs-attention connections still count as connected under the unified rule.
      { provider: "codex", testStatus: "error" },
      { provider: "disabled-one", testStatus: "active", isActive: false },
    ];
    expect(countConnectedProviders(connections)).toBe(3);
  });

  it("counts accounts at or below the low-quota threshold", () => {
    const quotaData = {
      c1: { quotas: [{ remainingPercentage: 15 }] },
      c2: { quotas: [{ remainingPercentage: 80 }] },
      c3: { quotas: [{ total: 100, used: 95 }] }, // 5% left <= 20%
      c4: { quotas: [{ total: 100, used: 50 }] }, // 50% left
    };
    expect(countLowQuotaAccounts(quotaData, 20)).toBe(2);
  });
});

describe("badgeAriaLabel", () => {
  it("names the count for screen readers", () => {
    expect(badgeAriaLabel("providers", 14)).toBe("14 connected providers");
    expect(badgeAriaLabel("combos", 4)).toBe("4 combos");
    expect(badgeAriaLabel("quota", 2)).toBe("2 low quota accounts");
  });

  it("returns null for empty counts or unknown keys", () => {
    expect(badgeAriaLabel("providers", 0)).toBeNull();
    expect(badgeAriaLabel("unknown", 3)).toBeNull();
  });
});

describe("readTranslatorGate", () => {
  const ok = (body) => ({ status: "fulfilled", value: { ok: true, json: async () => body } });

  it("follows the settings payload both ways", async () => {
    expect(await readTranslatorGate(ok({ enableTranslator: true }), false)).toBe(true);
    expect(await readTranslatorGate(ok({ enableTranslator: false }), true)).toBe(false);
    expect(await readTranslatorGate(ok({}), true)).toBe(false);
  });

  it("keeps the previous value when the fetch fails", async () => {
    expect(await readTranslatorGate({ status: "rejected", reason: new Error("x") }, true)).toBe(
      true,
    );
    expect(await readTranslatorGate({ status: "fulfilled", value: { ok: false } }, false)).toBe(
      false,
    );
  });
});
