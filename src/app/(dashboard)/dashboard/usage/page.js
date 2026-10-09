"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
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
import { RoutesMapCard } from "@/shared/components/routesMap/RoutesMapCard";
import useLastActivity from "@/shared/hooks/useLastActivity";
import useLiveRoutes from "@/shared/hooks/useLiveRoutes";
import usePeriod from "@/shared/hooks/usePeriod";
import { useAuthStatusState } from "@/shared/hooks/useAuthStatus";
import { accountView } from "@/shared/utils/account";
import {
  isIdle as routesAreIdle,
  mergeRoutes,
  overlayLiveSignal,
  updateActiveSince,
} from "@/shared/utils/routesMap";
import useUsageStats from "./lib/useUsageStats";
import { useChartBuckets } from "./lib/useChartBuckets";
import useProviders from "./lib/useProviders";
import UsageStatsCards from "./components/UsageStatsCards";
import UsageBreakdown from "./components/UsageBreakdown";
import RequestLog from "./components/RequestLog";
import BudgetsTab from "./components/BudgetsTab";
import UsageFilters from "./components/UsageFilters";

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
  const { status, loaded } = useAuthStatusState();
  const view = useMemo(() => accountView(status), [status]);
  const workspaceId = view.active ? (view.activeWorkspace?.id ?? null) : null;
  // Workspace-wide usage scope (YAN-376): instance owner/admin, or owner/
  // manager of the active workspace. Everyone else stays scoped to "me" with
  // no scope selector at all.
  const instanceRole = status?.principal?.role;
  const canViewWorkspace = Boolean(
    view.active &&
      (instanceRole === "owner" ||
        instanceRole === "admin" ||
        view.activeWorkspace?.role === "owner" ||
        view.activeWorkspace?.role === "manager"),
  );
  const canManage = Boolean(
    view.active &&
      workspaceId &&
      (view.can("workspace.budgets.lower", workspaceId) || view.can("instance.budgets.raise")),
  );
  const tabFromUrl = searchParams.get("tab");
  const activeTab =
    tabFromUrl === "details" || tabFromUrl === "logs"
      ? "logs"
      : tabFromUrl === "budgets" && view.active
        ? "budgets"
        : tabFromUrl === "overview"
          ? "overview"
          : "overview";
  const selectedView = canViewWorkspace && searchParams.get("view") !== "me" ? "workspace" : "me";
  const usageFilters = useMemo(
    () =>
      view.active
        ? {
            workspaceId,
            view: selectedView,
            userId: selectedView === "workspace" ? searchParams.get("userId") || "" : "",
            apiKeyId: searchParams.get("apiKeyId") || "",
          }
        : null,
    [view.active, workspaceId, selectedView, searchParams],
  );
  const updateUsageFilters = (patch) => {
    const params = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    router.replace(`/dashboard/usage?${params}`, { scroll: false });
  };
  const { stats, statsPeriod, live, loading, error, retry, catchUpKey } = useUsageStats(
    loaded ? period : null,
    { tab: activeTab },
    usageFilters,
  );
  const providers = useProviders();
  // Shared live-routes map (YAN-412): the window model from Home plus the
  // connected-provider universe, with in-flight SSE frames layered on top.
  // The merge stays null until the window model lands so loading and error
  // states render instead of a false "no providers" map.
  const [routesRetryKey, setRoutesRetryKey] = useState(0);
  const liveRoutes = useLiveRoutes(routesRetryKey);
  // Stale-active guard: first-seen per in-flight provider; a 1s tick runs only
  // while something is in flight so a stuck provider stops lighting the map.
  const activeSinceRef = useRef(new Map());
  const [overlayTick, setOverlayTick] = useState(0);
  const liveBusy = live.activeRequests.length > 0;
  useEffect(() => {
    if (!liveBusy) return undefined;
    const id = setInterval(() => setOverlayTick((tick) => tick + 1), 1_000);
    return () => clearInterval(id);
  }, [liveBusy]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: overlayTick re-checks the stale guard once per second while traffic is in flight.
  const routesModel = useMemo(() => {
    if (!liveRoutes.routes) return null;
    activeSinceRef.current = updateActiveSince(live.activeRequests, activeSinceRef.current);
    return overlayLiveSignal(
      mergeRoutes(liveRoutes.routes, providers),
      live,
      activeSinceRef.current,
    );
  }, [liveRoutes.routes, providers, live, overlayTick]);
  const routesIdle =
    routesModel && routesModel.providers.length > 0 ? routesAreIdle(routesModel) : false;
  const quiet =
    Boolean(stats) && statsPeriod === period && !loading && !error && !stats.totalRequests;
  const activity = useLastActivity(quiet || routesIdle);
  // One chart fetch feeds both the tile sparklines and the tokens chart. It
  // stays off until the stats fetch proved the period isn't quiet; catchUpKey
  // re-fetches after a live-stream catch-up without flashing the skeleton.
  const chart = useChartBuckets(
    period,
    activeTab === "overview" && stats !== null && statsPeriod === period && !quiet,
    catchUpKey,
    usageFilters,
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
              ...(view.active ? [{ value: "budgets", label: "Budgets" }] : []),
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

      {view.active && activeTab !== "budgets" && (
        <UsageFilters
          workspaceId={workspaceId}
          canViewWorkspace={canViewWorkspace}
          filters={usageFilters}
          onChange={updateUsageFilters}
        />
      )}
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
          <RoutesMapCard
            variant="full"
            routes={routesModel}
            loading={liveRoutes.loading}
            error={liveRoutes.error}
            onRetry={() => setRoutesRetryKey((value) => value + 1)}
            lastRequestAt={activity.lastRequestAt}
            lastActivityError={activity.error}
            onRetryLastActivity={activity.retry}
          />
          {!quiet &&
            (statsPeriod === period && stats ? <UsageBreakdown stats={stats} /> : <CardSkeleton />)}
        </div>
      ) : activeTab === "budgets" ? (
        <BudgetsTab workspaceId={workspaceId} canManage={canManage} />
      ) : (
        <RequestLog usageFilters={usageFilters} />
      )}
    </div>
  );
}
