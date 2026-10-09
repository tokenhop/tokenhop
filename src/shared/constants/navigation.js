// Navigation constants and helpers for the Signal shell.
// Defines grouped routes (Route, Watch, Tune, Debug) and media kinds.

import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/mediaProviderKinds";

/**
 * Visible media kinds in the new single-entry media providers page.
 * Embedding is the default/first kind.
 */
export const VISIBLE_MEDIA_KINDS = ["embedding", "image", "video", "tts", "stt"];

/**
 * Combined web entry item (web search and fetch share one page).
 */
export const COMBINED_WEB_ITEM = {
  id: "web",
  label: "Web fetch and search",
  icon: "travel_explore",
  href: "/dashboard/media-providers/web",
};

/**
 * Tabs above media-providers children, in visible-kind order, then web.
 */
export const MEDIA_TABS = [
  ...VISIBLE_MEDIA_KINDS.map((id) => {
    const kind = MEDIA_PROVIDER_KINDS.find((k) => k.id === id);
    return {
      id,
      label: kind?.label || id,
      icon: kind?.icon || "perm_media",
      href: `/dashboard/media-providers/${id}`,
    };
  }),
  COMBINED_WEB_ITEM,
];

export function getMediaTabHref(kindId) {
  if (kindId === "web" || kindId === "webSearch" || kindId === "webFetch") {
    return COMBINED_WEB_ITEM.href;
  }
  return `/dashboard/media-providers/${kindId}`;
}

/**
 * Navigation groups matching Signal shell design:
 * - Route: Home, Providers, Combos, Endpoint & keys
 * - Watch: Usage, Quota, Console log
 * - Tune: Token saver, CLI tools, Media providers, Proxy pools, Skills, Settings
 * - Debug: Translator (shown only when enableTranslator is true)
 */
export const NAV_GROUPS = [
  {
    id: "route",
    label: "Route",
    items: [
      {
        id: "home",
        label: "Home",
        icon: "home",
        href: "/dashboard",
        exact: true,
      },
      {
        id: "providers",
        label: "Providers",
        icon: "dns",
        href: "/dashboard/providers",
        badgeKey: "providers",
      },
      {
        id: "combos",
        label: "Combos",
        icon: "layers",
        href: "/dashboard/combos",
        badgeKey: "combos",
      },
      {
        id: "endpoint",
        label: "Endpoint & keys",
        icon: "api",
        href: "/dashboard/endpoint",
        matchPrefixes: ["/dashboard/endpoint"],
      },
    ],
  },
  {
    id: "watch",
    label: "Watch",
    items: [
      {
        id: "usage",
        label: "Usage",
        icon: "bar_chart",
        href: "/dashboard/usage",
      },
      {
        id: "audit",
        label: "Audit log",
        icon: "history",
        href: "/dashboard/audit",
        gate: "multiUser",
        capAny: ["instance.audit.read", "workspace.audit.read"],
      },
      {
        id: "quota",
        label: "Quota",
        icon: "data_usage",
        href: "/dashboard/quota",
        badgeKey: "quota",
      },
      {
        id: "console-log",
        label: "Console log",
        icon: "terminal",
        href: "/dashboard/console-log",
        cap: "instance.hostOps",
      },
    ],
  },
  {
    id: "tune",
    label: "Tune",
    items: [
      {
        id: "token-saver",
        label: "Token saver",
        icon: "savings",
        href: "/dashboard/token-saver",
        cap: "instance.settings.manage",
      },
      {
        id: "cli-tools",
        label: "CLI tools",
        icon: "terminal",
        href: "/dashboard/cli-tools",
        cap: "instance.hostOps",
      },
      {
        id: "media",
        label: "Media providers",
        icon: "perm_media",
        href: "/dashboard/media-providers",
      },
      {
        id: "proxy-pools",
        label: "Proxy pools",
        icon: "lan",
        href: "/dashboard/proxy-pools",
        cap: "instance.settings.manage",
      },
      {
        id: "skills",
        label: "Skills",
        icon: "extension",
        href: "/dashboard/skills",
      },
      {
        id: "settings",
        label: "Settings",
        icon: "settings",
        href: "/dashboard/settings",
        matchPrefixes: ["/dashboard/settings", "/dashboard/profile"],
      },
    ],
  },
  {
    id: "debug",
    label: "Debug",
    items: [
      {
        id: "translator",
        label: "Translator",
        icon: "translate",
        href: "/dashboard/translator",
        cap: "instance.hostOps",
        gate: "enableTranslator",
      },
    ],
  },
];

/**
 * Pure segment-safe path prefix matcher.
 * E.g. matchesPrefix("/dashboard/providers/abc", "/dashboard/providers") -> true
 *      matchesPrefix("/dashboard/providersX", "/dashboard/providers") -> false
 */
function matchesPrefix(pathname, prefix) {
  if (pathname === prefix) return true;
  if (!pathname.startsWith(prefix)) return false;
  const nextChar = pathname.charAt(prefix.length);
  return nextChar === "/" || nextChar === "?" || nextChar === "#";
}

/**
 * Pure isActive helper.
 * - Items with `exact` (Home): exact match on their href ("/dashboard").
 * - Items with matchPrefixes: match if pathname matches any prefix safely.
 * - Other items: segment-safe prefix of their href.
 *
 * @param {string} pathname
 * @param {object} item
 * @returns {boolean}
 */
export function isActive(pathname, item) {
  if (!pathname || !item) return false;
  if (item.exact) {
    return pathname === item.href;
  }

  if (Array.isArray(item.matchPrefixes) && item.matchPrefixes.length > 0) {
    return item.matchPrefixes.some((prefix) => matchesPrefix(pathname, prefix));
  }

  return matchesPrefix(pathname, item.href);
}

/**
 * Visible groups filter (hides gated items when disabled).
 * @param {object} [settings]
 * @param {boolean} [settings.enableTranslator]
 * @param {boolean} [settings.multiUser] Users & teams switch (YAN-351).
 * @param {(capability: string) => boolean} [settings.can] Capability check
 *   (YAN-371). Items with a `cap` the principal lacks are hidden. Cosmetic:
 *   the server enforces. Omitted (single-user) leaves every item visible.
 */
export function visibleGroups(settings = {}) {
  const enableTranslator = Boolean(settings?.enableTranslator);
  const multiUser = Boolean(settings?.multiUser);
  const can = typeof settings?.can === "function" ? settings.can : null;
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => {
      if (item.gate === "enableTranslator" && !enableTranslator) return false;
      if (item.gate === "multiUser" && !multiUser) return false;
      if (can && item.cap && !can(item.cap)) return false;
      if (can && item.capAny && !item.capAny.some(can)) return false;
      return true;
    }),
  }));
}

/**
 * Flat list of visible items.
 */
export function visibleItems(settings = {}) {
  return visibleGroups(settings).flatMap((g) => g.items);
}

/**
 * Format badge value for nav item chips.
 * Returns null if zero/empty; string "99+" if >= 100.
 * @param {number|null|undefined} count
 * @returns {string|null}
 */
export function formatBadge(count) {
  if (typeof count !== "number" || !Number.isFinite(count)) return null;
  if (count <= 0) return null;
  if (count > 99) return "99+";
  return String(count);
}

// [singular, plural] so screen readers never hear "1 combos".
const BADGE_NOUNS = {
  providers: ["connected provider", "connected providers"],
  combos: ["combo", "combos"],
  quota: ["account low on quota", "accounts low on quota"],
};

/**
 * Screen-reader text for a nav badge, e.g. "14 connected providers" or
 * "9 connected providers, 2 need attention".
 * @param {string} badgeKey
 * @param {number} count
 * @param {number} [attentionCount=0] Items in that count that need attention.
 * @returns {string|null} null when there is nothing to announce
 */
export function badgeAriaLabel(badgeKey, count, attentionCount = 0) {
  const nouns = BADGE_NOUNS[badgeKey];
  if (!nouns || formatBadge(count) === null) return null;
  const base = `${count} ${count === 1 ? nouns[0] : nouns[1]}`;
  if (!(attentionCount > 0)) return base;
  return `${base}, ${attentionCount} ${attentionCount === 1 ? "needs" : "need"} attention`;
}
