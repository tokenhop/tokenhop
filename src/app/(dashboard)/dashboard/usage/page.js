"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Card,
  CardSkeleton,
  EmptyState,
  PeriodControl,
  QuietPeriod,
  Tabs,
} from "@/shared/components";
import useLastActivity from "@/shared/hooks/useLastActivity";
import usePeriod from "@/shared/hooks/usePeriod";
import useUsageStats from "./lib/useUsageStats";
import useProviders from "./lib/useProviders";
import UsageStatsCards from "./components/UsageStatsCards";
import UsageTokensChart from "./components/UsageTokensChart";
import UsageBreakdown from "./components/UsageBreakdown";
import UsageTopology from "./components/UsageTopology";
import RequestLog from "./components/RequestLog";

// The "Request log" tab is now RequestLog. Sorting is local state inside
// UsageBreakdown (old ?sortBy= URL sync removed — it fought the tab router).

/**
 * Usage page: header + Tabs (Overview/Request log) + shared period control.
 * `?tab=` accepts overview|logs, plus `details` as an alias of `logs`
 * (old tab name preserved as a contract). The period lives in `?period=` via
 * usePeriod (URL first, remembered default after hydration). A quiet period
 * renders one shared QuietPeriod card in place of stats tiles, chart and
 * breakdown; topology always stays.
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
  const { stats, statsPeriod, loading, error } = useUsageStats(period);
  const providers = useProviders();
  const quiet =
    Boolean(stats) && statsPeriod === period && !loading && !error && !stats.totalRequests;
  const activity = useLastActivity(quiet);

  const tabFromUrl = searchParams.get("tab");
  const activeTab =
    tabFromUrl === "details" || tabFromUrl === "logs"
      ? "logs"
      : tabFromUrl === "overview"
        ? "overview"
        : "overview";

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
              <EmptyState
                icon="error"
                title="Couldn't load usage stats"
                body={error.message || "Try switching period or reloading the page."}
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
              />
            </Card>
          ) : (
            <>
              <Suspense fallback={<CardSkeleton />}>
                <UsageStatsCards
                  stats={statsPeriod === period ? stats : null}
                  loading={period === null || loading || statsPeriod !== period}
                />
              </Suspense>
              {period ? <UsageTokensChart period={period} /> : null}
            </>
          )}
          <UsageTopology
            providers={providers}
            activeRequests={stats?.activeRequests || []}
            lastProvider={stats?.recentRequests?.[0]?.provider || ""}
            errorProvider={stats?.errorProvider || ""}
          />
          {!quiet && (stats ? <UsageBreakdown stats={stats} /> : <CardSkeleton />)}
        </div>
      ) : (
        <RequestLog />
      )}
    </div>
  );
}
