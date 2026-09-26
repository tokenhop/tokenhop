"use client";

import { useCallback, useEffect, useState } from "react";
import Card from "@/shared/components/Card";
import ProviderTile from "@/shared/components/ProviderTile";
import Button from "@/shared/components/Button";
import StatusPill from "@/shared/components/StatusPill";
import EmptyState from "@/shared/components/EmptyState";
import Pagination from "@/shared/components/Pagination";
import RequestDetailDrawer from "./RequestDetailDrawer";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers";

const getCached = (t) => t?.cached_tokens || t?.cache_read_input_tokens || 0;
const getInput = (t) => {
  const prompt = t?.prompt_tokens || t?.input_tokens || 0;
  const cache = getCached(t);
  return prompt < cache ? cache : prompt;
};

function providerLabel(id, cache) {
  if (!id) return "—";
  if (cache && typeof cache[id] === "string") return cache[id];
  if (cache?.[id]?.name) return cache[id].name;
  return getProviderByAlias(id)?.name || AI_PROVIDERS[id]?.name || id;
}

/**
 * Request log: same /api/usage/request-details + /api/usage/providers
 * fetch/filter/pagination logic as the old RequestDetailsTab, restyled with
 * Signal Card, semantic table, StatusPill status and Pagination. Row action
 * opens RequestDetailDrawer.
 */
export default function RequestLog() {
  const [details, setDetails] = useState([]);
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: 20,
    totalItems: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [providers, setProviders] = useState([]);
  const [nameCache, setNameCache] = useState(null);
  const [filters, setFilters] = useState({ provider: "", startDate: "", endDate: "" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/usage/providers");
        const data = await res.json();
        if (!cancelled) setProviders(data.providers || []);
        const nodesRes = await fetch("/api/provider-nodes");
        const nodesData = await nodesRes.json();
        if (cancelled) return;
        const nodeNames = {};
        for (const node of nodesData.nodes || []) nodeNames[node.id] = node.name;
        setNameCache({ ...AI_PROVIDERS, ...nodeNames });
      } catch (e) {
        console.error("Failed to fetch providers:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchDetails = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(pagination.page),
        pageSize: String(pagination.pageSize),
      });
      if (filters.provider) params.append("provider", filters.provider);
      if (filters.startDate) params.append("startDate", filters.startDate);
      if (filters.endDate) params.append("endDate", filters.endDate);
      const res = await fetch(`/api/usage/request-details?${params}`);
      const data = await res.json();
      setDetails(data.details || []);
      setPagination((prev) => ({ ...prev, ...data.pagination }));
    } catch (e) {
      console.error("Failed to fetch request details:", e);
    } finally {
      setLoading(false);
    }
  }, [pagination.page, pagination.pageSize, filters]);

  useEffect(() => {
    fetchDetails();
  }, [fetchDetails]);

  const ok = (d) => !d.status || d.status === "ok" || d.status === "success";

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="provider-filter" className="text-sm font-medium">
              Provider
            </label>
            <select
              id="provider-filter"
              value={filters.provider}
              onChange={(e) => setFilters({ ...filters, provider: e.target.value })}
              className="h-11 w-full min-w-0 cursor-pointer rounded-lg border border-line bg-raised px-3 text-sm focus:outline-none"
            >
              <option value="">All Providers</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.name !== p.id ? ` (${p.id.slice(0, 18)}…)` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="start-date-filter" className="text-sm font-medium">
              Start Date
            </label>
            <input
              id="start-date-filter"
              type="datetime-local"
              value={filters.startDate}
              onChange={(e) => setFilters({ ...filters, startDate: e.target.value })}
              className="h-11 w-full min-w-0 rounded-lg border border-line bg-raised px-3 text-sm focus:outline-none"
            />
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="end-date-filter" className="text-sm font-medium">
              End Date
            </label>
            <input
              id="end-date-filter"
              type="datetime-local"
              value={filters.endDate}
              onChange={(e) => setFilters({ ...filters, endDate: e.target.value })}
              className="h-11 w-full min-w-0 rounded-lg border border-line bg-raised px-3 text-sm focus:outline-none"
            />
          </div>
          <div className="flex min-w-0 flex-col justify-end">
            <Button
              variant="ghost"
              onClick={() => setFilters({ provider: "", startDate: "", endDate: "" })}
              disabled={!filters.provider && !filters.startDate && !filters.endDate}
            >
              Clear Filters
            </Button>
          </div>
        </div>
      </Card>

      <Card padding="none">
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted">
            <span className="material-symbols-outlined animate-spin text-[20px]" aria-hidden="true">
              progress_activity
            </span>
            Loading…
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
                  <tr className="border-b border-line text-left">
                    <th scope="col" className="p-4 font-semibold">
                      Timestamp
                    </th>
                    <th scope="col" className="p-4 font-semibold">
                      Model
                    </th>
                    <th scope="col" className="p-4 font-semibold">
                      Provider
                    </th>
                    <th scope="col" className="p-4 text-right font-semibold">
                      Input
                    </th>
                    <th scope="col" className="p-4 text-right font-semibold">
                      Cached
                    </th>
                    <th scope="col" className="p-4 text-right font-semibold">
                      Output
                    </th>
                    <th scope="col" className="p-4 font-semibold">
                      Latency
                    </th>
                    <th scope="col" className="p-4 font-semibold">
                      Status
                    </th>
                    <th scope="col" className="p-4 text-center font-semibold">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {details.map((d) => (
                    <tr
                      key={`${d.id}|${d.timestamp}`}
                      className="border-b border-line transition-colors last:border-b-0 hover:bg-raised"
                    >
                      <td className="whitespace-nowrap p-4">
                        {d.timestamp ? new Date(d.timestamp).toLocaleString() : "—"}
                      </td>
                      <td className="max-w-[260px] truncate p-4 font-mono">{d.model}</td>
                      <td className="max-w-[180px] p-4">
                        <span className="flex min-w-0 items-center gap-2">
                          {d.provider && <ProviderTile providerId={d.provider} size="sm" />}
                          <span className="truncate">{providerLabel(d.provider, nameCache)}</span>
                        </span>
                      </td>
                      <td className="p-4 text-right font-mono">
                        {getInput(d.tokens).toLocaleString()}
                      </td>
                      <td className="p-4 text-right font-mono">
                        {getCached(d.tokens) > 0 ? getCached(d.tokens).toLocaleString() : "—"}
                      </td>
                      <td className="p-4 text-right font-mono">
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
                          onClick={() => {
                            setSelected(d);
                            setDrawerOpen(true);
                          }}
                        >
                          Detail
                        </Button>
                      </td>
                    </tr>
                  ))}
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
