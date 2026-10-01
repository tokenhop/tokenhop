"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Card from "@/shared/components/Card";
import ProviderTile from "@/shared/components/ProviderTile";
import Button from "@/shared/components/Button";
import Select from "@/shared/components/Select";
import Input from "@/shared/components/Input";
import StatusPill from "@/shared/components/StatusPill";
import { EmptyState, ErrorState, LoadingState } from "@/shared/components/StateViews";
import { TABLE_HEAD_CELL, TABLE_HEAD_ROW } from "@/shared/components/displayPrimitives";
import Pagination from "@/shared/components/Pagination";
import RequestDetailDrawer, { providerLabel } from "./RequestDetailDrawer";
import { AI_PROVIDERS } from "@/shared/constants/providers";

const getCached = (t) => t?.cached_tokens || t?.cache_read_input_tokens || 0;
const getInput = (t) => {
  const prompt = t?.prompt_tokens || t?.input_tokens || 0;
  const cache = getCached(t);
  return prompt < cache ? cache : prompt;
};

/**
 * Stable DOM id for one request row: the Details button points
 * `aria-describedby` at the row's model and timestamp cells. Request ids can
 * contain characters that are hostile to CSS id selectors, so runs of
 * disallowed characters collapse to a single dash. The row index is suffixed
 * so duplicate request ids still yield unique DOM ids.
 */
const rowDomId = (id, index) => `req-${String(id).replace(/[^A-Za-z0-9_-]+/g, "-")}-${index}`;

/**
 * Request log: paginated /api/usage/request-details table built on the shared
 * primitives — Select/Input filters (provider + a From/To datetime range with
 * a client-side start ≤ end check), LoadingState/ErrorState/EmptyState and
 * one TABLE_HEAD header style with logical alignment. Each row's Detail
 * button is described by that row's model and timestamp cells, so screen
 * readers announce which request it opens without a composed sentence.
 * Filter changes reset the page to 1; fetches are sequenced with an
 * AbortController so a stale response never overwrites a newer one.
 */
export default function RequestLog() {
  const [details, setDetails] = useState([]);
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: 20,
    totalItems: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestRef = useRef(null);
  const [selected, setSelected] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [providers, setProviders] = useState([]);
  const [nameCache, setNameCache] = useState(null);
  const [filters, setFilters] = useState({ provider: "", startDate: "", endDate: "" });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/usage/providers", { signal: controller.signal });
        const data = await res.json();
        if (!cancelled) setProviders(data.providers || []);
        const nodesRes = await fetch("/api/provider-nodes", { signal: controller.signal });
        const nodesData = await nodesRes.json();
        if (cancelled) return;
        const nodeNames = {};
        for (const node of nodesData.nodes || []) nodeNames[node.id] = node.name;
        setNameCache({ ...AI_PROVIDERS, ...nodeNames });
      } catch (e) {
        if (e?.name === "AbortError") return;
        // Non-fatal: without this list the table still renders raw provider
        // ids, so the log keeps working.
        console.error("Failed to fetch providers:", e);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  // datetime-local values sort lexicographically like their instants.
  const dateRangeError =
    filters.startDate && filters.endDate && filters.startDate > filters.endDate
      ? "Start must be before end"
      : "";

  const fetchDetails = useCallback(async () => {
    requestRef.current?.abort();
    const request = new AbortController();
    requestRef.current = request;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(pagination.page),
        pageSize: String(pagination.pageSize),
      });
      if (filters.provider) params.append("provider", filters.provider);
      // datetime-local has no offset: resolve it in the browser's timezone so
      // the server (often UTC in Docker) filters the window the table shows.
      if (filters.startDate) params.append("startDate", new Date(filters.startDate).toISOString());
      if (filters.endDate) params.append("endDate", new Date(filters.endDate).toISOString());
      const res = await fetch(`/api/usage/request-details?${params}`, {
        signal: request.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setDetails(data.details || []);
      setPagination((prev) => ({ ...prev, ...data.pagination }));
      setError("");
    } catch (e) {
      // A superseded or unmounted request must not overwrite a newer one.
      if (request.signal.aborted) return;
      console.error("Failed to fetch request details:", e);
      setError(e instanceof Error && e.message ? e.message : "Unknown error");
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }, [pagination.page, pagination.pageSize, filters]);

  useEffect(() => {
    // An invalid range keeps the current data instead of querying a window
    // the API cannot satisfy; fixing the dates refetches. Abort any
    // in-flight request so it cannot overwrite the kept data — its finally
    // skips setLoading(false) on abort, so clear it here (idempotent).
    if (dateRangeError) {
      requestRef.current?.abort();
      setLoading(false);
      return;
    }
    fetchDetails();
  }, [fetchDetails, dateRangeError]);

  useEffect(
    () => () => {
      requestRef.current?.abort();
    },
    [],
  );

  /** Any filter edit restarts from page 1 (an old page may not exist). */
  const updateFilter = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPagination((prev) => (prev.page === 1 ? prev : { ...prev, page: 1 }));
  };

  const clearFilters = () => {
    setFilters({ provider: "", startDate: "", endDate: "" });
    setPagination((prev) => (prev.page === 1 ? prev : { ...prev, page: 1 }));
  };

  const ok = (d) => !d.status || d.status === "ok" || d.status === "success";

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card>
        <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-end">
          <Select
            id="provider-filter"
            label="Provider"
            // A real "All providers" option with value "" must stay
            // selectable, so Select's disabled placeholder is omitted.
            placeholder={null}
            options={[
              { value: "", label: "All providers" },
              ...providers.map((p) => ({
                value: p.id,
                // Ids stay visible when the display name differs (data, not copy).
                label: p.name !== p.id ? `${p.name} (${p.id.slice(0, 18)}…)` : p.name,
              })),
            ]}
            value={filters.provider}
            onChange={(e) => updateFilter("provider", e.target.value)}
            className="min-w-0 lg:w-60"
          />
          <fieldset className="min-w-0 flex-1">
            <legend className="text-sm font-medium">Date range</legend>
            <div className="mt-1.5 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
              <Input
                id="start-date-filter"
                type="datetime-local"
                label="From"
                value={filters.startDate}
                onChange={(e) => updateFilter("startDate", e.target.value)}
              />
              <Input
                id="end-date-filter"
                type="datetime-local"
                label="To"
                error={dateRangeError}
                value={filters.endDate}
                onChange={(e) => updateFilter("endDate", e.target.value)}
              />
            </div>
          </fieldset>
          <Button
            variant="ghost"
            onClick={clearFilters}
            disabled={!filters.provider && !filters.startDate && !filters.endDate}
          >
            Clear filters
          </Button>
        </div>
      </Card>

      <Card padding="none">
        {loading ? (
          <LoadingState label="Loading requests" lines={5} className="p-6" />
        ) : error ? (
          <div className="p-6">
            <ErrorState title="Couldn't load requests" message={error} onRetry={fetchDetails} />
          </div>
        ) : details.length === 0 ? (
          <EmptyState
            icon="receipt_long"
            title="No request details found"
            body="Adjust the filters or make a request through the gateway."
          />
        ) : (
          <>
            <section
              className="overflow-x-auto focus-visible:shadow-focus"
              aria-label="Request log"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable table region is keyboard-focusable with a label (WCAG 2.1.1, YAN-314).
              tabIndex={0}
            >
              <table className="w-full min-w-[880px] text-sm">
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th scope="col" className={`${TABLE_HEAD_CELL} p-4 text-start`}>
                      Timestamp
                    </th>
                    <th scope="col" className={`${TABLE_HEAD_CELL} p-4 text-start`}>
                      Model
                    </th>
                    <th scope="col" className={`${TABLE_HEAD_CELL} p-4 text-start`}>
                      Provider
                    </th>
                    <th scope="col" className={`${TABLE_HEAD_CELL} p-4 text-end`}>
                      Input
                    </th>
                    <th scope="col" className={`${TABLE_HEAD_CELL} p-4 text-end`}>
                      Cached
                    </th>
                    <th scope="col" className={`${TABLE_HEAD_CELL} p-4 text-end`}>
                      Output
                    </th>
                    <th scope="col" className={`${TABLE_HEAD_CELL} p-4 text-start`}>
                      Latency
                    </th>
                    <th scope="col" className={`${TABLE_HEAD_CELL} p-4 text-start`}>
                      Status
                    </th>
                    <th scope="col" className={`${TABLE_HEAD_CELL} p-4 text-start`}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {details.map((d, index) => {
                    const rowId = rowDomId(d.id, index);
                    return (
                      <tr
                        key={`${d.id}|${d.timestamp}`}
                        className="border-b border-line transition-colors last:border-b-0 hover:bg-raised"
                      >
                        <td id={`${rowId}-time`} className="whitespace-nowrap p-4">
                          {d.timestamp ? new Date(d.timestamp).toLocaleString() : "—"}
                        </td>
                        <td id={`${rowId}-model`} className="max-w-[260px] truncate p-4 font-mono">
                          {d.model}
                        </td>
                        <td className="max-w-[180px] p-4">
                          <span className="flex min-w-0 items-center gap-2">
                            {d.provider && <ProviderTile providerId={d.provider} size="sm" />}
                            <span className="truncate">{providerLabel(d.provider, nameCache)}</span>
                          </span>
                        </td>
                        <td className="p-4 text-end font-mono">
                          {getInput(d.tokens).toLocaleString()}
                        </td>
                        <td className="p-4 text-end font-mono">
                          {getCached(d.tokens) > 0 ? getCached(d.tokens).toLocaleString() : "—"}
                        </td>
                        <td className="p-4 text-end font-mono">
                          {(
                            d.tokens?.completion_tokens ??
                            d.tokens?.output_tokens ??
                            0
                          ).toLocaleString()}
                        </td>
                        <td className="whitespace-nowrap p-4 font-mono text-muted">
                          {d.latency?.total ?? 0}ms
                        </td>
                        <td className="p-4">
                          <StatusPill variant={ok(d) ? "ok" : "err"} size="sm">
                            {d.status || "ok"}
                          </StatusPill>
                        </td>
                        <td className="p-4 text-center">
                          <Button
                            variant="outline"
                            size="sm"
                            aria-describedby={`${rowId}-model ${rowId}-time`}
                            onClick={() => {
                              setSelected(d);
                              setDrawerOpen(true);
                            }}
                          >
                            Detail
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
            <div className="border-t border-line">
              <Pagination
                currentPage={pagination.page}
                pageSize={pagination.pageSize}
                totalItems={pagination.totalItems}
                onPageChange={(p) => setPagination((prev) => ({ ...prev, page: p }))}
                onPageSizeChange={(s) =>
                  setPagination((prev) => ({ ...prev, pageSize: s, page: 1 }))
                }
              />
            </div>
          </>
        )}
      </Card>

      <RequestDetailDrawer
        detail={selected}
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        providerName={selected ? providerLabel(selected.provider, nameCache) : null}
      />
    </div>
  );
}
