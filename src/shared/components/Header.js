"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import PropTypes from "prop-types";
import ProviderTile from "@/shared/components/ProviderTile";
import HeaderMenu from "@/shared/components/HeaderMenu";
import HeaderLanguage from "@/shared/components/HeaderLanguage";
import DonateModal from "@/shared/components/DonateModal";
import IconButton from "@/shared/components/IconButton";
import CommandPaletteTrigger from "@/shared/components/CommandPaletteTrigger";
import { useHeaderSearchStore } from "@/store/headerSearchStore";
import {
  FREE_PROVIDERS,
  FREE_TIER_PROVIDERS,
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
} from "@/shared/constants/config";
import { MEDIA_PROVIDER_KINDS, AI_PROVIDERS } from "@/shared/constants/providers";
import { COMBINED_WEB_ITEM } from "@/shared/constants/navigation";
import { translate } from "@/i18n/runtime";

/**
 * Maps pathname to page title, description (subtitle line), icon and breadcrumbs.
 * Preserves every route mapping from the legacy Header.
 *
 * @param {string} pathname
 * @returns {{ title: string, description: string, icon?: string, breadcrumbs: Array<object> }}
 */
export const getPageInfo = (pathname) => {
  if (!pathname) return { title: "", description: "", breadcrumbs: [] };

  // Media provider detail: /dashboard/media-providers/[kind]/[id]
  const mediaDetailMatch = pathname.match(/\/media-providers\/([^/]+)\/([^/]+)$/);
  if (mediaDetailMatch) {
    const kindId = mediaDetailMatch[1];
    const providerId = mediaDetailMatch[2];
    if (kindId === "combo") {
      return {
        title: "",
        description: "",
        breadcrumbs: [
          { label: "Media Providers", href: "/dashboard/media-providers" },
          { label: "Combo", href: "/dashboard/media-providers" },
          { label: providerId },
        ],
      };
    }
    const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kindId);
    const provider = AI_PROVIDERS[providerId];
    // Detail page renders its own in-page h1 (YAN-314); shell shows breadcrumb only.
    return {
      title: "",
      description: "",
      breadcrumbs: [
        { label: "Media Providers", href: `/dashboard/media-providers/${kindId}` },
        { label: kindConfig?.label || kindId, href: `/dashboard/media-providers/${kindId}` },
        { label: provider?.name || providerId, providerId },
      ],
    };
  }

  // Media provider kind: /dashboard/media-providers/[kind]
  const mediaKindMatch = pathname.match(/\/media-providers\/([^/]+)$/);
  if (mediaKindMatch) {
    const kindId = mediaKindMatch[1];
    // The combined web page has no MEDIA_PROVIDER_KINDS entry; legacy showed the raw "web" id.
    const kindConfig =
      kindId === COMBINED_WEB_ITEM.id
        ? COMBINED_WEB_ITEM
        : MEDIA_PROVIDER_KINDS.find((k) => k.id === kindId);
    return {
      title: kindConfig?.label || kindId,
      description: `Manage your ${kindConfig?.label || kindId} providers`,
      icon: kindConfig?.icon || "perm_media",
      breadcrumbs: [],
    };
  }

  // Provider detail page: /dashboard/providers/[id]
  const providerMatch = pathname.match(/\/providers\/([^/]+)$/);
  if (providerMatch) {
    const providerId = providerMatch[1];
    // /dashboard/providers/new renders its own in-page h1 (YAN-314).
    if (providerId === "new") {
      return { title: "", description: "", breadcrumbs: [] };
    }
    const providerInfo =
      OAUTH_PROVIDERS[providerId] ||
      APIKEY_PROVIDERS[providerId] ||
      FREE_PROVIDERS[providerId] ||
      FREE_TIER_PROVIDERS[providerId];
    if (providerInfo) {
      return {
        title: providerInfo.name,
        description: "",
        breadcrumbs: [
          { label: "Providers", href: "/dashboard/providers" },
          {
            label: providerInfo.name,
            providerId: providerInfo.id,
          },
        ],
      };
    }
  }

  if (pathname.includes("/providers") && !pathname.includes("/media-providers"))
    return {
      title: "Providers",
      description: "Manage your AI provider connections",
      icon: "dns",
      breadcrumbs: [],
    };
  if (pathname.includes("/combos"))
    return {
      title: "Combos",
      description: "Model combos with fallback",
      icon: "layers",
      breadcrumbs: [],
    };
  if (pathname.includes("/usage"))
    return {
      // UsagePage renders its own in-page h1; the shell must stay h1-free
      // so the document keeps exactly one h1 (YAN-314).
      title: "",
      description: "",
      breadcrumbs: [],
    };
  if (pathname.includes("/auth-files"))
    return {
      title: "Auth Files",
      description: "Map provider credentials stored in the local database",
      icon: "vpn_key",
      breadcrumbs: [],
    };
  if (pathname.includes("/quota"))
    return {
      title: "Quota",
      description: "How much runway each account has left.",
      icon: "data_usage",
      breadcrumbs: [],
    };
  if (pathname.includes("/mitm"))
    return {
      title: "MITM Proxy",
      description: "Intercept CLI tool traffic and route through 9Router",
      icon: "security",
      breadcrumbs: [],
    };
  if (pathname.includes("/token-saver"))
    return {
      title: "Token Saver",
      description: "Compress prompts and outputs to save tokens",
      icon: "savings",
      breadcrumbs: [],
    };
  if (pathname.includes("/cli-tools"))
    return {
      title: "CLI Tools",
      description: "Configure CLI tools",
      icon: "terminal",
      breadcrumbs: [],
    };
  if (pathname.includes("/proxy-pools"))
    return {
      title: "Proxy Pools",
      description: "Manage your proxy pool configurations",
      icon: "lan",
      breadcrumbs: [],
    };
  if (pathname.includes("/skills"))
    return {
      title: "Skills",
      description: "Teach any AI agent to use your 9router with one line.",
      icon: "extension",
      breadcrumbs: [],
    };
  if (pathname.includes("/endpoint"))
    return {
      title: "Endpoint & keys",
      description: "Where your tools connect, and who is allowed in.",
      icon: "api",
      breadcrumbs: [],
    };
  if (pathname.includes("/settings") || pathname.includes("/profile")) {
    // /dashboard/settings renders its own in-page h1; /dashboard/profile is a
    // redirect stub whose region violation is a stub artifact (YAN-314: keep
    // the shell h1 there so the stub keeps one h1 + landmark coverage).
    const isStub = pathname.includes("/profile");
    return {
      title: isStub ? "Settings" : "",
      description: isStub ? "Every knob in one place" : "",
      icon: isStub ? "settings" : undefined,
      breadcrumbs: [],
    };
  }
  if (pathname.includes("/translator"))
    return {
      title: "Translator",
      description: "Debug translation flow between formats",
      icon: "translate",
      breadcrumbs: [],
    };
  if (pathname.includes("/console-log"))
    return {
      title: "Console Log",
      description: "Live server console output",
      icon: "monitor",
      breadcrumbs: [],
    };
  // Home renders its own derived status line, H1 and period control in-page.
  if (pathname === "/dashboard") return { title: "", description: "", breadcrumbs: [] };
  return { title: "", description: "", breadcrumbs: [] };
};

/**
 * Signal shell header:
 * - Muted subtitle line ABOVE Bricolage display H1
 * - Provider breadcrumb preserved
 * - Mobile hamburger (<1024px)
 * - Right actions: SSO name pill, registered search (providers page),
 *   heart Donate IconButton, HeaderLanguage, HeaderMenu, optional children
 *
 * @param {object} props
 * @param {() => void} [props.onMenuClick] Mobile menu hamburger trigger.
 * @param {boolean} [props.showMenuButton=true]
 * @param {React.ReactNode} [props.actions] Optional page-injected actions.
 * @param {boolean} [props.sidebarOpen=false] Accessible expanded state for the hamburger.
 */
export default function Header({
  onMenuClick,
  showMenuButton = true,
  actions,
  sidebarOpen = false,
}) {
  const pathname = usePathname();
  const [displayName, setDisplayName] = useState("");
  const [loginMethod, setLoginMethod] = useState("");
  const [donateOpen, setDonateOpen] = useState(false);

  const pageInfo = useMemo(() => getPageInfo(pathname), [pathname]);
  const { title, description, breadcrumbs } = pageInfo;

  useEffect(() => {
    let cancelled = false;
    async function loadAuthStatus() {
      try {
        const res = await fetch("/api/auth/status", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setDisplayName(
            data?.displayName ||
              data?.samlName ||
              data?.samlEmail ||
              data?.oidcName ||
              data?.oidcEmail ||
              "",
          );
          setLoginMethod(data?.loginMethod || "");
        }
      } catch {
        if (!cancelled) {
          setDisplayName("");
          setLoginMethod("");
        }
      }
    }
    loadAuthStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogout = async () => {
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      if (res.ok) window.location.assign("/login");
    } catch (err) {
      console.error("Failed to logout:", err);
    }
  };

  return (
    <header className="flex shrink-0 items-end justify-between gap-3 px-4 pt-6 pb-4 lg:px-10 lg:pt-7 lg:pb-5">
      {/* Mobile hamburger */}
      {showMenuButton && (
        <div className="flex shrink-0 items-center lg:hidden">
          <IconButton
            icon="menu"
            label="Open navigation"
            aria-controls="mobile-sidebar-drawer"
            aria-expanded={sidebarOpen}
            onClick={onMenuClick}
          />
        </div>
      )}

      {/* Title block: subtitle ABOVE display H1 per the Signal board */}
      <div className="flex min-w-[9rem] max-w-[28rem] flex-col gap-1 lg:min-w-[14rem]">
        {breadcrumbs.length > 0 ? (
          <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-muted">
            {breadcrumbs.map((crumb, index) => (
              <div
                key={`${crumb.label}-${crumb.href || "current"}`}
                className="flex items-center gap-1.5"
              >
                {index > 0 && (
                  <span
                    className="material-symbols-outlined text-[14px] text-subtle rtl:rotate-180"
                    aria-hidden="true"
                  >
                    chevron_right
                  </span>
                )}
                {crumb.href ? (
                  <Link href={crumb.href} className="hover:text-text transition-colors">
                    {crumb.label}
                  </Link>
                ) : (
                  <span className="flex items-center gap-1.5 font-medium text-text">
                    {crumb.providerId && <ProviderTile providerId={crumb.providerId} size="sm" />}
                    <span>{translate(crumb.label)}</span>
                  </span>
                )}
              </div>
            ))}
          </nav>
        ) : description ? (
          <p className="text-xs font-medium text-muted lg:text-sm">{translate(description)}</p>
        ) : null}

        {title ? (
          <h1 className="truncate font-display text-2xl font-bold tracking-[-0.02em] text-text lg:text-[42px] lg:leading-[1.05]">
            {translate(title)}
          </h1>
        ) : null}
      </div>

      {/* Right actions */}
      <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
        {displayName && (loginMethod === "OIDC" || loginMethod === "SAML") && (
          <div
            className="hidden items-center gap-1.5 rounded-full border border-line bg-raised px-3 py-1 text-xs text-muted sm:flex"
            title={displayName}
          >
            <span className="material-symbols-outlined text-[14px] text-sky" aria-hidden="true">
              person
            </span>
            <span className="max-w-[140px] truncate">{displayName}</span>
            <span className="rounded-full bg-sky-bg px-2 py-0.5 text-[10px] font-semibold uppercase text-sky">
              {loginMethod}
            </span>
          </div>
        )}

        <CommandPaletteTrigger />

        <HeaderSearch />

        {/* Support heart icon button */}
        <IconButton
          icon="volunteer_activism"
          label="Support 9router"
          onClick={() => setDonateOpen(true)}
          className="text-coral hover:bg-coral-bg hover:text-coral-ink"
        />

        {/* Page-injected actions slot */}
        {actions}

        <HeaderLanguage />
        <HeaderMenu onLogout={handleLogout} />
      </div>

      <DonateModal isOpen={donateOpen} onClose={() => setDonateOpen(false)} />
    </header>
  );
}

Header.propTypes = {
  onMenuClick: PropTypes.func,
  showMenuButton: PropTypes.bool,
  actions: PropTypes.node,
  sidebarOpen: PropTypes.bool,
};

function HeaderSearch() {
  const visible = useHeaderSearchStore((s) => s.visible);
  const query = useHeaderSearchStore((s) => s.query);
  const placeholder = useHeaderSearchStore((s) => s.placeholder);
  const setQuery = useHeaderSearchStore((s) => s.setQuery);

  if (!visible) return null;

  return (
    <div className="relative min-w-[120px] max-w-[240px] flex-1">
      <span
        className="material-symbols-outlined pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-[18px] text-muted"
        aria-hidden="true"
      >
        search
      </span>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder || "Search"}
        className="h-10 w-full rounded-xl border border-line bg-raised pe-8 ps-8 text-sm text-text placeholder:text-subtle focus-visible:outline-none focus-visible:shadow-focus"
      />
      {query && (
        <button
          type="button"
          onClick={() => setQuery("")}
          className="absolute end-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted hover:text-text"
          aria-label="Clear search"
        >
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
            close
          </span>
        </button>
      )}
    </div>
  );
}
