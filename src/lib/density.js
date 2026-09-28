"use client";

// Client-side density helpers: root-class wiring + cookie persistence so the
// pre-paint script in src/app/layout.js can re-apply compact before CSS loads.

export const DENSITY_COOKIE = "nr-density";
export const DENSITY_CLASS = "compact-density";

export function resolveDensity(value) {
  return value === "compact" ? "compact" : "comfortable";
}

/** Apply the density class now and persist it for the next cold load. */
export function applyDensity(value) {
  const density = resolveDensity(value);
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle(DENSITY_CLASS, density === "compact");
  }
  persistDensityCookie(density);
  return density;
}

/** Persist the density cookie (1y, cheap: tiny allowlisted value). */
export function persistDensityCookie(value) {
  if (typeof document === "undefined") return;
  const density = resolveDensity(value);
  document.cookie = `${DENSITY_COOKIE}=${density}; path=/; max-age=31536000; samesite=lax`;
}
