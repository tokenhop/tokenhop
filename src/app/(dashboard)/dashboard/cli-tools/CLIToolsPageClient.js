"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CardSkeleton, EmptyState, SegmentedControl, ToolbarSearch } from "@/shared/components";
import { CLI_TOOLS, MITM_TOOLS } from "@/shared/constants/cliTools";
import { markLocalOnly, useCliAccessStore } from "@/store/cliAccessStore";
import { isLocalOnlyResponse } from "@/shared/utils/localOnly";
import { useToolSetupData } from "./hooks/useToolSetupData";
import { countToolsByFilter, deriveToolStatus, filterToolEntries } from "./lib/toolStatus";
import ToolGridCard from "./components/ToolGridCard";
import InterceptTools from "./components/InterceptTools";
import ToolSetupPanel from "./components/ToolSetupPanel";
import LocalOnlyNotice from "./components/LocalOnlyNotice";

const FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "connected", label: "Connected" },
  { value: "needsSetup", label: "Needs setup" },
  { value: "guides", label: "Guides" },
];

/**
 * Signal CLI-tools list: filter segmented control with counts, search,
 * 3-column tool grid, Intercept-tools section, and the inline setup panel
 * on wide screens (selected tool beside the grid).
 */
export default function CLIToolsPageClient({ initialTool = "claude" }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [statuses, setStatuses] = useState({});
  const [statusesLoading, setStatusesLoading] = useState(true);
  const [statusesError, setStatusesError] = useState(false);
  const [selected, setSelected] = useState(initialTool);
  const data = useToolSetupData();
  const localOnly = useCliAccessStore((s) => s.localOnly);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch("/api/cli-tools/all-statuses");
        if (await isLocalOnlyResponse(res)) return markLocalOnly();
        if (!res.ok) throw new Error(`status ${res.status}`);
        const payload = await res.json();
        if (mounted) {
          setStatuses(payload || {});
          setStatusesError(false);
        }
      } catch {
        if (mounted) {
          setStatuses({});
          setStatusesError(true);
        }
      } finally {
        if (mounted) setStatusesLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const entries = useMemo(() => Object.entries(CLI_TOOLS), []);
  const counts = useMemo(() => countToolsByFilter(entries, statuses), [entries, statuses]);
  const visible = useMemo(
    () => filterToolEntries(entries, statuses, filter, query),
    [entries, statuses, filter, query],
  );

  const filterOptions = FILTER_OPTIONS.map((o) => ({
    ...o,
    count:
      o.value === "all"
        ? counts.all
        : o.value === "connected"
          ? counts.connected
          : o.value === "needsSetup"
            ? counts.needsSetup
            : counts.guides,
  }));

  const handleSelect = (toolId) => {
    setSelected(toolId);
    router.replace(`/dashboard/cli-tools?tool=${toolId}`, { scroll: false });
  };

  // Stable status callback: pages re-render on every status update, so an
  // inline arrow here would change identity each render and retrigger the
  // per-card status effects (the claude-settings request loop). setStatuses
  // is a stable updater, so a useCallback wrapper never changes.
  const handleStatusUpdate = useCallback(
    (id, next) => setStatuses((prev) => ({ ...prev, [id]: next })),
    [],
  );

  // Over a reverse proxy every /api/cli-tools/* call is refused, so one
  // notice replaces the grid, intercept section and panel.
  if (localOnly) return <LocalOnlyNotice />;

  return (
    <Suspense fallback={<CardSkeleton />}>
      <CLIToolsView
        filter={filter}
        setFilter={setFilter}
        filterOptions={filterOptions}
        query={query}
        setQuery={setQuery}
        statusesError={statusesError}
        statusesLoading={statusesLoading}
        visible={visible}
        statuses={statuses}
        selectedTool={CLI_TOOLS[selected] ? selected : null}
        onSelect={handleSelect}
        onStatusUpdate={handleStatusUpdate}
        data={data}
      />
    </Suspense>
  );
}

function CLIToolsView({
  filter,
  setFilter,
  filterOptions,
  query,
  setQuery,
  statusesError,
  statusesLoading,
  visible,
  statuses,
  selectedTool,
  onSelect,
  onStatusUpdate,
  data,
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          options={filterOptions}
          value={filter}
          onChange={setFilter}
          aria-label="Filter tools"
          size="sm"
        />
        <ToolbarSearch
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter tools"
          ariaLabel="Filter tools"
          className="ms-auto w-full sm:w-[220px]"
        />
        {statusesError && (
          <p className="text-xs text-warn" role="status">
            Detection unavailable — showing install state only.
          </p>
        )}
        {data.hasActiveProviders === false && data.loading === false && (
          <p className="text-xs text-muted">
            No active providers yet — Apply stays disabled until a provider connects.
          </p>
        )}
      </div>

      <div className="flex items-start gap-6">
        <div className="flex min-w-0 flex-1 flex-col gap-5">
          {statusesLoading ? (
            <div
              className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
              role="status"
              aria-label="Loading tools"
            >
              <CardSkeleton />
              <CardSkeleton />
              <CardSkeleton />
              <CardSkeleton />
              <CardSkeleton />
              <CardSkeleton />
            </div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon="search_off"
              title="No tools match"
              body="Try a different filter or search term."
            />
          ) : (
            <ul
              className="grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 xl:grid-cols-3"
              aria-label="CLI tools"
            >
              {visible.map(([toolId, tool]) => (
                <li key={toolId}>
                  <ToolGridCard
                    toolId={toolId}
                    tool={tool}
                    status={statuses[toolId]}
                    selected={selectedTool === toolId}
                    onSelect={onSelect}
                  />
                </li>
              ))}
            </ul>
          )}

          <InterceptTools tools={Object.entries(MITM_TOOLS)} />
        </div>

        {selectedTool && (
          <div className="hidden w-[440px] shrink-0 xl:block">
            <div className="sticky top-4 max-h-[calc(100vh-6rem)] overflow-y-auto">
              <ToolSetupPanel toolId={selectedTool} data={data} onStatusUpdate={onStatusUpdate} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Re-export for tests that import the derivation from the page module.
export { deriveToolStatus };
