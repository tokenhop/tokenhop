"use client";

import { useEffect, useMemo, useState } from "react";
import useLastActivity from "@/shared/hooks/useLastActivity";
import useLiveRoutes from "@/shared/hooks/useLiveRoutes";
import usePeriod from "@/shared/hooks/usePeriod";
import { isIdle as routesAreIdle, mergeRoutes } from "@/shared/utils/routesMap";
import { SUMMARY_PERIODS } from "@/shared/utils/period";
import HomeHeader from "./HomeHeader";
import { EndpointHeroCard } from "./EndpointHero";
import { KeysSummaryCard } from "./KeysSummary";
import HomeStats from "./HomeStats";
import { RoutesMapCard } from "@/shared/components/routesMap/RoutesMapCard";
import { RecentRequestsCard } from "./RecentRequests";
import { QuotaWatchCard } from "./QuotaWatch";
import { CombosTopCard, comboUsageFromByEndpoint } from "./CombosTop";
import { ProviderHealthCard } from "./ProviderHealth";
import { onHomeFocus } from "./homeResourceStore";
import {
  useHomeChart,
  useHomeCombos,
  useHomeKeys,
  useHomeProviders,
  useHomeQuota,
  useHomeRecentDetails,
  useHomeSavings,
  useHomeSummary,
  useHomeUsage,
  useHomeWaysIn,
} from "./useHomeData";

/**
 * Home command center: endpoint hero, keys, 4 stat tiles, live routes,
 * recent requests, quota watch, top combos, provider health.
 */
export default function HomePageClient() {
  const { period, setPeriod, options } = usePeriod(SUMMARY_PERIODS);
  const [origin, setOrigin] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin);
  }, []);

  // One focus listener for the whole page: re-reads only data older than
  // STALE_MS, at most once per FOCUS_THROTTLE_MS.
  useEffect(() => {
    const onVisible = () => onHomeFocus();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const bump = () => setRefreshKey((value) => value + 1);

  const usage = useHomeUsage(period, refreshKey);
  const chart = useHomeChart(period, refreshKey);
  const {
    savings,
    loading: savingsLoading,
    savingsUnavailable,
  } = useHomeSavings(period, refreshKey);
  const summary = useHomeSummary(period, refreshKey);
  const keys = useHomeKeys(refreshKey);
  const waysIn = useHomeWaysIn(refreshKey);
  const providers = useHomeProviders(refreshKey);
  const combos = useHomeCombos(refreshKey);
  const quota = useHomeQuota(refreshKey);
  const liveRoutes = useLiveRoutes(refreshKey);
  const recent = useHomeRecentDetails(refreshKey);
  // Idle edges for quiet providers come from mergeRoutes (no traffic in the
  // window still leaves a hub-side edge per connected provider). Memoized so
  // unrelated poll ticks keep the SVG props referentially stable.
  const routesModel = useMemo(
    () =>
      liveRoutes.routes && providers.connections.length > 0
        ? mergeRoutes(liveRoutes.routes, providers.connections)
        : liveRoutes.routes,
    [liveRoutes.routes, providers.connections],
  );

  const summaryCombos =
    summary.summary && Array.isArray(summary.summary.topCombos)
      ? Object.fromEntries(summary.summary.topCombos.map((entry) => [entry.name, entry.requests]))
      : null;
  const usageByCombo =
    summaryCombos ?? (usage.current ? comboUsageFromByEndpoint(usage.current.byEndpoint) : null);

  // Quiet = stats answered for the *selected* period with no requests in it
  // (a period switch keeps the old payload until the refetch lands). Only then
  // is the real last-activity time fetched; its errors render inside the row.
  const quiet =
    Boolean(usage.current) &&
    usage.currentPeriod === period &&
    !usage.loading &&
    !usage.error &&
    !usage.current.totalRequests;
  // One last-activity fetch serves the quiet-period row and the idle map
  // (skipped when there are no providers at all — the true empty state).
  const idle = routesModel && routesModel.providers.length > 0 ? routesAreIdle(routesModel) : false;
  const activity = useLastActivity(quiet || idle);

  return (
    <div className="flex min-w-0 flex-col gap-5 pb-8">
      <HomeHeader
        connections={providers.connections}
        providersLoading={providers.loading}
        period={period}
        options={options}
        onPeriodChange={setPeriod}
      />

      <div className="grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-3">
        <EndpointHeroCard
          origin={origin}
          tunnel={waysIn.tunnel}
          loading={waysIn.loading}
          error={waysIn.error}
          onRetry={bump}
          onChanged={bump}
        />
        <KeysSummaryCard
          keys={keys.keys}
          loading={keys.loading}
          error={keys.error}
          onRetry={bump}
          onChanged={bump}
        />
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <HomeStats
          current={usage.current}
          previousRequests={summary.summary?.previousRequests}
          buckets={chart.buckets}
          savings={savings}
          savingsUnavailable={savingsUnavailable}
          loading={usage.loading || chart.loading || savingsLoading || summary.loading}
          error={usage.error || chart.error}
          onRetry={bump}
          period={period}
          lastRequestAt={activity.lastRequestAt}
          lastActivityLoading={activity.loading}
          lastActivityError={activity.error}
          onRetryLastActivity={activity.retry}
          onSelectPeriod={setPeriod}
        />
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-3">
        <RoutesMapCard
          routes={routesModel}
          loading={liveRoutes.loading}
          error={liveRoutes.error}
          onRetry={bump}
          lastRequestAt={activity.lastRequestAt}
          lastActivityError={activity.error}
          onRetryLastActivity={activity.retry}
          className="lg:col-span-2"
        />
        <RecentRequestsCard
          details={recent.details}
          fallback={usage.current?.recentRequests}
          loading={usage.loading || recent.loading}
          error={usage.error && recent.error ? usage.error : null}
          detailsError={recent.error}
          onRetry={bump}
        />
      </div>

      <div className="grid min-w-0 grid-cols-1 items-start gap-5 md:grid-cols-2 xl:grid-cols-3">
        <QuotaWatchCard
          accounts={quota.accounts}
          loading={quota.loading}
          error={quota.error}
          onRetry={bump}
        />
        <CombosTopCard
          combos={combos.combos}
          strategies={combos.strategies}
          usageByCombo={usageByCombo}
          loading={combos.loading || usage.loading || summary.loading}
          error={combos.error || usage.error || summary.error}
          onRetry={bump}
        />
        <ProviderHealthCard
          connections={providers.connections}
          loading={providers.loading}
          error={providers.error}
          onRetry={bump}
        />
      </div>
    </div>
  );
}
