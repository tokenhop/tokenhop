"use client";

import PropTypes from "prop-types";
import Link from "next/link";
import Button from "@/shared/components/Button";
import Card from "@/shared/components/Card";
import Checkbox from "@/shared/components/Checkbox";
import StatusPill from "@/shared/components/StatusPill";
import IconButton from "@/shared/components/IconButton";
import Toggle from "@/shared/components/Toggle";
import Callout from "@/shared/components/Callout";
import EmptyState from "@/shared/components/EmptyState";
import { Skeleton } from "@/shared/components/Loading";
import { maskProxyUrl } from "@/shared/utils/proxyPools";

const RELAY_TYPES = new Set(["vercel", "cloudflare", "deno"]);

function healthPill(pool) {
  if (pool.testStatus === "active") {
    return (
      <StatusPill variant="ok" size="sm" dot>
        {pool.elapsedMs ? `Healthy · ${pool.elapsedMs}ms` : "Healthy"}
      </StatusPill>
    );
  }
  if (pool.testStatus === "error") {
    return (
      <StatusPill variant="err" size="sm" dot className="max-w-64">
        <span className="truncate" title={pool.lastError || undefined}>
          {pool.lastError ? `Error · ${pool.lastError}` : "Error"}
        </span>
      </StatusPill>
    );
  }
  return (
    <StatusPill variant="neutral" size="sm">
      Untested
    </StatusPill>
  );
}

/**
 * Proxy pool list card with bulk selection, per-row actions, and the
 * Settings → Network callout.
 */
export default function PoolList({
  pools = [],
  loading = false,
  error = null,
  selectedIds = [],
  onToggleSelect,
  onToggleSelectAll,
  allSelected = false,
  someSelected = false,
  selectionBar = null,
  onToggleActive,
  onTest,
  testingId = null,
  onEdit,
  onDelete,
  onAdd,
}) {
  if (loading) {
    return (
      <Card padding="md" role="status" aria-busy="true" aria-label="Loading proxy pools">
        <div className="flex flex-col gap-3">
          {["sk-1", "sk-2", "sk-3", "sk-4"].map((key) => (
            <Skeleton key={key} className="h-16 w-full" />
          ))}
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card padding="md">
        <Callout variant="err" title="Couldn't load proxy pools">
          {error}
        </Callout>
      </Card>
    );
  }

  const activeCount = pools.filter((p) => p.isActive).length;

  return (
    <Card padding="md">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Checkbox
          checked={allSelected}
          indeterminate={someSelected}
          onChange={onToggleSelectAll}
          aria-label="Select all pools"
          disabled={pools.length === 0}
        />
        <h2 className="font-display text-xl font-bold text-text">Pools</h2>
        <StatusPill variant="neutral" size="sm">
          {pools.length} total
        </StatusPill>
        <StatusPill variant="ok" size="sm">
          {activeCount} active
        </StatusPill>
      </div>

      {selectionBar}

      {pools.length === 0 ? (
        <EmptyState
          icon="lan"
          title="No proxies yet"
          body="Add a proxy pool, deploy a free relay, or batch-import a list. Then bind it from any provider connection."
          action={
            <Button variant="primary" size="sm" icon="add" onClick={onAdd}>
              Add proxy
            </Button>
          }
        />
      ) : (
        <ul className="flex list-none flex-col p-0" aria-label="Proxy pools">
          {pools.map((pool) => (
            <li
              key={pool.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line py-3.5 first:border-t-0"
            >
              <Checkbox
                checked={selectedIds.includes(pool.id)}
                onChange={() => onToggleSelect(pool.id)}
                aria-label={`Select ${pool.name}`}
              />
              <div className="flex min-w-0 w-full flex-1 basis-48 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-all text-[15px] font-semibold text-text">{pool.name}</span>
                  <StatusPill variant="neutral" size="sm">
                    {RELAY_TYPES.has(pool.type) ? "Relay" : "HTTP"}
                  </StatusPill>
                  {pool.strictProxy ? (
                    <StatusPill variant="brand" size="sm">
                      Strict
                    </StatusPill>
                  ) : null}
                </div>
                <span className="truncate font-mono text-xs text-muted" dir="ltr">
                  {maskProxyUrl(pool.proxyUrl)}
                </span>
                {pool.noProxy ? (
                  <span className="truncate text-xs text-muted">No proxy: {pool.noProxy}</span>
                ) : null}
                <span className="text-[11px] text-subtle">
                  {pool.lastTestedAt
                    ? `Last tested ${new Date(pool.lastTestedAt).toLocaleString()}`
                    : "Never tested"}
                </span>
              </div>
              {healthPill(pool)}
              <span className="hidden min-w-28 shrink-0 text-[13px] text-muted lg:inline">
                {pool.boundConnectionCount > 0
                  ? `${pool.boundConnectionCount} connection${pool.boundConnectionCount === 1 ? "" : "s"}`
                  : "Not assigned"}
              </span>
              <div className="ms-auto flex shrink-0 items-center gap-1.5 sm:ms-0">
                <Toggle
                  checked={pool.isActive}
                  onChange={() => onToggleActive(pool)}
                  aria-label={`Pool ${pool.isActive ? "active" : "inactive"}: ${pool.name}`}
                  size="sm"
                />
                <IconButton
                  icon="science"
                  label={`Test ${pool.name}`}
                  loading={testingId === pool.id}
                  onClick={() => onTest(pool)}
                />
                <IconButton icon="edit" label={`Edit ${pool.name}`} onClick={() => onEdit(pool)} />
                <IconButton
                  icon="delete"
                  label={`Delete ${pool.name}`}
                  onClick={() => onDelete(pool)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3">
        <Callout variant="info">
          Assign a pool to any connection from its provider page. The global outbound proxy lives in{" "}
          <Link href="/dashboard/profile">Settings → Network</Link>.
        </Callout>
      </div>
    </Card>
  );
}

PoolList.propTypes = {
  pools: PropTypes.arrayOf(PropTypes.object),
  loading: PropTypes.bool,
  error: PropTypes.string,
  selectedIds: PropTypes.arrayOf(PropTypes.string),
  onToggleSelect: PropTypes.func.isRequired,
  onToggleSelectAll: PropTypes.func.isRequired,
  allSelected: PropTypes.bool,
  someSelected: PropTypes.bool,
  selectionBar: PropTypes.node,
  onToggleActive: PropTypes.func.isRequired,
  onTest: PropTypes.func.isRequired,
  testingId: PropTypes.string,
  onEdit: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
  onAdd: PropTypes.func.isRequired,
};
