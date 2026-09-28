"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardSkeleton, EmptyState, SegmentedControl, Tabs } from "@/shared/components";
import useUsageStats from "./lib/useUsageStats";
import useProviders from "./lib/useProviders";
import UsageStatsCards from "./components/UsageStatsCards";
import UsageTokensChart from "./components/UsageTokensChart";
import UsageBreakdown from "./components/UsageBreakdown";
import UsageTopology from "./components/UsageTopology";
import RequestLog from "./components/RequestLog";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
];

// The "Request log" tab is now RequestLog. Sorting is local state inside
// UsageBreakdown (old ?sortBy= URL sync removed — it fought the tab router).

/**
 * Usage page: header + Tabs (Overview/Request log) + period selector.
 * `?tab=` accepts overview|logs, plus `details` as an alias of `logs`
 * (old tab name preserved as a contract).
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
  const [period, setPeriod] = useState("today");
  const { stats, statsPeriod, loading, error } = useUsageStats(period);
  const providers = useProviders();

  const tabFromUrl = searchParams.get("tab");
  const activeTab =
    tabFromUrl === "details" || tabFromUrl === "logs"
      ? "logs"
      : tabFromUrl === "overview"
        ? "overview"
        : "overview";

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
            <SegmentedControl
              aria-label="Stats period"
              options={PERIODS}
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
          <Suspense fallback={<CardSkeleton />}>
            <UsageStatsCards
              stats={statsPeriod === period ? stats : null}
              loading={loading || statsPeriod !== period}
            />
          </Suspense>
          <UsageTokensChart period={period} />
          <UsageTopology
            providers={providers}
            activeRequests={stats?.activeRequests || []}
            lastProvider={stats?.recentRequests?.[0]?.provider || ""}
            errorProvider={stats?.errorProvider || ""}
          />
          <UsageBreakdown stats={stats} />
        </div>
      ) : (
        <RequestLog />
      )}
    </div>
  );
}
