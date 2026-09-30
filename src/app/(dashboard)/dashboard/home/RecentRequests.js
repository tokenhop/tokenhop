"use client";

import PropTypes from "prop-types";
import { useState } from "react";
import Card from "@/shared/components/Card";
import CardLink from "@/shared/components/CardLink";
import ProviderTile from "@/shared/components/ProviderTile";
import RequestDetailDrawer, { providerLabel } from "../usage/components/RequestDetailDrawer";
import { formatCompact, formatLatency, timeAgo } from "./format";
import { WidgetEmpty, WidgetError, WidgetSkeleton } from "./WidgetStates";

/**
 * Normalize either a requestDetails row or a usageStats recentRequests row
 * into the shape the Home recent-requests list expects.
 * @param {object} item
 * @returns {{ id: string, model: string, provider: string, via: string, status: "ok"|"warn"|"err", tok: string, isErr: boolean, lat: string, t: string }}
 */
export function normalizeRecentRequest(item) {
  const statusStr = String(item?.status || "ok").toLowerCase();
  const isErr =
    statusStr.includes("err") ||
    statusStr === "429" ||
    statusStr.startsWith("5") ||
    statusStr.startsWith("4");
  const isWarn = statusStr.includes("warn") || statusStr.includes("cool");
  const status = isErr ? "err" : isWarn ? "warn" : "ok";

  const model = item?.model || "unknown";
  const provider = item?.provider || "";
  const endpoint = item?.endpoint || "";
  const via = endpoint || provider || "direct";

  const tokens = item?.tokens || {};
  const prompt = Number(item?.promptTokens ?? tokens.prompt_tokens ?? tokens.input_tokens) || 0;
  const completion =
    Number(item?.completionTokens ?? tokens.completion_tokens ?? tokens.output_tokens) || 0;
  const totalTokens = prompt + completion;

  const tok =
    isErr && (item?.errorCode || statusStr)
      ? item.errorCode || statusStr
      : formatCompact(totalTokens);
  const latencyMs = item?.latency?.total ?? item?.latency;
  const lat = formatLatency(latencyMs);
  const t = timeAgo(item?.timestamp);

  return {
    id: item?.id || `${item?.timestamp}-${model}`,
    model,
    provider,
    via,
    status,
    tok,
    isErr,
    lat,
    t,
  };
}

/**
 * Recent requests list: status dot, model (Geist Mono), route/client,
 * tokens or error code, latency, relative time. Rows sourced from
 * request details (they have a real id) are buttons that open the shared
 * RequestDetailDrawer; fallback rows (usage stats, no real id) stay static.
 * Error rows show a visible "Error" prefix so status is not colour-only.
 *
 * @param {object} props
 * @param {Array<object>|null} props.details from /api/usage/request-details
 * @param {Array<object>|null} props.fallback from /api/usage/stats recentRequests
 * @param {boolean} props.loading
 * @param {string|null} props.error shown only when no rows can be rendered
 * @param {string|null} [props.detailsError] request-details failure while fallback rows render
 * @param {() => void} props.onRetry
 */
export default function RecentRequests({
  details,
  fallback,
  loading,
  error,
  detailsError,
  onRetry,
}) {
  const [selected, setSelected] = useState(null);
  const [open, setOpen] = useState(false);

  let body;
  if (loading) {
    body = <WidgetSkeleton lines={6} label="Loading recent requests" />;
  } else if (error) {
    body = <WidgetError message={error} onRetry={onRetry} />;
  } else {
    const fromDetails = Array.isArray(details) && details.length > 0;
    const source = fromDetails ? details : fallback;
    const list = Array.isArray(source) ? source.slice(0, 6) : [];

    body =
      list.length === 0 ? (
        <WidgetEmpty
          icon="history"
          title="No recent requests"
          body="Requests passing through your endpoint will appear here in real time."
          actionLabel="View all logs"
          actionHref="/dashboard/usage?tab=logs"
        />
      ) : (
        <ul className="flex min-w-0 flex-col" aria-label="Recent requests">
          {list.map((raw, index) => {
            const item = normalizeRecentRequest(raw);
            const errText = /^err/i.test(item.tok) ? "Error" : `Error ${item.tok}`;
            const row = (
              <>
                <span
                  aria-hidden="true"
                  className={`size-2 shrink-0 rounded-full ${
                    item.status === "ok" ? "bg-ok" : item.status === "warn" ? "bg-warn" : "bg-err"
                  }`}
                />
                {item.provider && <ProviderTile providerId={item.provider} size="md" />}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-mono text-sm text-text">{item.model}</span>
                  <span className="truncate text-xs text-muted">{item.via}</span>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-0.5 text-end">
                  <span
                    className={`font-mono text-xs ${item.isErr ? "font-semibold text-err" : "text-text"}`}
                  >
                    {item.isErr ? errText : item.tok}
                  </span>
                  <span className="text-xs text-muted">
                    {item.lat !== "—" ? `${item.lat} · ` : ""}
                    {item.t}
                  </span>
                </div>
              </>
            );
            return (
              <li
                key={raw?.id || `${item.id}-${index}`}
                className="border-t border-line first:border-t-0"
              >
                {fromDetails ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(raw);
                      setOpen(true);
                    }}
                    aria-haspopup="dialog"
                    className="flex w-full items-center gap-3 rounded-lg py-2.5 text-start outline-none hover:bg-raised/60 focus-visible:shadow-focus"
                  >
                    {row}
                    <span className="sr-only">Request detail</span>
                  </button>
                ) : (
                  <div className="flex items-center gap-3 py-2.5">{row}</div>
                )}
              </li>
            );
          })}
        </ul>
      );
    if (!fromDetails && detailsError && list.length > 0) {
      body = (
        <>
          {body}
          <p className="mt-2 text-xs text-muted" aria-live="polite">
            Couldn't load part of this page
          </p>
        </>
      );
    }
  }

  return (
    <>
      {body}
      <RequestDetailDrawer
        detail={selected}
        isOpen={open}
        onClose={() => setOpen(false)}
        providerName={selected ? providerLabel(selected.provider) : null}
      />
    </>
  );
}

RecentRequests.propTypes = {
  details: PropTypes.arrayOf(PropTypes.object),
  fallback: PropTypes.arrayOf(PropTypes.object),
  loading: PropTypes.bool,
  error: PropTypes.string,
  detailsError: PropTypes.string,
  onRetry: PropTypes.func.isRequired,
};

/** Card wrapper so the page grid stays dumb. */
export function RecentRequestsCard(props) {
  return (
    <Card
      className="min-w-0"
      action={<CardLink href="/dashboard/usage?tab=logs">All logs</CardLink>}
      title="Recent requests"
    >
      <RecentRequests {...props} />
    </Card>
  );
}
