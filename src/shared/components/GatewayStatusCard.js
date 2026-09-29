"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";
import { formatUptime, pulseDurationMs, uptimeSecondsSince } from "@/lib/gatewayStatus";

const LOCAL_TICK_MS = 60_000;

/** SVG polyline points for the heartbeat sparkline in its 64×16 viewBox. */
function sparklinePoints(series) {
  const max = Math.max(1, ...series);
  const step = 62 / (series.length - 1);
  return series
    .map(
      (count, index) => `${(1 + index * step).toFixed(1)},${(14 - (count / max) * 12).toFixed(1)}`,
    )
    .join(" ");
}

/**
 * Gateway status card per the Signal board:
 * - Pulsing lime dot + "Gateway online"; the pulse rhythm follows live
 *   traffic (2.4s idle → 0.9s busy) and is static under reduced motion
 * - Subtitle line: `:PORT · up UPTIME`
 * - ~64×16 aria-hidden 15-minute req/min sparkline + an sr-only summary
 * - Local 60s ticker advances uptime from `startedAt` (no extra network requests),
 *   pauses while the tab is hidden
 * - Offline err state when unreachable
 * - Skeleton while loading
 *
 * @param {object} props
 * @param {boolean} props.loading
 * @param {boolean|null} props.online `null` = unknown/loading
 * @param {number|null} [props.port]
 * @param {string|null} [props.startedAt] ISO timestamp of gateway start
 * @param {{ series: number[], total: number }|null} [props.traffic] 15-minute
 *   req/min heartbeat series from /api/shell/summary (null while unknown)
 */
export default function GatewayStatusCard({ loading, online, port, startedAt, traffic = null }) {
  const [nowMs, setNowMs] = useState(Date.now);
  const [prevStartedAt, setPrevStartedAt] = useState(startedAt);

  if (prevStartedAt !== startedAt) {
    setPrevStartedAt(startedAt);
    setNowMs(Date.now());
  }

  useEffect(() => {
    if (!online || !startedAt) return undefined;
    const interval = window.setInterval(() => {
      if (!document.hidden) setNowMs(Date.now());
    }, LOCAL_TICK_MS);
    const onVisibility = () => {
      if (!document.hidden) setNowMs(Date.now());
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [online, startedAt]);

  if (loading || online === null) {
    return (
      <div
        role="status"
        aria-label="Gateway status loading"
        className="flex h-[54px] animate-pulse items-center gap-2.5 rounded-xl bg-lime-bg px-3 py-2.5"
      >
        <span className="size-2 shrink-0 rounded-full bg-lime-ink" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="h-[17px] w-24 rounded bg-line" />
          <span className="h-[15px] w-32 rounded bg-line" />
        </div>
      </div>
    );
  }

  if (!online) {
    return (
      <div
        role="status"
        className="flex h-[54px] items-center gap-2.5 rounded-xl bg-err-bg px-3 py-2.5"
      >
        <span className="size-2 shrink-0 rounded-full bg-err" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="truncate text-[13px] leading-[17px] font-semibold text-err">
            Gateway offline
          </p>
          <p className="truncate font-mono text-[11px] leading-[15px] text-muted">reconnecting</p>
        </div>
      </div>
    );
  }

  const seconds = uptimeSecondsSince(startedAt, nowMs);
  const uptimeLabel = seconds != null ? `up ${formatUptime(seconds)}` : null;
  const portLabel = port ? `:${port}` : "local";
  const subline = uptimeLabel ? `${portLabel} · ${uptimeLabel}` : portLabel;
  const pulseMs = pulseDurationMs(traffic?.series?.[traffic.series.length - 1] ?? 0);
  const trafficSummary =
    traffic === null
      ? null
      : traffic.total === 0
        ? "No requests in the last 15 minutes"
        : traffic.total === 1
          ? "1 request in the last 15 minutes"
          : `${traffic.total} requests in the last 15 minutes`;

  return (
    <div
      role="status"
      className="flex h-[54px] items-center gap-2.5 rounded-xl bg-lime-bg px-3 py-2.5"
    >
      <span
        className={cn("size-2 shrink-0 rounded-full bg-lime-ink", "animate-pulse")}
        style={{ animationDuration: `${pulseMs}ms` }}
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="truncate text-[13px] leading-[17px] font-semibold text-lime-ink">
          Gateway online
        </p>
        <p className="truncate font-mono text-[11px] leading-[15px] text-muted">{subline}</p>
      </div>
      {traffic !== null && (
        <>
          <svg
            width="64"
            height="16"
            viewBox="0 0 64 16"
            preserveAspectRatio="none"
            aria-hidden="true"
            className="shrink-0 text-lime-ink"
          >
            <polyline
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={sparklinePoints(traffic.series)}
            />
          </svg>
          <span className="sr-only">{trafficSummary}</span>
        </>
      )}
    </div>
  );
}

GatewayStatusCard.propTypes = {
  loading: PropTypes.bool,
  online: PropTypes.bool,
  port: PropTypes.number,
  startedAt: PropTypes.string,
  traffic: PropTypes.shape({
    series: PropTypes.arrayOf(PropTypes.number).isRequired,
    total: PropTypes.number.isRequired,
  }),
};
