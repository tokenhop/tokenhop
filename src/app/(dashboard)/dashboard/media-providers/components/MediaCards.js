"use client";

import Link from "next/link";
import PropTypes from "prop-types";
import {
  Card,
  StatusPill,
  Toggle,
  EmptyState,
  Skeleton,
  ProviderTile,
  ModelChip,
  Button,
} from "@/shared/components";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getProviderBrand } from "@/shared/constants/providerBrands";
import { getMediaProviderStatus, resolveToggleAction } from "@/shared/constants/mediaStatus";

/**
 * Media provider card with Signal styling: provider tile, name, status pill,
 * supported models in mono, and hover/focus enable toggle (YAN-305).
 *
 * @param {object} props
 * @param {object} props.provider Provider object with id, name, models.
 * @param {string} props.kind Kind slug.
 * @param {Array<object>} props.connections List of provider connections.
 * @param {boolean} [props.isCustom=false] Custom embedding flag.
 * @param {(providerId: string, newActive: boolean) => Promise<void>} [props.onToggle]
 */
export function MediaProviderCard({ provider, kind, connections, isCustom = false, onToggle }) {
  const providerInfo = AI_PROVIDERS[provider.id];
  const isNoAuth = !!providerInfo?.noAuth;

  const providerConns = (connections || []).filter((c) => c.provider === provider.id);
  const total = providerConns.length;
  const allDisabled = total > 0 && providerConns.every((c) => c.isActive === false);

  const status = getMediaProviderStatus({ isNoAuth, connections: providerConns });
  const toggleLabel = allDisabled ? `Enable ${provider.name}` : `Disable ${provider.name}`;

  // Single semantic handler: the Toggle switch owns the click. The wrapper
  // div only stops propagation so the card link does not navigate; keyboard
  // and click activation both flow through the single Toggle onChange below.
  // resolveToggleAction guarantees exactly one onToggle call per activation.
  // (Same propagation-guard pattern as dashboard/providers ProviderCard.)
  const handleToggle = (nextChecked) => {
    const action = resolveToggleAction({ providerId: provider.id, allDisabled, nextChecked });
    if (action) onToggle?.(action.providerId, action.newActive);
  };

  const handleToggleWrapperClick = (e) => {
    e.stopPropagation();
  };

  return (
    <Link
      href={`/dashboard/media-providers/${kind}/${provider.id}`}
      aria-label={`${provider.name} (${status.label})`}
      className="group block rounded-2xl transition-all duration-150 focus-visible:outline-none focus-visible:shadow-focus"
    >
      <Card
        padding="sm"
        hover
        className={`flex h-full flex-col gap-3.5 p-4 ${allDisabled ? "opacity-60" : ""}`}
      >
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <ProviderTile
              providerId={provider.id}
              size="md"
              status={status.variant === "ok" ? "ok" : status.variant === "err" ? "err" : undefined}
            />
            <div className="min-w-0 flex-1">
              {/* Card link gives the accessible name; the inner name is
                  presentational so SR users hear it once (YAN-314). */}
              <span className="truncate text-[15px] font-semibold text-text" aria-hidden="true">
                {provider.name}
              </span>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {isCustom && (
                  <StatusPill variant="neutral" size="sm">
                    Custom
                  </StatusPill>
                )}
                <StatusPill
                  variant={status.variant}
                  size="sm"
                  dot={status.variant === "ok" || status.variant === "err"}
                >
                  {status.label}
                </StatusPill>
              </div>
            </div>
          </div>
          {total > 0 && (
            <div
              onClick={handleToggleWrapperClick}
              className="shrink-0 rounded-lg p-1 transition-opacity focus-visible:shadow-focus sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
            >
              <Toggle
                size="sm"
                checked={!allDisabled}
                onChange={handleToggle}
                aria-label={toggleLabel}
              />
            </div>
          )}
        </div>
        {/* Supported models in mono — parity from Media.dc.html */}
        {Array.isArray(provider.models) && provider.models.length > 0 && (
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {provider.models.slice(0, 3).map((m) => (
              <ModelChip key={m} model={typeof m === "string" ? m : m.id || m.name} />
            ))}
            {provider.models.length > 3 && (
              <span className="font-mono text-xs text-muted">+{provider.models.length - 3}</span>
            )}
          </div>
        )}
      </Card>
    </Link>
  );
}

MediaProviderCard.propTypes = {
  provider: PropTypes.object.isRequired,
  kind: PropTypes.string.isRequired,
  connections: PropTypes.array,
  isCustom: PropTypes.bool,
  onToggle: PropTypes.func,
};

/**
 * Combo row link card: name, provider tile stack, model count (YAN-305).
 *
 * @param {object} props
 * @param {Array<object>} props.combos Combo list.
 */
export function ComboList({ combos }) {
  if (!combos || combos.length === 0) return null;
  return (
    <ul className="flex list-none flex-col gap-2 p-0" aria-label="Combos">
      {combos.map((combo) => (
        <li key={combo.id}>
          <Link
            href={`/dashboard/media-providers/combo/${combo.id}`}
            className="block rounded-2xl focus-visible:outline-none focus-visible:shadow-focus"
          >
            <Card padding="xs" hover className="p-3.5">
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-coral-bg text-coral-ink">
                  <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                    layers
                  </span>
                </span>
                <code className="min-w-0 flex-1 truncate font-mono text-sm font-medium text-text">
                  {combo.name}
                </code>
                <span className="flex shrink-0 items-center" aria-hidden="true">
                  {(combo.models || []).slice(0, 4).map((entry) => {
                    const pid = typeof entry === "string" ? entry.split("/")[0] : "";
                    return (
                      <span
                        key={entry}
                        title={getProviderBrand(pid)?.monogram || entry}
                        className="-ms-1.5 rounded-full ring-2 ring-panel first:ms-0"
                      >
                        <ProviderTile providerId={pid} size="sm" />
                      </span>
                    );
                  })}
                  {(combo.models || []).length > 4 && (
                    <span className="ms-1 font-mono text-[11px] text-muted">
                      +{(combo.models || []).length - 4}
                    </span>
                  )}
                </span>
                <span className="shrink-0 font-mono text-xs text-muted">
                  {(combo.models || []).length}
                </span>
                <span
                  className="material-symbols-outlined shrink-0 text-[18px] text-muted rtl:rotate-180"
                  aria-hidden="true"
                >
                  chevron_right
                </span>
              </span>
            </Card>
          </Link>
        </li>
      ))}
    </ul>
  );
}

ComboList.propTypes = {
  combos: PropTypes.array,
};

/**
 * Media provider grid with loading/empty/error states (YAN-305).
 */
export function MediaProviderGrid({
  providers,
  kind,
  connections,
  loading = false,
  error = "",
  onRetry,
  onToggle,
  emptyTitle,
  emptyBody,
  emptyAction,
}) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2" aria-busy="true">
        <span className="sr-only" role="status">
          Loading providers
        </span>
        {["a", "b", "c", "d", "e", "f"].map((key) => (
          <div
            key={`skeleton-${key}`}
            className="rounded-2xl border border-line bg-panel p-4 shadow-card"
            aria-hidden="true"
          >
            <div className="flex items-center gap-3">
              <Skeleton className="size-9 rounded-[10px]" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-5 w-24 rounded-full" />
              </div>
            </div>
            <Skeleton className="mt-3 h-6 w-full rounded-md" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Card padding="md" className="text-center">
        <p className="text-sm font-medium text-err" role="alert">
          {error}
        </p>
        {onRetry && (
          <Button size="sm" variant="secondary" icon="refresh" onClick={onRetry} className="mt-3">
            Retry
          </Button>
        )}
      </Card>
    );
  }

  if (!providers || providers.length === 0) {
    return (
      <Card padding="none">
        <EmptyState
          icon="perm_media"
          title={emptyTitle || "No providers support this kind yet"}
          body={emptyBody}
          action={emptyAction}
        />
      </Card>
    );
  }

  return (
    <ul className="grid list-none grid-cols-1 gap-3.5 p-0 sm:grid-cols-2" aria-label="Providers">
      {providers.map((provider) => (
        <li key={provider.id} className="min-w-0">
          <MediaProviderCard
            provider={provider}
            kind={kind}
            connections={connections}
            isCustom={!!provider.isCustom}
            onToggle={onToggle}
          />
        </li>
      ))}
    </ul>
  );
}

MediaProviderGrid.propTypes = {
  providers: PropTypes.array,
  kind: PropTypes.string.isRequired,
  connections: PropTypes.array,
  loading: PropTypes.bool,
  error: PropTypes.string,
  onRetry: PropTypes.func,
  onToggle: PropTypes.func,
  emptyTitle: PropTypes.node,
  emptyBody: PropTypes.node,
  emptyAction: PropTypes.node,
};
