"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Card,
  CardSkeleton,
  ErrorState,
  PeriodControl,
  QuietPeriod,
  Tabs,
} from "@/shared/components";
import useLastActivity from "@/shared/hooks/useLastActivity";
import usePeriod from "@/shared/hooks/usePeriod";
import useUsageStats from "./lib/useUsageStats";
import { useChartBuckets } from "./lib/useChartBuckets";
import useProviders from "./lib/useProviders";
import UsageStatsCards from "./components/UsageStatsCards";
import UsageBreakdown from "./components/UsageBreakdown";
import UsageTopology from "./components/UsageTopology";
import RequestLog from "./components/RequestLog";

const UsageTokensChart = dynamic(() => import("./components/UsageTokensChart"), {
  loading: () => <CardSkeleton />,
});

// The "Request log" tab is now RequestLog. Sorting is local state inside
// UsageBreakdown (old ?sortBy= URL sync removed — it fought the tab router).

/**
 * Usage page: header + Tabs (Overview/Request log) + shared period control.
 * `?tab=` accepts overview|logs, plus `details` as an alias of `logs`
 * (old tab name preserved as a contract). The period lives in `?period=` via
 * usePeriod (URL first, remembered default after hydration). A quiet period
 * renders one shared QuietPeriod card in place of stats tiles, chart and
 * breakdown; topology always stays. The live stream only runs on the
 * visible Overview tab (see useUsageStats).
 *
 * @returns {React.ReactElement}
 */
export default function UsagePage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <UsageContent />
    </Suspense>
  );
}

function UsageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { period, setPeriod, options } = usePeriod();
  const tabFromUrl = searchParams.get("tab");
  const activeTab =
    tabFromUrl === "details" || tabFromUrl === "logs"
      ? "logs"
      : tabFromUrl === "overview"
        ? "overview"
        : "overview";
  const { stats, statsPeriod, live, loading, error, retry, catchUpKey } = useUsageStats(period, {
    tab: activeTab,
  });
  const providers = useProviders();
  const quiet =
    Boolean(stats) && statsPeriod === period && !loading && !error && !stats.totalRequests;
  const activity = useLastActivity(quiet);
  // One chart fetch feeds both the tile sparklines and the tokens chart. It
  // stays off until the stats fetch proved the period isn't quiet; catchUpKey
  // re-fetches after a live-stream catch-up without flashing the skeleton.
  const chart = useChartBuckets(
    period,
    activeTab === "overview" && stats !== null && statsPeriod === period && !quiet,
    catchUpKey,
  );

  // Params come from useSearchParams, which already carries ?period= once a
  // period is chosen, so the period survives tab switches.
  const handleTabChange = (value) => {
    if (value === activeTab) return;
    const params = new URLSearchParams(searchParams);
    params.set("tab", value);
    router.push(`/dashboard/usage?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Tabs
            aria-label="Usage view"
            value={activeTab}
            onChange={handleTabChange}
            tabs={[
              { value: "overview", label: "Overview" },
              { value: "logs", label: "Request log" },
            ]}
          />
          {activeTab === "overview" && (
            <PeriodControl
              aria-label="Stats period"
              options={options}
              value={period}
              onChange={setPeriod}
              size="sm"
              className="w-full sm:w-auto"
            />
          )}
        </div>
      </div>

      {activeTab === "overview" ? (
        <div className="flex min-w-0 flex-col gap-6">
          {error && !loading ? (
            <Card>
              <ErrorState
                title="Couldn't load usage stats"
                message={error.message || "Try switching period or reloading the page."}
                onRetry={retry}
              />
            </Card>
          ) : null}
          {quiet ? (
            <Card>
              <QuietPeriod
                period={period}
                lastRequestAt={activity.lastRequestAt}
                loading={activity.loading}
                onSelectPeriod={setPeriod}
                error={activity.error}
                onRetry={activity.retry}
              />
            </Card>
          ) : (
            <>
              <Suspense fallback={<CardSkeleton />}>
                <UsageStatsCards
                  stats={statsPeriod === period ? stats : null}
                  loading={period === null || loading || statsPeriod !== period}
                  previous={statsPeriod === period ? stats?.previous : null}
                  currentTotals={statsPeriod === period ? stats?.currentTotals : null}
                  buckets={chart.bucketsPeriod === period ? chart.buckets : null}
                  period={period ?? ""}
                />
              </Suspense>
              {period ? (
                <UsageTokensChart
                  buckets={chart.buckets}
                  loading={chart.loading || (chart.bucketsPeriod !== period && !chart.error)}
                  error={chart.error}
                  onRetry={chart.retry}
                />
              ) : null}
            </>
          )}
          <UsageTopology
            providers={providers}
            activeRequests={live.activeRequests}
            lastProvider={live.lastProvider}
            errorProvider={live.errorProvider}
          />
          {!quiet &&
            (statsPeriod === period && stats ? <UsageBreakdown stats={stats} /> : <CardSkeleton />)}
        </div>
      ) : (
        <RequestLog />
      )}
    </div>
  );
}
