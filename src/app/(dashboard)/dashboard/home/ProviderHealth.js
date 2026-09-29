"use client";

import Link from "next/link";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import CardLink from "@/shared/components/CardLink";
import ProviderTile from "@/shared/components/ProviderTile";
import { deriveCommandCenterStatus } from "@/shared/utils/commandCenter";
import { summarizeProviders } from "@/shared/utils/providerHealth";
import { WidgetEmpty, WidgetError, WidgetSkeleton } from "./WidgetStates";

/**
 * Provider health: monogram tile grid with status dots plus a
 * "N need attention" link to Providers. Groups one tile per provider id.
 *
 * @param {object} props
 * @param {Array<object>} props.connections provider connections
 * @param {boolean} props.loading
 * @param {string|null} props.error
 * @param {() => void} props.onRetry
 */
export default function ProviderHealth({ connections, loading, error, onRetry }) {
  if (loading) return <WidgetSkeleton lines={3} label="Loading provider health" />;
  if (error) return <WidgetError message={error} onRetry={onRetry} />;
  if (connections.length === 0) {
    return (
      <WidgetEmpty
        icon="dns"
        title="No providers connected"
        body="Add a provider so traffic has somewhere to go."
        actionLabel="Add a provider"
        actionHref="/dashboard/providers"
      />
    );
  }

  const {
    connected,
    needsAttention: attention,
    providers: summary,
  } = summarizeProviders([], connections);
  const providers = summary
    .map((item) => ({ provider: item.id, status: item.status }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
  const statusLine = deriveCommandCenterStatus(
    providers.map((item) => ({ status: item.status === "off" ? "idle" : item.status })),
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-[13px] text-muted">
        {connected} connected<span className="sr-only">. {statusLine}</span>
      </p>
      <ul
        className="grid min-w-0 grid-cols-3 gap-x-2.5 gap-y-3.5 sm:grid-cols-4"
        aria-label="Provider health"
      >
        {providers.slice(0, 12).map((item) => (
          <li key={item.provider} className="flex min-w-0 flex-col items-center gap-1.5">
            <ProviderTile
              providerId={item.provider}
              size="md"
              status={item.status === "off" ? "neutral" : item.status}
            />
            <span
              className="w-full truncate text-center text-[11px] text-muted"
              title={item.provider}
            >
              {item.provider}
            </span>
          </li>
        ))}
      </ul>
      {attention > 0 ? (
        <Link
          href="/dashboard/providers"
          className="flex items-center gap-2.5 rounded-xl bg-err-bg px-3 py-2.5 text-[13px] text-text"
        >
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-err" />
          {attention} {attention === 1 ? "needs" : "need"} attention
          <span className="ms-auto font-semibold text-err">Review</span>
        </Link>
      ) : null}
    </div>
  );
}

ProviderHealth.propTypes = {
  connections: PropTypes.arrayOf(PropTypes.object),
  loading: PropTypes.bool,
  error: PropTypes.string,
  onRetry: PropTypes.func.isRequired,
};

/** Card wrapper so the page grid stays dumb. */
export function ProviderHealthCard(props) {
  return (
    <Card
      className="min-w-0"
      title="Providers"
      action={<CardLink href="/dashboard/providers">Manage</CardLink>}
    >
      <ProviderHealth {...props} />
    </Card>
  );
}
