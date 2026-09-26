"use client";

import PropTypes from "prop-types";
import Callout from "@/shared/components/Callout";
import { useState } from "react";
import { getProviderIconSrc, markProviderIconMissing } from "@/shared/utils/providerIcon";
import { getProviderBrand, resolveProviderId } from "@/shared/constants/providerBrands";
import { EDGE_STATE_LABEL, WINDOW_MS } from "@/lib/home/liveRoutes";
import { formatCompact, formatReset, timeAgo } from "./format";
import { WidgetEmpty, WidgetError, WidgetSkeleton } from "./WidgetStates";
import {
  bezier,
  COLUMN_X,
  columnHeight,
  HUB_H,
  NODE_H,
  NODE_W,
  rowCenter,
  SVG_W,
  svgHeight,
} from "./liveRoutesLayout";

const EDGE_STYLE = {
  flowing: { stroke: "var(--signal-lime-ink)", dash: "6 8", animated: true },
  cooling: { stroke: "var(--signal-warn)", dash: "3 6", animated: false },
  idle: { stroke: "var(--signal-line)", dash: null, animated: false },
  error: { stroke: "var(--signal-err)", dash: null, animated: false },
};

/**
 * @param {string} state edge state
 * @returns {{ stroke: string, dash: string|null, animated: boolean }}
 */
export function edgeStyle(state) {
  return EDGE_STYLE[state] || EDGE_STYLE.idle;
}

/**
 * Plain-language fallback banner text.
 * @param {{ fromName: string, toName: string, cooldownUntil: string|null }} fallback
 * @param {number} [nowMs]
 * @returns {string} plain English literal
 */
export function fallbackText(fallback, nowMs = Date.now()) {
  const left = formatReset(fallback?.cooldownUntil, nowMs);
  const tail = left ? ` (${left.charAt(0).toLowerCase()}${left.slice(1)})` : " while it cools down";
  return `${fallback.fromName} hit a rate limit. Its traffic is falling back to ${fallback.toName}${tail}.`;
}

function ClientNode({ x, y, client }) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={NODE_W.client}
        height={NODE_H}
        rx={10}
        fill="none"
        stroke="var(--signal-line)"
      />
      <text x={x + 12} y={y + 21} fill="var(--signal-text)" fontSize="12" fontWeight="500">
        {client.id.length > 18 ? `${client.id.slice(0, 17)}…` : client.id}
      </text>
      <text
        x={x + NODE_W.client - 10}
        y={y + 21}
        textAnchor="end"
        fill="var(--signal-muted)"
        fontSize="11"
        fontFamily="var(--signal-font-mono)"
      >
        {formatCompact(client.count)}
      </text>
    </g>
  );
}

ClientNode.propTypes = {
  x: PropTypes.number.isRequired,
  y: PropTypes.number.isRequired,
  client: PropTypes.shape({
    id: PropTypes.string.isRequired,
    count: PropTypes.number.isRequired,
  }).isRequired,
};

function ProviderNode({ x, y, provider }) {
  const id = resolveProviderId(provider.id);
  const brand = getProviderBrand(id);
  const [logoMissing, setLogoMissing] = useState(false);
  const logo = logoMissing ? null : getProviderIconSrc(id);
  const plateY = y + (NODE_H - 22) / 2;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={NODE_W.provider}
        height={NODE_H}
        rx={10}
        fill="none"
        stroke={
          provider.state === "cooling"
            ? "var(--signal-warn)"
            : provider.state === "error"
              ? "var(--signal-err)"
              : "var(--signal-line)"
        }
      />
      <circle
        cx={x + 16}
        cy={y + NODE_H / 2}
        r={5}
        fill={
          provider.state === "flowing"
            ? "var(--signal-lime)"
            : provider.state === "cooling"
              ? "var(--signal-warn)"
              : provider.state === "error"
                ? "var(--signal-err)"
                : "var(--signal-line)"
        }
      />
      {/* Brand plate behind the logo keeps dark glyph logos visible on dark panels. */}
      <rect
        x={x + 28}
        y={plateY}
        width={22}
        height={22}
        rx={6}
        fill={logo ? `color-mix(in srgb, ${brand.color} 8%, #ffffff)` : brand.color}
      />
      {logo ? (
        <image
          href={logo}
          x={x + 28}
          y={plateY}
          width={22}
          height={22}
          style={{ clipPath: "inset(0 round 6px)" }}
          preserveAspectRatio="xMidYMid meet"
          onError={() => {
            markProviderIconMissing(id);
            setLogoMissing(true);
          }}
        />
      ) : (
        <text
          x={x + 39}
          y={y + NODE_H / 2 + 3.5}
          textAnchor="middle"
          fontSize="9"
          fontWeight="700"
          fill="#ffffff"
        >
          {brand.monogram}
        </text>
      )}
      <text x={x + 58} y={y + 21} fill="var(--signal-text)" fontSize="12" fontWeight="500">
        {provider.name.length > 16 ? `${provider.name.slice(0, 15)}…` : provider.name}
      </text>
      {provider.state === "error" || provider.state === "cooling" ? (
        <text
          x={x + NODE_W.provider - 10}
          y={y + 21}
          textAnchor="end"
          fontSize="11"
          fontWeight="600"
          fontFamily="var(--signal-font-mono)"
          fill={provider.state === "error" ? "var(--signal-err)" : "var(--signal-warn)"}
        >
          {provider.code || (provider.state === "error" ? "ERR" : "429")}
        </text>
      ) : (
        <circle cx={x + NODE_W.provider - 14} cy={y + NODE_H / 2} r={4} fill="var(--signal-ok)" />
      )}
      <title>{`${provider.name}: ${EDGE_STATE_LABEL[provider.state] || provider.state}`}</title>
    </g>
  );
}

ProviderNode.propTypes = {
  x: PropTypes.number.isRequired,
  y: PropTypes.number.isRequired,
  provider: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    state: PropTypes.string.isRequired,
    code: PropTypes.string,
  }).isRequired,
};

/**
 * Live routes map: clients → 9router → providers over the last 5 minutes.
 * Plain SVG (no @xyflow/react): static three-column flow, no pan/zoom.
 *
 * @param {object} props
 * @param {object|null} props.routes flow model from /api/home/live-routes
 * @param {boolean} props.loading
 * @param {string|null} props.error
 * @param {() => void} props.onRetry
 */
export default function LiveRoutes({ routes, loading, error, onRetry }) {
  // Stale data stays visible under a poll error (the hook preserves it); only
  // error out when there is nothing to show yet.
  if (loading && !routes) return <WidgetSkeleton lines={5} label="Loading live routes" />;
  if (error && !routes) return <WidgetError message={error} onRetry={onRetry} />;

  const clients = routes?.clients || [];
  const providers = routes?.providers || [];
  const edges = routes?.edges || [];
  const fallbacks = routes?.fallbacks || [];

  if (clients.length === 0 && providers.every((p) => p.count === 0)) {
    return (
      <WidgetEmpty
        icon="route"
        title="No traffic in the last 5 minutes"
        body="Point a client at your endpoint and send a request to see live routes."
        actionLabel="View endpoint"
        actionHref="/dashboard/endpoint"
      />
    );
  }

  const rows = Math.max(clients.length, providers.length, 1);
  const height = svgHeight(rows);
  const routerY = height / 2;
  // Center a shorter column on the hub so single rows line up with the 9 node.
  const columnOffset = (count) => (height - columnHeight(count)) / 2;
  const clientY = (i) => columnOffset(clients.length) + rowCenter(i);
  const providerY = (i) => columnOffset(providers.length) + rowCenter(i);
  const clientIndex = new Map(clients.map((c, i) => [c.id, i]));
  const providerIndex = new Map(providers.map((p, i) => [p.id, i]));
  const fallback = fallbacks[0] || null;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {error && routes ? (
        <p role="status" className="text-xs text-warn">
          Live update failed. Showing last known routes.{" "}
          <button type="button" onClick={onRetry} className="font-semibold underline">
            Retry
          </button>
        </p>
      ) : null}
      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted"
        aria-hidden="true"
      >
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 bg-lime-ink" /> Flowing
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 bg-warn" /> Cooling down
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 bg-line" /> Idle
        </span>
      </div>
      <figure aria-describedby="live-routes-table" className="min-w-0 overflow-x-auto" dir="ltr">
        {/* Absolute geometry stays LTR; on narrow screens scroll instead of shrinking labels. */}
        <svg
          viewBox={`0 0 ${SVG_W} ${height}`}
          role="img"
          aria-label={`Live routes over the last 5 minutes: ${clients.length} clients, ${providers.length} providers.`}
          className="block h-auto w-full min-w-[560px]"
          style={{ minHeight: height, direction: "ltr" }}
        >
          {edges.map((edge, i) => {
            const style = edgeStyle(edge.state);
            const ci = clientIndex.get(edge.from) ?? 0;
            const pi = providerIndex.get(edge.to) ?? 0;
            const leftIn = COLUMN_X.router;
            return (
              <g key={`${edge.from}|${edge.to}`}>
                <path
                  d={bezier(COLUMN_X.client + NODE_W.client, clientY(ci), leftIn, routerY)}
                  fill="none"
                  stroke={style.stroke}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeDasharray={style.dash || undefined}
                  className={style.animated ? "motion-safe:animate-flow" : undefined}
                />
                <path
                  d={bezier(
                    COLUMN_X.router + NODE_W.hub,
                    routerY,
                    COLUMN_X.provider,
                    providerY(pi),
                  )}
                  fill="none"
                  stroke={style.stroke}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeDasharray={style.dash || undefined}
                  className={style.animated ? "motion-safe:animate-flow" : undefined}
                >
                  <title>{`${edge.from} to ${edge.to}: ${EDGE_STATE_LABEL[edge.state]}, ${edge.count} requests`}</title>
                </path>
                <title>{`edge-${i}`}</title>
              </g>
            );
          })}
          {clients.map((client, i) => (
            <ClientNode
              key={client.id}
              x={COLUMN_X.client}
              y={clientY(i) - NODE_H / 2}
              client={client}
            />
          ))}
          <g>
            <rect
              x={COLUMN_X.router}
              y={routerY - HUB_H / 2}
              width={NODE_W.hub}
              height={HUB_H}
              rx={28}
              fill="var(--signal-coral)"
            />
            <text
              x={COLUMN_X.router + NODE_W.hub / 2}
              y={routerY - 2}
              textAnchor="middle"
              fill="#FFFFFF"
              fontSize="42"
              fontWeight="800"
              fontFamily="var(--signal-font-display)"
            >
              9
            </text>
            <text
              x={COLUMN_X.router + NODE_W.hub / 2}
              y={routerY + 22}
              textAnchor="middle"
              fill="#FFFFFF"
              fontSize="11"
              fontWeight="700"
              letterSpacing="1.1"
            >
              router
            </text>
          </g>
          {providers.map((provider, i) => (
            <ProviderNode
              key={provider.id}
              x={COLUMN_X.provider}
              y={providerY(i) - NODE_H / 2}
              provider={provider}
            />
          ))}
        </svg>
        <figcaption className="sr-only">
          {edges.length === 0
            ? "No routes in the last 5 minutes."
            : edges
                .map(
                  (edge) =>
                    `${edge.from} to ${edge.to}: ${EDGE_STATE_LABEL[edge.state] || edge.state}, ${edge.count} requests, last ${timeAgo(edge.lastAt)}.`,
                )
                .join(" ")}
        </figcaption>
      </figure>
      <table id="live-routes-table" className="sr-only">
        <caption>Live routes over the last 5 minutes</caption>
        <thead>
          <tr>
            <th scope="col">Client</th>
            <th scope="col">Provider</th>
            <th scope="col">State</th>
            <th scope="col">Requests</th>
          </tr>
        </thead>
        <tbody>
          {edges.map((edge) => (
            <tr key={`${edge.from}|${edge.to}`}>
              <td>{edge.from}</td>
              <td>{edge.to}</td>
              <td>{EDGE_STATE_LABEL[edge.state] || edge.state}</td>
              <td>{edge.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {fallback ? (
        <Callout variant="warn">
          <span className="flex w-full flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 flex-1" dir="auto">
              {fallbackText(fallback)}
            </span>
            <a
              href="/dashboard/providers"
              className="shrink-0 font-semibold whitespace-nowrap text-warn hover:underline"
            >
              Inspect →
            </a>
          </span>
        </Callout>
      ) : null}
    </div>
  );
}

LiveRoutes.propTypes = {
  routes: PropTypes.shape({
    clients: PropTypes.arrayOf(PropTypes.object),
    providers: PropTypes.arrayOf(PropTypes.object),
    edges: PropTypes.arrayOf(PropTypes.object),
    fallbacks: PropTypes.arrayOf(PropTypes.object),
  }),
  loading: PropTypes.bool,
  error: PropTypes.string,
  onRetry: PropTypes.func.isRequired,
};

export { WINDOW_MS };
