"use client";

import { Fragment, memo, useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import SegmentedControl from "@/shared/components/SegmentedControl";
import EmptyState from "@/shared/components/EmptyState";
import Meter from "@/shared/components/Meter";
import ProviderTile from "@/shared/components/ProviderTile";
import { TABLE_HEAD_CELL, TABLE_HEAD_ROW } from "@/shared/components/displayPrimitives";
import { groupRows, sharePct, sortRows } from "../lib/usageShapes";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtShort = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n || 0);
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;
const fmtMs = (n) => (n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`);
const fmtRate = (n) => `${(n * 100).toFixed(1)}%`;
// Em dash for absent latency/empty-rate data (endpoint rows without
// edit-prediction metrics). Screen readers get words, not punctuation.
const noData = (
  <span className="text-muted">
    <span aria-hidden="true">—</span>
    <span className="sr-only">no data</span>
  </span>
);
const fmtTime = (iso) => {
  if (!iso) return "Never";
  const diffMins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
  return new Date(iso).toLocaleDateString();
};

const VIEWS = {
  model: {
    key: "rawModel",
    label: "Model",
    source: "byModel",
    emptyTitle: "No usage by model in this period.",
  },
  account: {
    key: "accountName",
    label: "Account",
    source: "byAccount",
    emptyTitle: "No account usage in this period.",
  },
  apiKey: {
    key: "keyName",
    label: "API key",
    source: "byApiKey",
    emptyTitle: "No API key usage in this period.",
  },
  endpoint: {
    key: "endpoint",
    label: "Endpoint",
    source: "byEndpoint",
    emptyTitle: "No endpoint usage in this period.",
  },
};

/**
 * Breakdown card: view (Model/Account/API key/Endpoint) + Costs/Tokens
 * toggle, semantic sortable table with grouped expansion (localStorage
 * persisted per view) and a share Meter column.
 *
 * Sorting is local state, not URL params: the old orchestrator synced
 * sortBy/sortOrder through ?sortBy=, which fought the tab router and is
 * unnecessary for a view-local table.
 *
 * @param {object} props
 * @param {object|null} props.stats stats shape from /api/usage/stats
 */
function UsageBreakdown({ stats }) {
  const [view, setView] = useState("model");
  const [mode, setMode] = useState("costs");
  const [sortBy, setSortBy] = useState("totalCost");
  const [sortOrder, setSortOrder] = useState("desc");
  const [expanded, setExpanded] = useState(new Set());
  const config = VIEWS[view];
  const storageKey = `usage-stats:expanded-${view}`;

  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      setExpanded(new Set(saved ? JSON.parse(saved) : []));
    } catch {
      setExpanded(new Set());
    }
  }, [storageKey]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...expanded]));
    } catch {}
  }, [expanded, storageKey]);

  const groups = useMemo(() => {
    const source = stats?.[config.source];
    const rows = Array.isArray(source)
      ? source
      : Object.entries(source || {}).map(([key, v]) => ({ key, ...v }));
    return groupRows(sortRows(rows, sortBy, sortOrder), config.key);
  }, [stats, config, sortBy, sortOrder]);

  const totals = useMemo(() => {
    const t = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    for (const g of groups) {
      t.requests += g.summary.requests || 0;
      t.promptTokens += g.summary.promptTokens || 0;
      t.completionTokens += g.summary.completionTokens || 0;
      t.cost += g.summary.cost || 0;
    }
    return t;
  }, [groups]);
  const nonCached = (s) => Math.max(0, (s.promptTokens || 0) - (s.cachedTokens || 0));
  const isEndpoint = view === "endpoint";

  const headers = [
    { field: "__label", label: config.label, numeric: false },
    { field: "requests", label: "Requests", numeric: true },
    { field: "__input", label: "Input", numeric: true },
    { field: "__output", label: "Output", numeric: true },
    { field: "totalCost", label: "Cost", numeric: true },
    ...(isEndpoint
      ? [
          { field: "__latency", label: "Latency p50", numeric: true, note: "median" },
          {
            field: "__empty",
            label: "Empty",
            numeric: true,
            note: "share of edit predictions that returned no text",
          },
        ]
      : []),
    { field: "__share", label: "Share", numeric: false },
  ];
  // Header buttons map to real sortable row fields (headers need unique keys,
  // so Input/Output share the cost column or their token column per mode).
  const sortField = (field) => {
    if (field === "__input") return mode === "costs" ? "totalCost" : "promptTokens";
    if (field === "__output") return mode === "costs" ? "totalCost" : "completionTokens";
    return field;
  };

  const toggleSort = (field) => {
    const target = sortField(field);
    if (sortBy === target) setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
    else {
      setSortBy(target);
      setSortOrder("desc");
    }
  };
  const cells = (s) =>
    mode === "costs" ? (
      <>
        <td className="px-6 py-3 text-end font-mono">{fmt(s.requests)}</td>
        <td className="px-6 py-3 text-end font-mono text-muted">
          {fmtCost(
            ((s.cost || s.totalCost || 0) * nonCached(s)) /
              Math.max(1, (s.promptTokens || 0) + (s.completionTokens || 0)),
          )}
        </td>
        <td className="px-6 py-3 text-end font-mono text-muted">
          {fmtCost(
            ((s.cost || s.totalCost || 0) * (s.completionTokens || 0)) /
              Math.max(1, (s.promptTokens || 0) + (s.completionTokens || 0)),
          )}
        </td>
        <td className="px-6 py-3 text-end font-mono">{fmtCost(s.cost ?? s.totalCost)}</td>
      </>
    ) : (
      <>
        <td className="px-6 py-3 text-end font-mono">{fmt(s.requests)}</td>
        <td className="px-6 py-3 text-end font-mono text-muted">{fmtShort(s.promptTokens)}</td>
        <td className="px-6 py-3 text-end font-mono text-muted">{fmtShort(s.completionTokens)}</td>
        <td className="px-6 py-3 text-end font-mono">
          {fmtShort((s.promptTokens || 0) + (s.completionTokens || 0))}
        </td>
      </>
    );

  const share = (s) => {
    const denom = mode === "costs" ? totals.cost : totals.promptTokens + totals.completionTokens;
    const num =
      mode === "costs"
        ? s.cost || s.totalCost || 0
        : (s.promptTokens || 0) + (s.completionTokens || 0);
    return sharePct(num, denom);
  };

  // Endpoint-only latency/empty-rate cells. Item rows read the per-item
  // fields; the group summary row reads stats.endpointLatency (percentiles
  // can't be summed from per-item p50s). Rows without data show an em dash.
  const perfCells = (s, groupKey) => {
    const fromGroup =
      groupKey !== undefined && stats?.endpointLatency ? stats.endpointLatency[groupKey] : null;
    const p50 = fromGroup?.latencyP50Ms ?? s.latencyP50Ms;
    const avg = fromGroup?.latencyAvgMs ?? s.latencyAvgMs;
    const empty = fromGroup?.emptyRate ?? s.emptyRate;
    return (
      <>
        <td className="px-6 py-3 text-end font-mono">
          {p50 == null ? (
            noData
          ) : (
            <span title={avg != null ? `average ${fmtMs(avg)}` : undefined}>
              {fmtMs(p50)}
              {avg != null && <span className="sr-only"> (average {fmtMs(avg)})</span>}
            </span>
          )}
        </td>
        <td className="px-6 py-3 text-end font-mono">{empty == null ? noData : fmtRate(empty)}</td>
      </>
    );
  };

  return (
    <Card padding="none">
      <Card.Header
        className="px-6 pt-4 pb-4"
        title="Breakdown"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              aria-label="Breakdown view"
              size="sm"
              value={view}
              onChange={setView}
              options={[
                { value: "model", label: "Model" },
                { value: "account", label: "Account" },
                { value: "apiKey", label: "API key" },
                { value: "endpoint", label: "Endpoint" },
              ]}
            />
            <SegmentedControl
              aria-label="Breakdown metric"
              size="sm"
              value={mode}
              onChange={setMode}
              options={[
                { value: "costs", label: "Costs" },
                { value: "tokens", label: "Tokens" },
              ]}
            />
          </div>
        }
      />
      {!stats || groups.length === 0 ? (
        <EmptyState icon="table_rows" title={config.emptyTitle} />
      ) : (
        <section
          className="overflow-x-auto focus-visible:shadow-focus"
          aria-label="Usage breakdown"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable table region is keyboard-focusable with a label (WCAG 2.1.1, YAN-314).
          tabIndex={0}
        >
          <table className="w-full text-start text-sm">
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                {headers.map((h) => (
                  <th
                    key={h.field}
                    scope="col"
                    aria-sort={
                      sortBy === sortField(h.field)
                        ? sortOrder === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                    className={`${TABLE_HEAD_CELL} px-6 py-3 ${h.numeric ? "text-end" : "text-start"}`}
                  >
                    {h.field === "__label" ||
                    h.field === "__share" ||
                    h.field === "__latency" ||
                    h.field === "__empty" ? (
                      <>
                        {h.label}
                        {h.note && <span className="sr-only"> ({h.note})</span>}
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => toggleSort(h.field)}
                        className="inline-flex items-center gap-1 hover:text-text"
                      >
                        {h.label}
                        <span aria-hidden="true" className="opacity-60">
                          {sortBy === sortField(h.field) ? (sortOrder === "asc" ? "↑" : "↓") : "↕"}
                        </span>
                      </button>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {groups.map((group) => {
                const open = expanded.has(group.groupKey);
                const pct = share(group.summary);
                const providers = new Set(group.items.map((item) => item.provider));
                const groupProvider = providers.size === 1 ? group.items[0]?.provider : null;
                return (
                  <Fragment key={group.groupKey}>
                    <tr className="transition-colors hover:bg-raised/50">
                      <td className="px-6 py-3">
                        <button
                          type="button"
                          onClick={() =>
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              if (next.has(group.groupKey)) next.delete(group.groupKey);
                              else next.add(group.groupKey);
                              return next;
                            })
                          }
                          aria-expanded={open}
                          className="flex items-center gap-2 font-medium"
                        >
                          <span
                            aria-hidden="true"
                            className={`material-symbols-outlined text-[18px] text-muted transition-transform ${open ? "rotate-90" : ""}`}
                          >
                            chevron_right
                          </span>
                          {view === "model" && groupProvider && (
                            <ProviderTile providerId={groupProvider} size="sm" />
                          )}
                          <span className="max-w-[280px] truncate font-mono text-[13px]">
                            {group.groupKey}
                          </span>
                          <span className="sr-only">
                            {group.items.length} rows, last used {fmtTime(group.summary.lastUsed)}
                          </span>
                        </button>
                      </td>
                      {cells(group.summary)}
                      {isEndpoint && perfCells(group.summary, group.groupKey)}
                      <td className="px-6 py-3">
                        <span className="flex items-center gap-2">
                          <span className="min-w-24 flex-1">
                            <Meter
                              value={pct}
                              kind="credits"
                              label={`Share of ${group.groupKey}`}
                              valueText={`${pct.toFixed(1)} percent`}
                            />
                          </span>
                          <span className="font-mono text-xs text-muted">{pct.toFixed(0)}%</span>
                        </span>
                      </td>
                    </tr>
                    {open &&
                      group.items.map((item) => (
                        <tr
                          key={`${group.groupKey}|${item.key}|${item.rawModel}|${item.provider}|${item.connectionId}|${item.keyName}|${item.endpoint}|${item.apiKeyKey}`}
                          className="bg-raised/20"
                        >
                          <td className="py-3 ps-12 pe-6 font-mono text-[13px] text-muted">
                            <span className="flex min-w-0 items-center gap-2">
                              {item.provider && (
                                <ProviderTile providerId={item.provider} size="sm" />
                              )}
                              <span className="truncate">
                                {item.provider
                                  ? `${item.rawModel || item.groupKey} · ${item.provider}`
                                  : item.rawModel || item.key || "—"}
                              </span>
                            </span>
                          </td>
                          {cells(item)}
                          {isEndpoint && perfCells(item)}
                          <td className="px-6 py-3">
                            <span className="flex items-center gap-2">
                              <span className="min-w-24 flex-1">
                                <Meter
                                  value={share(item)}
                                  kind="credits"
                                  label={`Share of ${item.rawModel || item.key}`}
                                  valueText={`${share(item).toFixed(1)} percent`}
                                />
                              </span>
                              <span className="font-mono text-xs text-muted">
                                {share(item).toFixed(0)}%
                              </span>
                            </span>
                          </td>
                        </tr>
                      ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </Card>
  );
}

UsageBreakdown.propTypes = {
  stats: PropTypes.object,
};

export default memo(UsageBreakdown);
