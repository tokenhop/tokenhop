"use client";

import { useEffect, useState } from "react";
import { SUMMARY_PERIODS } from "@/shared/utils/period";
import { fetchJson } from "./tokenSaverApi";

/**
 * Current-period savings with a best-period fallback. Fetches
 * `/api/usage/savings?period=` for `period`; when it holds no savings the
 * larger SUMMARY_PERIODS are tried in order, stopping at the first hit.
 * `neverSaved` is true only when every larger period loads empty — a failed
 * fallback fetch is not fatal: it leaves `neverSaved` false (the selected period is still known empty). No fetch runs
 * while `period` is null (loading stays true). Cancels on unmount or change.
 *
 * @param {string|null} period Current summary period.
 * @param {number} [refreshKey] Bump to re-read.
 * @returns {{ savings: object|null, loading: boolean, error: string|null, fallback: { period: string, savings: object }|null, neverSaved: boolean }}
 */
export function useSavingsWithFallback(period, refreshKey = 0) {
  const [savings, setSavings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [fallback, setFallback] = useState(null);
  const [neverSaved, setNeverSaved] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey intentionally re-fetches on Retry/settings save.
  useEffect(() => {
    if (!period) {
      setSavings(null);
      setError(null);
      setFallback(null);
      setNeverSaved(false);
      setLoading(true);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setFallback(null);
      setNeverSaved(false);
      try {
        const data = await fetchJson(`/api/usage/savings?period=${period}`);
        if (cancelled) return;
        setSavings(data);
        if (Number(data?.tokensSavedEst) > 0) {
          setLoading(false);
          return;
        }
      } catch (fetchError) {
        if (!cancelled) {
          setSavings(null);
          setError(fetchError.message);
          setLoading(false);
        }
        return;
      }
      let hit = false;
      let failed = false;
      for (const candidate of SUMMARY_PERIODS.slice(SUMMARY_PERIODS.indexOf(period) + 1)) {
        try {
          const candidateSavings = await fetchJson(`/api/usage/savings?period=${candidate}`);
          if (cancelled) return;
          if (Number(candidateSavings?.tokensSavedEst) > 0) {
            setFallback({ period: candidate, savings: candidateSavings });
            hit = true;
            break;
          }
        } catch {
          if (cancelled) return;
          failed = true;
        }
      }
      if (cancelled) return;
      setNeverSaved(!hit && !failed);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [period, refreshKey]);

  return { savings, loading, error, fallback, neverSaved };
}
