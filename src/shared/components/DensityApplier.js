"use client";

import { useEffect } from "react";
import { DENSITY_CLASS, resolveDensity } from "@/lib/density";

/**
 * Re-applies the persisted uiDensity class on the client after hydration.
 * The layout no-flash script paints the first frame; this keeps it in sync
 * when navigation replaces markup or the cookie changes in another tab.
 */
export default function DensityApplier() {
  useEffect(() => {
    const match = document.cookie.match(/(?:^|; )nr-density=([^;]*)/);
    const density = resolveDensity(match ? decodeURIComponent(match[1]) : "comfortable");
    document.documentElement.classList.toggle(DENSITY_CLASS, density === "compact");
  }, []);
  return null;
}
