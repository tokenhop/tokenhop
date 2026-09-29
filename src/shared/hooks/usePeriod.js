"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  coercePeriod,
  isPeriod,
  loadStoredPeriod,
  PERIOD_VALUES,
  periodOptions,
  resolvePeriod,
  saveStoredPeriod,
} from "@/shared/utils/period";

/**
 * URL-backed dashboard period with a remembered fallback after hydration.
 * Requires a Suspense boundary for useSearchParams.
 * @param {string[]} [allowed] Period values available on this page.
 * @returns {{period: string|null, setPeriod: (value: string) => void, options: {value: string, label: string}[]}}
 */
export default function usePeriod(allowed = PERIOD_VALUES) {
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
  const period = isPeriod(urlValue)
    ? coercePeriod(urlValue, stableAllowed)
    : stored === undefined
      ? null
      : resolvePeriod({ storedValue: stored, allowed: stableAllowed });

  const setPeriod = useCallback(
    (value) => {
      const next = coercePeriod(value, stableAllowed);
      // Still rewrite when the URL holds a non-canonical value (e.g. 60d coerced to 30d).
      if (next === period && searchParams.get("period") === next) return;
      saveStoredPeriod(next);
      setStored(next);
      const params = new URLSearchParams(searchParams.toString());
      params.set("period", next);
      window.history.replaceState(null, "", `${pathname}?${params}${window.location.hash}`);
    },
    [stableAllowed, period, pathname, searchParams],
  );

  return { period, setPeriod, options };
}
