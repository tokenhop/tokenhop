"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";
import { formatUptime, uptimeSecondsSince } from "@/lib/gatewayStatus";

const LOCAL_TICK_MS = 60_000;

/**
 * Gateway status card per the Signal board:
 * - Pulsing lime dot + "Gateway online"
 * - Subtitle line: `:PORT · up UPTIME`
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
 */
export default function GatewayStatusCard({ loading, online, port, startedAt }) {
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

  return (
    <div
      role="status"
      className="flex h-[54px] items-center gap-2.5 rounded-xl bg-lime-bg px-3 py-2.5"
    >
      <span
        className={cn("size-2 shrink-0 rounded-full bg-lime-ink", "animate-pulse")}
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="truncate text-[13px] leading-[17px] font-semibold text-lime-ink">
          Gateway online
        </p>
        <p className="truncate font-mono text-[11px] leading-[15px] text-muted">{subline}</p>
      </div>
    </div>
  );
}

GatewayStatusCard.propTypes = {
  loading: PropTypes.bool,
  online: PropTypes.bool,
  port: PropTypes.number,
  startedAt: PropTypes.string,
};
