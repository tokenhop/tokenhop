"use client";

import PropTypes from "prop-types";
import { memo, useCallback } from "react";
import { Button, EmptyState, ProviderTile, StatusPill } from "@/shared/components";
import { providerHealth } from "@/shared/utils/providerHealth";

const CATALOG_HEADING_ID = "providers-catalog";

/** Worst quota hint across the provider's connections; null when unmetered. */
function quotaLeft(connections) {
  let min = null;
  for (const c of connections) {
    if (typeof c?.quotaRemaining !== "number") continue;
    if (min === null || c.quotaRemaining < min) min = c.quotaRemaining;
  }
  return min;
}

function rowStatus(entry, health) {
  if (entry.stats.allDisabled) return { variant: "neutral", label: "Disabled", dot: false };
  if (health.status === "err") {
    if (health.outOfCredit) return { variant: "err", label: "Out of credit", dot: true };
    const code = entry.stats.errorCode ? ` (${entry.stats.errorCode})` : "";
    return { variant: "err", label: `${health.counts.err} Error${code}`, dot: true };
  }
  if (health.status === "warn" && health.until)
    return { variant: "warn", label: "Cooldown", dot: true };
  if (health.status === "warn" && health.reason)
    return { variant: "warn", label: health.reason, dot: true };
  return { variant: "ok", label: "Connected", dot: true };
}

function tileStatus(entry, health) {
  if (entry.stats.allDisabled) return "neutral";
  if (health.status === "err") return "err";
  if (health.status === "warn") return "warn";
  return health.connected ? "ok" : "neutral";
}

/** One compact pinned row: full-row toggle button plus a sibling Test button. */
const YourProviderRow = memo(function YourProviderRow({
  entry,
  connections,
  selected,
  testing,
  batchTesting,
  onOpen,
  onClose,
  onTest,
}) {
  const enabled = connections.filter((c) => c.isActive !== false);
  const health = providerHealth(enabled);
  // The pill already says "Out of credit", so the reason line explains the effect instead.
  const reason = entry.stats.allDisabled
    ? "Disabled"
    : health.outOfCredit
      ? "Requests are skipping this provider"
      : health.reason || "Ready";
  const status = rowStatus(entry, health);
  const quota = quotaLeft(enabled);
  const name = entry.info.name;

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-stretch gap-2 sm:items-center">
      <button
        type="button"
        onClick={() => (selected ? onClose() : onOpen(entry))}
        aria-expanded={selected}
        aria-label={selected ? `Close ${name} details` : `Open ${name} details`}
        className={`flex min-w-0 flex-col gap-2 rounded-2xl border bg-panel p-4 text-start shadow-card transition-colors hover:border-subtle focus-visible:outline-none focus-visible:shadow-focus sm:flex-row sm:items-center sm:gap-3 ${
          selected ? "border-coral shadow-[0_0_0_3px_var(--signal-coral-bg)]" : "border-line"
        }`}
      >
        <span className="flex min-w-0 items-center gap-3">
          <ProviderTile providerId={entry.id} size="md" status={tileStatus(entry, health)} />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-[15px] font-semibold">{name}</span>
            <span className="truncate text-[13px] text-muted">
              {`${connections.length} ${connections.length === 1 ? "account" : "accounts"}`}
              {quota !== null && ` · ${quota}% quota left`}
            </span>
          </span>
        </span>
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:justify-end">
          <span className="min-w-0 truncate text-[13px] text-muted">{reason}</span>
          <StatusPill variant={status.variant} size="sm" dot={status.dot}>
            {status.label}
          </StatusPill>
        </span>
      </button>
      <Button
        size="sm"
        variant="secondary"
        loading={testing}
        disabled={testing || batchTesting}
        onClick={() => onTest(entry)}
        aria-label={`Test ${name} accounts`}
      >
        {testing ? "Testing…" : "Test"}
      </Button>
    </li>
  );
});

YourProviderRow.propTypes = {
  entry: PropTypes.object.isRequired,
  connections: PropTypes.array.isRequired,
  selected: PropTypes.bool,
  testing: PropTypes.bool,
  batchTesting: PropTypes.bool,
  onOpen: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
  onTest: PropTypes.func.isRequired,
};

/** First-run guide pointing at the catalog. */
function ConnectFirstGuide() {
  const browse = useCallback(() => {
    const heading = document.getElementById(CATALOG_HEADING_ID);
    if (!heading) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    heading.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start",
    });
    heading.focus({ preventScroll: true });
  }, []);

  return (
    <div className="rounded-2xl border border-dashed border-line bg-panel shadow-card">
      <EmptyState
        icon="link"
        title="Connect your first provider"
        body="Pick a provider below and sign in or paste a key. It shows up here once it's connected."
        action={
          <Button size="sm" variant="secondary" onClick={browse}>
            Browse providers
          </Button>
        }
      />
    </div>
  );
}

/**
 * Pinned list of the viewer's connected providers with health reason, quota
 * hint, per-row Test and the single section-level Test all. Hidden entirely
 * when a search or filter empties it; a guide replaces it on a fresh install.
 *
 * @param {object} props
 * @param {object[]} props.entries Filtered "your provider" entries.
 * @param {number} props.total Unfiltered count of the viewer's providers.
 * @param {(entry: object) => object[]} props.connectionsFor Entry-scoped connections.
 * @param {string} props.selectedProvider
 * @param {string|null} props.testingMode
 * @param {string|null} props.testAccountsMode
 * @param {(entry: object) => void} props.onOpen
 * @param {() => void} props.onClose
 * @param {(entry: object) => void} props.onTest
 * @param {() => void} props.onTestAll
 */
function YourProviders({
  entries,
  total,
  connectionsFor,
  selectedProvider,
  testingMode,
  testAccountsMode,
  onOpen,
  onClose,
  onTest,
  onTestAll,
}) {
  if (total === 0) return <ConnectFirstGuide />;
  if (entries.length === 0) return null;

  return (
    <section aria-labelledby="providers-yours" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id="providers-yours" className="font-display text-xl font-bold lg:text-[22px]">
          Your providers
        </h2>
        <span className="text-[13px] text-muted">
          {total} {total === 1 ? "provider" : "providers"}
        </span>
        <Button
          size="sm"
          variant="secondary"
          icon="play_arrow"
          className="ms-auto"
          loading={testingMode === "all"}
          disabled={!!testingMode || !!testAccountsMode}
          onClick={onTestAll}
          title="Test all connections"
        >
          {testingMode === "all" ? "Testing…" : "Test all"}
        </Button>
      </div>
      <ul className="flex flex-col gap-2">
        {entries.map((entry) => (
          <YourProviderRow
            key={entry.id}
            entry={entry}
            connections={connectionsFor(entry)}
            selected={selectedProvider === entry.id}
            testing={testAccountsMode === entry.id}
            batchTesting={!!testingMode}
            onOpen={onOpen}
            onClose={onClose}
            onTest={onTest}
          />
        ))}
      </ul>
    </section>
  );
}

YourProviders.propTypes = {
  entries: PropTypes.array.isRequired,
  total: PropTypes.number.isRequired,
  connectionsFor: PropTypes.func.isRequired,
  selectedProvider: PropTypes.string,
  testingMode: PropTypes.string,
  testAccountsMode: PropTypes.string,
  onOpen: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
  onTest: PropTypes.func.isRequired,
  onTestAll: PropTypes.func.isRequired,
};

export default memo(YourProviders);
