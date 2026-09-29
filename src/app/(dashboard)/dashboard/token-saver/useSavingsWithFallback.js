"use client";

import { useEffect, useState } from "react";
import { SUMMARY_PERIODS } from "@/shared/utils/period";
import { fetchJson } from "./tokenSaverApi";

const hasSavings = (data) => Number(data?.tokensSavedEst) > 0;

/**
 * Current-period savings with a best-period fallback. Fetches
 * `/api/usage/savings?period=` for `period`; when it holds no savings the
 * larger SUMMARY_PERIODS are fetched in parallel and the smallest non-empty
 * one wins. `neverSaved` is true only when every larger period loads empty.
 * A failed fallback fetch is not fatal: it leaves `neverSaved` false (the
 * selected period is still known empty). No fetch runs while `period` is
 * null (loading stays true). In-flight requests abort on unmount or change.
 *
 * @param {string|null} period Current summary period.
 * @param {number} [refreshKey] Bump to re-read.
 * @returns {{ savings: object|null, loading: boolean, error: string|null, fallback: { period: string, savings: object }|null, neverSaved: boolean }}
 */
export function useSavingsWithFallback(period, refreshKey = 0) {
  const [state, setState] = useState({
    savings: null,
    loading: true,
    error: null,
    fallback: null,
    neverSaved: false,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey intentionally re-fetches on Retry/settings save.
  useEffect(() => {
    setState({ savings: null, loading: true, error: null, fallback: null, neverSaved: false });
    if (!period) return;
    const controller = new AbortController();
    const get = (value) =>
      fetchJson(`/api/usage/savings?period=${value}`, { signal: controller.signal });

    (async () => {
      let savings;
      try {
        savings = await get(period);
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
      const candidates = SUMMARY_PERIODS.slice(SUMMARY_PERIODS.indexOf(period) + 1);
      const results = await Promise.allSettled(candidates.map(get));
      if (controller.signal.aborted) return;
      const hit = results.findIndex((r) => r.status === "fulfilled" && hasSavings(r.value));
      const failed = results.some((r) => r.status === "rejected");
      setState((s) => ({
        ...s,
        savings,
        loading: false,
        fallback: hit >= 0 ? { period: candidates[hit], savings: results[hit].value } : null,
        neverSaved: hit < 0 && !failed,
      }));
    })();
    return () => controller.abort();
  }, [period, refreshKey]);

  return state;
}
