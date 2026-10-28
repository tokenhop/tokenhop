"use client";

import { useEffect, useState } from "react";
import { PERIOD_VALUES } from "@/shared/utils/period";
import { fetchJson } from "./tokenSaverApi";

const hasSavings = (data) => Number(data?.tokensSavedEst) > 0;

/**
 * Current-period savings with a best-period fallback. Fetches
 * `/api/usage/savings?period=` for `period`; when it holds no savings the
 * largest period is fetched first (windows are nested), and only when it has
 * savings are the periods in between fetched in parallel so the smallest
 * non-empty one wins. `neverSaved` is true when the largest period loads
 * empty; the selected period being `all` is the same check (nothing larger
 * exists), so an empty `all` claims `neverSaved` directly, unless that probe
 * reports `prunedBeforeTracking` (history pruned before savings were tracked
 * may have held savings): then `neverSaved` stays false and `prunedBeforeTracking`
 * is set so the hero can say so. A failed fallback
 * fetch is not fatal: it leaves `neverSaved` false (the selected period is
 * still known empty). No fetch runs while `period` is
 * null (loading stays true). In-flight requests abort on unmount or change.
 *
 * @param {string|null} period Current summary period.
 * @param {number} [refreshKey] Bump to re-read.
 * The selected period's `savings` also carries `currentTotals`/`previous`
 * ({tokensSavedEst, requestsWithSavings, costSavedEst}, compare=previous);
 * fallback probes never request them.
 * @returns {{ savings: object|null, loading: boolean, error: string|null, fallback: { period: string, savings: object }|null, neverSaved: boolean, prunedBeforeTracking: boolean }}
 */
export function useSavingsWithFallback(period, refreshKey = 0) {
  const [state, setState] = useState({
    savings: null,
    loading: true,
    error: null,
    fallback: null,
    neverSaved: false,
    prunedBeforeTracking: false,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey intentionally re-fetches on Retry/settings save.
  useEffect(() => {
    setState({
      savings: null,
      loading: true,
      error: null,
      fallback: null,
      neverSaved: false,
      prunedBeforeTracking: false,
    });
    if (!period) return;
    const controller = new AbortController();
    const get = (value, compare = false) =>
      fetchJson(`/api/usage/savings?period=${value}${compare ? "&compare=previous" : ""}`, {
        signal: controller.signal,
      });

    (async () => {
      let savings;
      try {
        savings = await get(period, true);
      } catch (fetchError) {
        if (!controller.signal.aborted) {
          setState((s) => ({ ...s, loading: false, error: fetchError.message }));
        }
        return;
      }
      if (controller.signal.aborted) return;
      if (hasSavings(savings)) {
        setState((s) => ({ ...s, savings, loading: false }));
        return;
      }
      const candidates = PERIOD_VALUES.slice(PERIOD_VALUES.indexOf(period) + 1);
      const done = (patch) => setState((s) => ({ ...s, savings, loading: false, ...patch }));
      // The selected period is the largest: an empty `all` proves nothing was
      // ever saved; any other empty largest period does not.
      const emptyVerdict = (probe) => ({
        neverSaved: probe.prunedBeforeTracking !== true,
        prunedBeforeTracking: probe.prunedBeforeTracking === true,
      });
      if (candidates.length === 0) {
        return done(period === "all" ? emptyVerdict(savings) : {});
      }
      // Windows are nested, so probe the largest first: when it is empty, so is every smaller one.
      const largest = candidates.at(-1);
      let widest;
      try {
        widest = await get(largest);
      } catch {
        if (!controller.signal.aborted) done({});
        return;
      }
      if (controller.signal.aborted) return;
      if (!hasSavings(widest)) return done(emptyVerdict(widest));
      const smaller = candidates.slice(0, -1);
      const results = await Promise.allSettled(smaller.map((value) => get(value)));
      if (controller.signal.aborted) return;
      const hit = results.findIndex((r) => r.status === "fulfilled" && hasSavings(r.value));
      done({
        fallback:
          hit >= 0
            ? { period: smaller[hit], savings: results[hit].value }
            : { period: largest, savings: widest },
      });
    })();
    return () => controller.abort();
  }, [period, refreshKey]);

  return state;
}
