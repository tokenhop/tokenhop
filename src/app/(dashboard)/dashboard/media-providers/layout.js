"use client";

import Link from "next/link";
import PropTypes from "prop-types";
import { usePathname } from "next/navigation";
import { MEDIA_TABS } from "@/shared/constants/navigation";
import { cn } from "@/shared/utils/cn";

/**
 * Signal media providers layout (YAN-305).
 * Kind tabs: Embedding, Image, Video, Text to speech, Speech to text, Web search & fetch.
 * Tabs are deep routes with arrow-key navigation between links, and a
 * Signal SegmentedControl-style container matching Media.dc.html.
 *
 * @param {object} props
 * @param {React.ReactNode} props.children
 */
export default function MediaProvidersLayout({ children }) {
  const pathname = usePathname() || "";

  const isTabActive = (href) => {
    if (!pathname) return false;
    if (href.endsWith("/web")) {
      return pathname === href || pathname.startsWith("/dashboard/media-providers/web");
    }
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  // Arrow keys move between route tabs; Enter/Space follows the focused link natively.
  const handleKeyDown = (event, index) => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const isRtl = event.currentTarget.closest("[dir]")?.getAttribute("dir") === "rtl";
    const total = MEDIA_TABS.length;
    let nextIndex = index;

    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = total - 1;
    else if (event.key === "ArrowRight")
      nextIndex = isRtl ? (index - 1 + total) % total : (index + 1) % total;
    else if (event.key === "ArrowLeft")
      nextIndex = isRtl ? (index + 1) % total : (index - 1 + total) % total;

    event.currentTarget.parentElement?.querySelectorAll("a")[nextIndex]?.focus();
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {/* Route-based Kind Tabs with Segmented styling matching Media.dc.html */}
      <nav
        aria-label="Media providers navigation"
        className="inline-flex max-w-full flex-wrap items-center gap-1 self-start rounded-xl border border-line bg-panel p-1 shadow-card"
      >
        {MEDIA_TABS.map((tab, index) => {
          const active = isTabActive(tab.href);
          return (
            <Link
              key={tab.id}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              onKeyDown={(e) => handleKeyDown(e, index)}
              className={cn(
                "inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-3.5 text-xs font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:shadow-focus motion-reduce:transition-none sm:text-sm",
                active
                  ? "bg-text text-bg shadow-sm"
                  : "text-muted hover:text-text hover:bg-raised/50",
              )}
            >
              <span
                className={cn("material-symbols-outlined text-[18px]", active && "fill-1")}
                aria-hidden="true"
              >
                {tab.icon}
              </span>
              <span>{tab.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Main page content for the active kind */}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

MediaProvidersLayout.propTypes = {
  children: PropTypes.node,
};
