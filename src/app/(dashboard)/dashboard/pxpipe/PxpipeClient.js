"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import PropTypes from "prop-types";
import dynamic from "next/dynamic";
import {
  Card,
  Button,
  SegmentedControl,
  EmptyState,
  StatusPill,
  Terminal,
  Skeleton,
} from "@/shared/components";
import { formatTokens, formatUptime, reasonLabel, statusLabel } from "./pxpipePresentation";
import ProviderTile from "@/shared/components/ProviderTile";

const TONE_TEXT = {
  ok: "text-ok",
  warn: "text-warn",
  muted: "text-muted",
};

/** Summary card: eyebrow label, display value, optional detail slot. */
function SummaryCard({ label, value, tone, children }) {
  return (
    <Card className="p-4">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      {value !== undefined && (
        <p className={`mt-1 font-mono text-xl font-semibold ${tone ? TONE_TEXT[tone] : ""}`}>
          {value}
        </p>
      )}
      {children}
    </Card>
  );
}

SummaryCard.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.node,
  tone: PropTypes.oneOf(Object.keys(TONE_TEXT)),
  children: PropTypes.node,
};

/** Token-colored chart in its own client chunk (recharts, client-only). */
const PxpipeSavingsChart = dynamic(() => import("./PxpipeSavingsChart"), {
  ssr: false,
  loading: () => <Skeleton className="h-[220px] w-full" />,
});

const WINDOW_OPTIONS = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last7d", label: "7 days" },
  { value: "last30d", label: "30 days" },
  { value: "all", label: "All time" },
];

/**
 * PXPIPE debug dashboard (hidden route): service status, token savings,
 * history and install logs. Data flow is unchanged; only Signal primitives.
 */
export default function PxpipeClient() {
  const [status, setStatus] = useState(null);
  const [health, setHealth] = useState(null);
  const [stats, setStats] = useState(null);
  const [logs, setLogs] = useState(null);
  const [windowId, setWindowId] = useState("last7d");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [statusRes, statsRes, logsRes] = await Promise.all([
        fetch("/api/pxpipe/status", { headers: { "Cache-Control": "no-store" } }),
        fetch("/api/pxpipe/stats"),
        fetch("/api/pxpipe/logs?limit=50"),
      ]);
      setStatus(await statusRes.json());
      setStats(await statsRes.json());
      setLogs(await logsRes.json());
      const healthRes = await fetch("/api/pxpipe/health", { method: "POST" });
      setHealth(await healthRes.json());
    } catch {
      /* sections render placeholders */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const w = stats?.windows?.[windowId];
  const statusText = statusLabel(status, health);
  const statusVariant = statusText === "Healthy" ? "ok" : status?.installed ? "warn" : "neutral";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-subtle">
          Experimental
        </p>
        <div className="flex items-center gap-2">
          <Link
            href="/dashboard/token-saver"
            className="text-sm text-coral hover:underline focus-visible:outline-none focus-visible:shadow-focus"
          >
            Token saver settings
          </Link>
          <Button size="sm" variant="ghost" onClick={refresh} loading={loading}>
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <SummaryCard
          label="Status"
          tone={statusText === "Healthy" ? "ok" : status?.installed ? "warn" : "muted"}
        >
          <StatusPill variant={statusVariant} size="sm" dot>
            {statusText}
          </StatusPill>
          <p className="mt-0.5 text-xs text-muted">
            {status?.enabled ? "Enabled in pipeline" : "Disabled in pipeline"}
          </p>
        </SummaryCard>
        <SummaryCard label="Version" value={status?.version ? `v${status.version}` : "—"}>
          <p className="text-xs text-muted">pxpipe-proxy</p>
        </SummaryCard>
        <SummaryCard label="Uptime" value={formatUptime(status?.uptimeMs)}>
          <p className="text-xs text-muted">module loaded</p>
        </SummaryCard>
        <SummaryCard label="Requests" value={w ? w.requests.toLocaleString() : "—"} />
        <SummaryCard label="Compressed" value={w ? w.compressed.toLocaleString() : "—"} tone="ok" />
        <SummaryCard label="Bypassed" value={w ? w.bypassed.toLocaleString() : "—"} />
      </div>

      <Card title="Token savings (estimated)">
        <SegmentedControl
          options={WINDOW_OPTIONS}
          value={windowId}
          onChange={setWindowId}
          size="sm"
          aria-label="Savings window"
        />
        <div className="mt-4 grid grid-cols-2 gap-4 text-center md:grid-cols-4">
          <div>
            <p className="text-xs text-muted">Original tokens</p>
            <p className="font-mono text-lg font-semibold text-text">
              {w ? formatTokens(w.tokensBeforeEst) : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted">After PXPIPE</p>
            <p className="font-mono text-lg font-semibold text-text">
              {w ? formatTokens(w.tokensAfterEst) : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted">Saved</p>
            <p className="font-mono text-lg font-semibold text-ok">
              {w ? formatTokens(w.tokensSavedEst) : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted">Reduction</p>
            <p className="font-mono text-lg font-semibold text-ok">{w ? `${w.savedPct}%` : "—"}</p>
          </div>
        </div>
        <p className="mt-3 text-xs text-muted">
          Estimates from body size before/after imaging; billed usage per request (recorded on the
          Usage page) remains the ground truth. Images generated:{" "}
          {w ? w.imagesGenerated.toLocaleString() : "—"} · avg compression time:{" "}
          {w ? `${w.avgCompressionMs}ms` : "—"} · errors: {w ? w.errors : "—"}
        </p>
      </Card>

      <Card title="Tokens saved — last 30 days">
        {loading ? (
          <Skeleton className="h-32 w-full" />
        ) : stats?.timeline?.some((d) => d.tokensSavedEst > 0) ? (
          <PxpipeSavingsChart data={stats.timeline} />
        ) : (
          <EmptyState
            icon="monitoring"
            title="No savings recorded yet"
            body="Enable PXPIPE in the Token saver and route a large Claude-format request."
          />
        )}
      </Card>

      <Card title="History" padding="none">
        <section
          className="overflow-x-auto focus-visible:shadow-focus"
          aria-label="PXPIPE history"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable table region is keyboard-focusable with a label (WCAG 2.1.1, YAN-314).
          tabIndex={0}
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-start text-xs text-muted">
                <th scope="col" className="py-2 pe-3 ps-4 text-start font-medium">
                  Time
                </th>
                <th scope="col" className="py-2 pe-3 text-start font-medium">
                  Model
                </th>
                <th scope="col" className="py-2 pe-3 text-end font-medium">
                  Original
                </th>
                <th scope="col" className="py-2 pe-3 text-end font-medium">
                  Compressed
                </th>
                <th scope="col" className="py-2 pe-3 text-end font-medium">
                  Saved
                </th>
                <th scope="col" className="py-2 pe-3 text-end font-medium">
                  %
                </th>
                <th scope="col" className="py-2 pe-3 text-end font-medium">
                  Duration
                </th>
                <th scope="col" className="py-2 pe-4 text-start font-medium">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {(stats?.recent || []).slice(0, 50).map((ev, i) => (
                // Event ids are timestamps; the index disambiguates retries of the same event.
                // biome-ignore lint/suspicious/noArrayIndexKey: no stable row id exists.
                <tr key={`${ev.ts}-${i}`} className="border-b border-line/50 last:border-b-0">
                  <td className="whitespace-nowrap py-1.5 pe-3 ps-4 text-muted">
                    {new Date(ev.ts).toLocaleString()}
                  </td>
                  <td className="py-1.5 pe-3 font-mono text-xs">
                    {ev.provider && (
                      <ProviderTile
                        providerId={ev.provider}
                        size="sm"
                        className="me-2 align-middle"
                      />
                    )}
                    {ev.provider ? `${ev.provider}/${ev.model}` : ev.model || "—"}
                  </td>
                  <td className="py-1.5 pe-3 text-end font-mono text-xs">
                    {ev.applied ? formatTokens(ev.tokensBeforeEst) : "—"}
                  </td>
                  <td className="py-1.5 pe-3 text-end font-mono text-xs">
                    {ev.applied ? formatTokens(ev.tokensAfterEst) : "—"}
                  </td>
                  <td className="py-1.5 pe-3 text-end font-mono text-xs text-ok">
                    {ev.applied ? formatTokens(ev.tokensSavedEst) : "—"}
                  </td>
                  <td className="py-1.5 pe-3 text-end font-mono text-xs">
                    {ev.applied ? `${ev.savedPct}%` : "—"}
                  </td>
                  <td className="py-1.5 pe-3 text-end font-mono text-xs">
                    {ev.durationMs != null ? `${ev.durationMs}ms` : "—"}
                  </td>
                  <td className="py-1.5 pe-4">
                    <span title={ev.detail || undefined}>
                      <StatusPill
                        size="sm"
                        variant={
                          ev.applied
                            ? "ok"
                            : ev.reason === "transform_error" || ev.reason === "timeout"
                              ? "err"
                              : "warn"
                        }
                      >
                        {ev.applied ? "Compressed" : reasonLabel(ev.reason)}
                      </StatusPill>
                    </span>
                  </td>
                </tr>
              ))}
              {(!stats?.recent || stats.recent.length === 0) && (
                <tr>
                  <td colSpan={8} className="py-6 text-center text-sm text-muted">
                    No PXPIPE activity yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </Card>

      <Card title="PXPIPE logs" id="logs">
        {logs?.installLog ? (
          <Terminal
            label="PXPIPE install log"
            lines={String(logs.installLog)
              .split("\n")
              .map((message) => ({ level: "LOG", message }))}
          />
        ) : (
          <p className="text-sm text-muted">No install log yet.</p>
        )}
      </Card>
    </div>
  );
}
