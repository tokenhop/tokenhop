"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { DENSITY_CLASS, applyDensity, resolveDensity } from "@/lib/density";

/**
 * Re-applies the persisted uiDensity class on the client after hydration.
 * The layout no-flash script paints the first frame; this keeps it in sync
 * when navigation replaces markup or the cookie changes in another tab.
 *
 * Multi-user: the cookie is per browser, not per account, so after each
 * navigation (login, account switch) the signed-in user's saved density is
 * fetched and wins over the cookie, which it then rewrites. Switch off (404),
 * signed out (401), errors: the cookie stays authoritative.
 */
export default function DensityApplier() {
  const pathname = usePathname();

  useEffect(() => {
    const match = document.cookie.match(/(?:^|; )nr-density=([^;]*)/);
    const density = resolveDensity(match ? decodeURIComponent(match[1]) : "comfortable");
    document.documentElement.classList.toggle(DENSITY_CLASS, density === "compact");

    if (pathname?.startsWith("/login")) return undefined;
    // Abort on the next navigation so a slow response can't apply a stale account's value.
    const controller = new AbortController();
    fetch("/api/me/preferences", { cache: "no-store", signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!body || controller.signal.aborted) return;
        // No explicit preference means the default, not the previous user's cookie.
        applyDensity(body.data?.uiDensity);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [pathname]);

  return null;
}
