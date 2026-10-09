"use client";

// YAN-376: audit log page (single-file). Reads GET /api/audit (already
// redacted at write; no credential or request-body lookup here). Managers see
// their active workspace; instance owner/admin reads the same endpoint.
// Hidden while auth is loading or the switch is off: no fetch until
// accountView is active AND the viewer holds an audit read capability.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Card,
  Drawer,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  PageTitle,
  StatusPill,
} from "@/shared/components";
import { TABLE_HEAD_CELL, TABLE_HEAD_ROW } from "@/shared/components/displayPrimitives";
// Not re-exported by the barrel: a barrel import is `undefined` (React #130).
import Pagination from "@/shared/components/Pagination";
import { useAuthStatusState } from "@/shared/hooks/useAuthStatus";
import { accountView } from "@/shared/utils/account";

const EMPTY_FILTERS = { action: "", actorUserId: "", targetType: "", from: "", to: "" };

/** Pretty JSON for a stored snapshot string; falls back to the raw string. */
function prettySnapshot(value) {
  if (value == null || value === "") return null;
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return String(value);
  }
}

const formatTime = (ts) => {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? String(ts ?? "") : date.toLocaleString();
};

const detailLabel = (row) =>
  `Audit event ${row?.action ? row.action : ""} ${row?.ts ? formatTime(row.ts) : ""}`.trim();

/**
 * Audit log: filterable table (page/pageSize/action prefix/actor/target type/
 * from/to) over GET /api/audit, with a per-row details Drawer showing the
 * redacted before/after JSON (dir="ltr" so JSON keys stay readable in RTL).
 */
export default function AuditPage() {
  const { status, loaded } = useAuthStatusState();
  const view = useMemo(() => accountView(status), [status]);
  const workspaceId = view.active ? (view.activeWorkspace?.id ?? null) : null;
  const authorized = Boolean(
    view.active &&
      workspaceId &&
      (view.can("instance.audit.read") || view.can("workspace.audit.read")),
  );

  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [applied, setApplied] = useState(EMPTY_FILTERS); // debounced copy
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, totalItems: 0 });
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null); // { status, message }
  const [retryTick, setRetryTick] = useState(0);
  const [selected, setSelected] = useState(null);
  const requestRef = useRef(null);

  // Text/date filters are debounced so typing doesn't fire a query per key.
  useEffect(() => {
    const timer = setTimeout(() => setApplied(filters), 300);
    return () => clearTimeout(timer);
  }, [filters]);

  const rangeError =
    applied.from && applied.to && new Date(applied.from) > new Date(applied.to)
      ? "From must be before to"
      : "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryTick forces a refetch
  useEffect(() => {
    if (!authorized || rangeError) return undefined;
    requestRef.current?.abort();
    const request = new AbortController();
    requestRef.current = request;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          page: String(pagination.page),
          pageSize: String(pagination.pageSize),
          workspaceId,
        });
        if (applied.action) params.set("action", applied.action.trim());
        if (applied.actorUserId) params.set("actorUserId", applied.actorUserId.trim());
        if (applied.targetType) params.set("targetType", applied.targetType.trim());
        // datetime-local has no offset: resolve in the browser timezone.
        if (applied.from) params.set("from", new Date(applied.from).toISOString());
        if (applied.to) params.set("to", new Date(applied.to).toISOString());
        const res = await fetch(`/api/audit?${params}`, { signal: request.signal });
        if (!res.ok) {
          throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
        }
        const data = await res.json();
        if (request.signal.aborted) return;
        setEvents(Array.isArray(data.events) ? data.events : []);
        setPagination((prev) => ({ ...prev, ...data.pagination }));
        setError(null);
      } catch (e) {
        if (request.signal.aborted) return;
        const status = e?.status || 0;
        setError({
          status,
          message:
            status === 403
              ? "You do not have access to the audit log."
              : status === 404
                ? "The audit log is not available on this instance."
                : "Failed to fetch audit log.",
        });
      } finally {
        if (!request.signal.aborted && !cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      request.abort();
    };
  }, [
    authorized,
    workspaceId,
    pagination.page,
    pagination.pageSize,
    applied,
    rangeError,
    retryTick,
  ]);

  useEffect(() => () => requestRef.current?.abort(), []);

  /** Any filter edit restarts from page 1 (an old page may not exist). */
  const updateFilter = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPagination((prev) => (prev.page === 1 ? prev : { ...prev, page: 1 }));
  };
  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
    setPagination((prev) => (prev.page === 1 ? prev : { ...prev, page: 1 }));
  };
  const hasFilters = Object.values(applied).some(Boolean);

  if (!loaded) {
    return (
      <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
        <PageTitle>Audit log</PageTitle>
        <LoadingState label="Loading audit log" lines={6} />
      </div>
    );
  }

  if (!authorized) {
    return (
      <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
        <PageTitle>Audit log</PageTitle>
        <EmptyState icon="lock" title="No access">
          The audit log is available to workspace managers and instance admins.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <div className="flex flex-col gap-2">
        <PageTitle>Audit log</PageTitle>
        <p className="max-w-2xl text-sm text-muted">
          Security and administrative events for{" "}
          <span className="font-medium text-text">
            {view.activeWorkspace?.name ?? "this workspace"}
          </span>
          . Snapshots are redacted before they are stored.
        </p>
      </div>

      <Card>
        <fieldset
          className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5"
          aria-label="Audit log filters"
        >
          <Input
            label="Action prefix"
            placeholder="e.g. user."
            value={filters.action}
            onChange={(e) => updateFilter("action", e.target.value)}
          />
          <Input
            label="Actor user ID"
            placeholder="Any actor"
            value={filters.actorUserId}
            onChange={(e) => updateFilter("actorUserId", e.target.value)}
          />
          <Input
            label="Target type"
            placeholder="Any target type"
            value={filters.targetType}
            onChange={(e) => updateFilter("targetType", e.target.value)}
          />
          <Input
            label="From"
            type="datetime-local"
            error={rangeError || undefined}
            value={filters.from}
            onChange={(e) => updateFilter("from", e.target.value)}
          />
          <Input
            label="To"
            type="datetime-local"
            error={rangeError || undefined}
            value={filters.to}
            onChange={(e) => updateFilter("to", e.target.value)}
          />
        </fieldset>
        {hasFilters && (
          <div className="mt-4 flex justify-end">
            <Button variant="ghost" size="sm" icon="filter_off" onClick={clearFilters}>
              Clear filters
            </Button>
          </div>
        )}
      </Card>

      {error && !loading ? (
        <ErrorState message={error.message} onRetry={() => setRetryTick((tick) => tick + 1)} />
      ) : loading ? (
        <LoadingState label="Loading audit events" lines={8} />
      ) : events.length === 0 ? (
        <EmptyState
          icon="history"
          title={hasFilters ? "No matching events" : "No events yet"}
          body={
            hasFilters
              ? "Try widening the time range or clearing a filter."
              : "Security and administrative events will appear here."
          }
        />
      ) : (
        <Card padding="none">
          <div className="w-full overflow-x-auto custom-scrollbar">
            <table className="w-full min-w-[640px] text-sm" aria-label="Audit events">
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={`${TABLE_HEAD_CELL} px-4 py-3 text-start`}>Time</th>
                  <th className={`${TABLE_HEAD_CELL} px-4 py-3 text-start`}>Actor</th>
                  <th className={`${TABLE_HEAD_CELL} px-4 py-3 text-start`}>Action</th>
                  <th className={`${TABLE_HEAD_CELL} px-4 py-3 text-start`}>Target</th>
                  <th className={`${TABLE_HEAD_CELL} hidden px-4 py-3 text-start lg:table-cell`}>
                    Result
                  </th>
                  <th className={`${TABLE_HEAD_CELL} px-4 py-3 text-end`}>
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {events.map((row, index) => (
                  <tr
                    key={row.id ?? index}
                    className="border-b border-line last:border-0 hover:bg-raised/60"
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-muted">
                      <time dateTime={row.ts}>{formatTime(row.ts)}</time>
                    </td>
                    <td
                      className="max-w-[160px] truncate px-4 py-3 font-mono text-xs"
                      title={row.actorUserId ?? ""}
                    >
                      {row.actorUserId ?? row.via ?? "system"}
                    </td>
                    <td className="px-4 py-3 font-medium text-text">{row.action}</td>
                    <td className="max-w-[220px] truncate px-4 py-3 text-muted">
                      {row.targetType
                        ? [row.targetType, row.targetId].filter(Boolean).join(" ")
                        : "—"}
                    </td>
                    <td className="hidden px-4 py-3 lg:table-cell">
                      <StatusPill
                        size="sm"
                        variant={row.result && row.result !== "success" ? "err" : "ok"}
                      >
                        {row.result ?? "success"}
                      </StatusPill>
                    </td>
                    <td className="px-4 py-3 text-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={detailLabel(row)}
                        aria-haspopup="dialog"
                        onClick={() => setSelected(row)}
                      >
                        Details
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            className="px-4"
            currentPage={pagination.page}
            pageSize={pagination.pageSize}
            totalItems={pagination.totalItems}
            onPageChange={(page) => setPagination((prev) => ({ ...prev, page }))}
            onPageSizeChange={(pageSize) =>
              setPagination((prev) =>
                prev.pageSize === pageSize ? prev : { ...prev, pageSize, page: 1 },
              )
            }
          />
        </Card>
      )}

      <Drawer
        isOpen={selected != null}
        onClose={() => setSelected(null)}
        title={selected ? selected.action : ""}
        width="lg"
      >
        {selected && (
          <div className="flex min-w-0 flex-col gap-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              {[
                ["Time", `${formatTime(selected.ts)} (${selected.ts})`],
                ["Actor", selected.actorUserId ?? "—"],
                ["Via", selected.via ?? "—"],
                ["API key", selected.actorApiKeyId ?? "—"],
                ["IP", selected.ip ?? "—"],
                ["Workspace", selected.workspaceId ?? "—"],
                [
                  "Target",
                  [selected.targetType, selected.targetId].filter(Boolean).join(" ") || "—",
                ],
                ["Result", selected.result ?? "success"],
              ].map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted">{label}</dt>
                  <dd className="min-w-0 break-all font-mono text-xs text-text">{value}</dd>
                </div>
              ))}
            </dl>
            {[
              ["Before", prettySnapshot(selected.before)],
              ["After", prettySnapshot(selected.after)],
            ].map(([label, json]) =>
              json ? (
                <section key={label} className="min-w-0">
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                    {label}
                  </h3>
                  <pre
                    dir="ltr"
                    className="max-h-80 overflow-auto rounded-lg bg-raised p-3 font-mono text-xs text-text custom-scrollbar"
                  >
                    {json}
                  </pre>
                </section>
              ) : null,
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}
