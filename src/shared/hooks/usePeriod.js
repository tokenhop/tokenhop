"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CUSTOM_PERIOD,
  coercePeriod,
  isCustomPeriod,
  isPeriod,
  loadStoredPeriod,
  localTodayKey,
  PERIOD_VALUES,
  parseDateRange,
  periodOptions,
  resolvePeriod,
  saveStoredPeriod,
} from "@/shared/utils/period";

/**
 * URL-backed dashboard period with a remembered fallback after hydration.
 * Requires a Suspense boundary for useSearchParams.
 *
 * With `allowCustom` (Usage page only), `?period=custom&from=YYYY-MM-DD&to=…`
 * selects an inclusive custom day range. The URL is the only place a custom
 * range lives: it is never written to localStorage, so other pages and the
 * next visit keep the remembered named period. A custom URL whose range is
 * missing or invalid falls back to the stored/default named period.
 *
 * @param {string[]} [allowed] Named period values available on this page.
 * @param {{allowCustom?: boolean}} [opts]
 * @returns {{
 *   period: string|null,
 *   range: {from: string, to: string}|null,
 *   setPeriod: (value: string) => void,
 *   setRange: (from: string, to: string) => boolean,
 *   options: {value: string, label: string}[],
 * }}
 */
export default function usePeriod(allowed = PERIOD_VALUES, { allowCustom = false } = {}) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const allowedKey = allowed.join(",");
  const stableAllowed = useMemo(() => allowedKey.split(","), [allowedKey]);
  const options = useMemo(() => periodOptions(stableAllowed), [stableAllowed]);
  const [stored, setStored] = useState(undefined);

  useEffect(() => {
    setStored(loadStoredPeriod());
  }, []);

  const urlValue = searchParams.get("period");
  const urlFrom = searchParams.get("from");
  const urlTo = searchParams.get("to");
  // Validated against local today after hydration only (stored !== undefined),
  // so SSR and the first client render agree on a null period.
  const range = useMemo(() => {
    if (!allowCustom || !isCustomPeriod(urlValue) || stored === undefined) return null;
    const parsed = parseDateRange(urlFrom, urlTo, localTodayKey());
    return parsed.ok ? { from: parsed.from, to: parsed.to } : null;
  }, [allowCustom, urlValue, urlFrom, urlTo, stored]);

  const period = range
    ? CUSTOM_PERIOD
    : isPeriod(urlValue)
      ? coercePeriod(urlValue, stableAllowed)
      : stored === undefined
        ? null
        : resolvePeriod({ storedValue: stored, allowed: stableAllowed });

  const writeUrl = useCallback(
    (params) => {
      window.history.replaceState(null, "", `${pathname}?${params}${window.location.hash}`);
    },
    [pathname],
  );

  const setPeriod = useCallback(
    (value) => {
      const next = coercePeriod(value, stableAllowed);
      // Still rewrite when the URL holds a non-canonical value (e.g. 60d coerced
      // to 30d) or leftover custom-range params.
      if (
        next === period &&
        searchParams.get("period") === next &&
        !(allowCustom && (searchParams.has("from") || searchParams.has("to")))
      ) {
        return;
      }
      saveStoredPeriod(next);
      setStored(next);
      const params = new URLSearchParams(searchParams.toString());
      params.set("period", next);
      if (allowCustom) {
        params.delete("from");
        params.delete("to");
      }
      writeUrl(params);
    },
    [allowCustom, stableAllowed, period, searchParams, writeUrl],
  );

  /** Select a custom range. Returns false (and changes nothing) when invalid. */
  const setRange = useCallback(
    (from, to) => {
      if (!allowCustom) return false;
      const parsed = parseDateRange(from, to, localTodayKey());
      if (!parsed.ok) return false;
      const params = new URLSearchParams(searchParams.toString());
      params.set("period", CUSTOM_PERIOD);
      params.set("from", parsed.from);
      params.set("to", parsed.to);
      writeUrl(params);
      return true;
    },
    [allowCustom, searchParams, writeUrl],
  );

  return { period, range, setPeriod, setRange, options };
}
