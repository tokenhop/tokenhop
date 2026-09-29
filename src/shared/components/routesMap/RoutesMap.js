"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import Button from "@/shared/components/Button";
import Callout from "@/shared/components/Callout";
import CardLink from "@/shared/components/CardLink";
import EmptyState from "@/shared/components/EmptyState";
import { LoadingState, ErrorState } from "@/shared/components/StateViews";
import { getCurrentLocale, onLocaleChange } from "@/i18n/runtime";
import {
  capProviders,
  EDGE_STATE_LABEL,
  edgeLabel,
  fallbackText,
  idleCaption,
  isIdle,
} from "@/shared/utils/routesMap";
import { COMPACT_PROVIDER_CAP } from "./layout";
import {
  bezier,
  COLUMN_X,
  columnHeight,
  NODE_H,
  NODE_W,
  rowCenter,
  SVG_W,
  svgHeight,
} from "./layout";
import { ClientNode, HubNode, ProviderNode } from "./nodes";
import { RouteEdge } from "./RouteEdge";

/**
 * Shared routes map: clients → 9router → providers over the last 5 minutes.
 * Plain SVG (no pan/zoom): Home uses the compact variant, Usage the full one.
 * Connected providers with no traffic render as muted idle nodes with idle
 * edges plus a last-activity caption — the true empty state only fires when
 * no provider is connected at all.
 *
 * @param {object} props
 * @param {object|null} props.routes flow model from /api/home/live-routes (Usage merges its provider list in first)
 * @param {boolean} props.loading
 * @param {string|null} props.error
 * @param {() => void} props.onRetry
 * @param {boolean} [props.compact] cap idle provider rows for the Home widget
 * @param {string|null|undefined} [props.lastRequestAt] last recorded request time (undefined while loading)
 * @param {string|null} [props.lastActivityError] last-activity fetch error
 * @param {() => void} [props.onRetryLastActivity]
 */
export default function RoutesMap({
  routes,
  loading,
  error,
  onRetry,
  compact = false,
  lastRequestAt,
  lastActivityError,
  onRetryLastActivity,
}) {
  const [locale, setLocale] = useState("en");
  // The caption follows the runtime locale (same pattern as QuietPeriod).
  useEffect(() => {
    setLocale(getCurrentLocale());
    return onLocaleChange(() => setLocale(getCurrentLocale()));
  }, []);

  // Stale data stays visible under a poll error (the hook preserves it); only
  // error out when there is nothing to show yet.
  if (loading && !routes) return <LoadingState label="Loading live routes" />;
  if (error && !routes)
    return <ErrorState title="Could not load this widget" message={error} onRetry={onRetry} />;

  const model = routes || { clients: [], providers: [], edges: [], fallbacks: [] };
  const capped = compact ? capProviders(model, COMPACT_PROVIDER_CAP) : model;
  const clients = model.clients || [];
  const providers = capped.providers || [];
  const edges = capped.edges || [];
  const fallbacks = model.fallbacks || [];
  const hiddenProviders = capped.hiddenProviders || 0;
  const idle = isIdle(model);

  if (providers.length === 0) {
    return (
      <EmptyState
        as="h3"
        icon="route"
        title="No providers connected"
        body="Add a provider so traffic has somewhere to go."
        action={
          <Button
            variant="secondary"
            size="sm"
            href="/dashboard/providers"
            iconRight="arrow_forward"
          >
            Add a provider
          </Button>
        }
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
  const caption = idleCaption(lastRequestAt, locale);
  const clientMidX = (COLUMN_X.client + NODE_W.client + COLUMN_X.router) / 2;
  const hubOut = COLUMN_X.router + NODE_W.hub;

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
      <figure aria-describedby="routes-map-table" className="min-w-0 overflow-x-auto" dir="ltr">
        {/* Absolute geometry stays LTR; on narrow screens scroll instead of shrinking labels. */}
        {/* biome-ignore lint/a11y/useSemanticElements: SVG is not a fieldset; role="group" (not "img") exposes the focusable per-edge img groups (YAN-412 review). */}
        <svg
          viewBox={`0 0 ${SVG_W} ${height}`}
          role="group"
          aria-label={`Routes over the last 5 minutes: ${clients.length} clients, ${providers.length} providers.`}
          className="block h-auto w-full min-w-[560px]"
          style={{ minHeight: height, direction: "ltr" }}
        >
          {edges.map((edge) => {
            const ci = clientIndex.get(edge.from) ?? 0;
            const pi = providerIndex.get(edge.to) ?? 0;
            const clientTop = clientY(ci);
            const providerTop = providerY(pi);
            // Idle provider edges hang off the hub so the provider column
            // stays visible even with zero client traffic.
            const segments =
              edge.from == null
                ? [bezier(hubOut, routerY, COLUMN_X.provider, providerTop)]
                : [
                    bezier(COLUMN_X.client + NODE_W.client, clientTop, COLUMN_X.router, routerY),
                    bezier(hubOut, routerY, COLUMN_X.provider, providerTop),
                  ];
            const labelX = edge.from == null ? (hubOut + COLUMN_X.provider) / 2 : clientMidX;
            const labelY =
              edge.from == null
                ? Math.min(routerY, providerTop) - 10
                : Math.min(clientTop, routerY) - 10;
            return (
              <RouteEdge
                key={`${edge.from}|${edge.to}`}
                edge={edge}
                segments={segments}
                labelX={labelX}
                labelY={labelY}
              />
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
          <HubNode x={COLUMN_X.router} y={routerY} />
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
            : edges.map((edge) => edgeLabel(edge)).join(" ")}
        </figcaption>
      </figure>
      {idle ? (
        lastActivityError && lastRequestAt === undefined ? (
          <p role="status" className="text-xs text-muted">
            Couldn't load the last request time.{" "}
            {onRetryLastActivity ? (
              <button
                type="button"
                onClick={onRetryLastActivity}
                className="font-semibold underline"
              >
                Retry
              </button>
            ) : null}
          </p>
        ) : caption ? (
          <p className="text-xs text-muted">{caption}</p>
        ) : null
      ) : null}
      {hiddenProviders > 0 ? (
        // Count line follows the "Show all N" pattern: interpolated, stays English.
        <p className="text-xs text-muted">{`+${hiddenProviders} more idle providers`}</p>
      ) : null}
      <table id="routes-map-table" className="sr-only">
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
            <CardLink
              href="/dashboard/providers"
              className="shrink-0 font-semibold whitespace-nowrap text-warn hover:underline"
            >
              Inspect
            </CardLink>
          </span>
        </Callout>
      ) : null}
    </div>
  );
}

RoutesMap.propTypes = {
  routes: PropTypes.shape({
    clients: PropTypes.arrayOf(PropTypes.object),
    providers: PropTypes.arrayOf(PropTypes.object),
    edges: PropTypes.arrayOf(PropTypes.object),
    fallbacks: PropTypes.arrayOf(PropTypes.object),
  }),
  loading: PropTypes.bool,
  error: PropTypes.string,
  onRetry: PropTypes.func.isRequired,
  compact: PropTypes.bool,
  lastRequestAt: PropTypes.string,
  lastActivityError: PropTypes.string,
  onRetryLastActivity: PropTypes.func,
};
