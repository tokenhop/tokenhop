"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  Modal,
  SegmentedControl,
  NumberStepper,
  StatusPill,
  ConfirmDialog,
} from "@/shared/components";
import { ACCOUNT_STRATEGY_OPTIONS, OAUTH_STICKY_HINT } from "@/shared/constants/accountStrategies";
import { dragMoveIndices } from "../detailUtils";
import SortableConnectionRow from "./SortableConnectionRow";

const SUBSCRIPTION_PROVIDERS = [
  "claude",
  "codex",
  "github",
  "gemini-cli",
  "antigravity",
  "kiro",
  "cursor",
];

/**
 * Signal connections card: toolbar, select-all, sortable priority rows,
 * strategy + sticky controls, summary strip and bulk proxy/delete.
 */
export default function ConnectionsSection({
  providerId,
  auth,
  strategy,
  conn,
  autoPing,
  actions,
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [announcement, setAnnouncement] = useState("");
  const [bulkPoolId, setBulkPoolId] = useState("__none__");

  const {
    connections,
    proxyPools,
    selectedIds,
    allSelected,
    confirmState,
    setConfirmState,
    bulkProxyOpen,
    setBulkProxyOpen,
    bulkProxyUpdating,
    oneByOne,
  } = conn;
  const effectiveStrategy = strategy.providerStrategy || strategy.globalStrategy || "fill-first";
  const usesStickyLimit = effectiveStrategy === "round-robin" || effectiveStrategy === "weighted";
  const showWeighted = effectiveStrategy === "weighted";
  const subscriptionProvider = SUBSCRIPTION_PROVIDERS.includes(providerId);
  // Mirrors src/sse/services/auth.js + accountSelection.js resolution order.
  const hasStickyOverride = strategy.savedSticky !== "";
  const weightedDefault = showWeighted && !subscriptionProvider;
  const effectiveSticky = hasStickyOverride
    ? Number(strategy.savedSticky)
    : weightedDefault
      ? 1
      : Number(strategy.globalSticky ?? 3);
  const stickySource = hasStickyOverride
    ? "provider override"
    : weightedDefault || strategy.globalSticky == null
      ? showWeighted && subscriptionProvider
        ? "default for OAuth"
        : "default"
      : "global";
  const strategySource = strategy.providerStrategy
    ? "provider override"
    : strategy.globalStrategy
      ? "global"
      : "default";
  const strategyLabels = {
    "fill-first": "Fill first",
    "round-robin": "Round robin",
    weighted: "Weighted",
  };
  const effectiveLabel = strategyLabels[effectiveStrategy] || effectiveStrategy;
  const inheritedStickyText = usesStickyLimit
    ? `Effective: ${effectiveLabel} (${strategySource}), sticky ${effectiveSticky} calls per account (${stickySource}).`
    : `Effective: ${effectiveLabel} (${strategySource}).`;
  const activeConnections = connections.filter((entry) => entry.isActive !== false);
  const totalWeight = activeConnections.reduce(
    (sum, entry) => sum + Math.max(0, entry.effectiveWeight?.weight || 0),
    0,
  );
  const strategyOptions = [
    {
      value: "inherit",
      label: `Inherit global (${strategyLabels[strategy.globalStrategy] || "Fill first"})`,
    },
    ...ACCOUNT_STRATEGY_OPTIONS.map((option) => ({
      value: option.value,
      label: strategyLabels[option.value] || option.label.split(" — ")[0],
    })),
  ];
  const selectedConnections = connections.filter((entry) => selectedIds.includes(entry.id));
  const selectedProxySummary = (() => {
    if (selectedConnections.length === 0) return "";
    const poolIds = new Set(
      selectedConnections.map((entry) => entry.providerSpecificData?.proxyPoolId || "__none__"),
    );
    if (poolIds.size === 1) {
      const onlyId = [...poolIds][0];
      if (onlyId === "__none__") return "All selected currently unbound";
      const pool = proxyPools.find((entry) => entry.id === onlyId);
      return `All selected currently bound to ${pool?.name || onlyId}`;
    }
    return "Selected connections have mixed proxy bindings";
  })();

  const openBulkProxy = () => {
    const scope = selectedConnections.length > 0 ? selectedConnections : connections;
    const uniquePoolIds = [
      ...new Set(scope.map((entry) => entry.providerSpecificData?.proxyPoolId || "__none__")),
    ];
    setBulkPoolId(uniquePoolIds.length === 1 ? uniquePoolIds[0] : "__none__");
    setBulkProxyOpen(true);
  };

  const handleDragEnd = (event) => {
    const { active, over } = event;
    const move = dragMoveIndices(connections, active?.id, over?.id);
    if (!move) return;
    conn.moveConnection(move.fromIndex, move.toIndex);
    const moved = connections.find((entry) => entry.id === active.id);
    const name = moved?.name || moved?.email || "Connection";
    setAnnouncement(`Moved ${name} to position ${move.toIndex + 1} of ${connections.length}`);
  };

  const handleApplySinglePool = (proxyPoolId) => {
    const targets = connections.map((entry) => ({ connectionId: entry.id, proxyPoolId }));
    return conn.applyProxyAssignments(targets);
  };

  const handleApplyOneToOne = () => {
    const activePools = proxyPools.filter((entry) => entry.isActive === true);
    if (activePools.length === 0) {
      actions.notifyError("No active proxy pools available.");
      return;
    }
    const targets = connections.map((entry, index) => ({
      connectionId: entry.id,
      proxyPoolId: activePools[index % activePools.length].id,
    }));
    return conn.applyProxyAssignments(targets);
  };

  return (
    <>
      <Card
        title="Connections"
        subtitle={`${connections.length} connection${connections.length === 1 ? "" : "s"}`}
        action={
          connections.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              {proxyPools.length > 0 ? (
                <Button size="sm" variant="secondary" icon="lan" onClick={openBulkProxy}>
                  Apply proxy
                </Button>
              ) : null}
              {selectedIds.length > 0 ? (
                <Button size="sm" variant="danger" icon="delete" onClick={conn.confirmBulkDelete}>
                  Delete selected ({selectedIds.length})
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="secondary"
                icon="science"
                onClick={conn.runOneByOne}
                disabled={oneByOne.running}
                loading={oneByOne.running}
              >
                {oneByOne.running ? "Testing…" : "Test one-by-one"}
              </Button>
              {oneByOne.running ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="stop"
                  onClick={conn.stopOneByOne}
                  disabled={oneByOne.stopping}
                >
                  {oneByOne.stopping ? "Stopping…" : "Stop"}
                </Button>
              ) : null}
            </div>
          ) : null
        }
      >
        <div className="mb-4 flex flex-col gap-3 border-b border-line pb-4 lg:flex-row lg:flex-wrap lg:items-end">
          <div className="flex min-w-52 flex-1 flex-col gap-2">
            <span
              id={`strategy-label-${providerId}`}
              className="text-xs font-semibold tracking-wider text-muted uppercase"
            >
              Account strategy
            </span>
            <SegmentedControl
              aria-labelledby={`strategy-label-${providerId}`}
              value={strategy.providerStrategy || "inherit"}
              onChange={(value) => strategy.changeStrategy(value)}
              options={strategyOptions}
            />
            <span className="text-xs text-muted" aria-live="polite">
              {strategy.providerStrategy !== null
                ? "Per-provider override"
                : "Using global fallback strategy"}
              {strategy.saving ? " · Saving…" : ""}
            </span>
          </div>
          {usesStickyLimit ? (
            <div className="flex flex-wrap items-end gap-2">
              <NumberStepper
                label="Sticky limit"
                className="w-44"
                min={1}
                max={100}
                value={strategy.stickyDraft === "" ? effectiveSticky : Number(strategy.stickyDraft)}
                placeholder={`${effectiveSticky} · ${stickySource}`}
                onChange={strategy.commitSticky}
                hint={
                  (strategy.providerStrategy || effectiveStrategy) === "weighted"
                    ? OAUTH_STICKY_HINT
                    : "Calls per account before rotating."
                }
                error={strategy.error || undefined}
                disabled={strategy.saving}
              />
              {hasStickyOverride ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="restart_alt"
                  onClick={strategy.clearStickyOverride}
                  disabled={strategy.saving}
                >
                  Reset to default
                </Button>
              ) : null}
            </div>
          ) : null}
          <p className="w-full text-xs text-muted" aria-live="polite">
            {inheritedStickyText}
          </p>
          {showWeighted && subscriptionProvider && effectiveSticky === 1 ? (
            <p className="w-full text-xs text-warn">
              Sticky limit 1 rotates every request; subscription OAuth providers may flag rapid
              account switching.
            </p>
          ) : null}
          {showWeighted ? (
            <p className="w-full text-xs text-muted">
              Shares estimated from remaining quota; model-specific quotas may differ.
            </p>
          ) : null}
        </div>

        {connections.length === 0 ? (
          <EmptyState
            icon={auth.isOAuth ? "lock" : "key"}
            title="No connections yet"
            body={
              auth.hasDualAuthModes
                ? `Choose ${auth.labels.oauth} or ${auth.labels.apiKey}.`
                : "Add your first connection to start routing through this provider."
            }
            action={<div className="flex flex-wrap justify-center gap-2">{actions.addButtons}</div>}
          />
        ) : (
          <>
            {oneByOne.summary ? (
              <div
                className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-raised px-3 py-2 text-xs text-muted sm:gap-3"
                aria-live="polite"
              >
                <span>Total: {oneByOne.summary.total}</span>
                <span>Completed: {oneByOne.summary.completed}</span>
                <StatusPill variant="ok">{oneByOne.summary.passed} passed</StatusPill>
                {oneByOne.summary.failed > 0 ? (
                  <StatusPill variant="err">{oneByOne.summary.failed} failed</StatusPill>
                ) : null}
                {oneByOne.summary.stopped ? <StatusPill variant="warn">Stopped</StatusPill> : null}
                {oneByOne.running && oneByOne.currentId ? (
                  <span>
                    Running:{" "}
                    {connections.find((entry) => entry.id === oneByOne.currentId)?.name ||
                      oneByOne.currentId}
                  </span>
                ) : null}
              </div>
            ) : null}
            <div className="mb-2 flex items-center gap-2 border-b border-line pb-2">
              <Checkbox
                checked={allSelected}
                indeterminate={!allSelected && selectedIds.length > 0}
                onChange={conn.toggleSelectAll}
                label="Select all"
              />
              {selectedProxySummary ? (
                <span className="ms-auto text-xs text-muted">{selectedProxySummary}</span>
              ) : null}
            </div>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis, restrictToParentElement]}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={connections.map((entry) => entry.id)}
                strategy={verticalListSortingStrategy}
              >
                <ul className="flex min-w-0 flex-col gap-1">
                  {connections.map((entry, index) => (
                    <SortableConnectionRow
                      key={entry.id}
                      connection={entry}
                      index={index}
                      total={connections.length}
                      showHandle={connections.length > 1}
                      proxyPools={proxyPools}
                      isOAuth={auth.isOAuth}
                      showWeighted={showWeighted}
                      totalWeight={totalWeight}
                      activeCount={activeConnections.length}
                      oneByOneStatus={oneByOne.results[entry.id] || null}
                      autoPing={
                        autoPing.enabled && entry.authType === "oauth"
                          ? {
                              on: autoPing.connections[entry.id] === true,
                              onToggle: (on) => autoPing.toggle(entry.id, on),
                              provider: providerId,
                            }
                          : null
                      }
                      selected={selectedIds.includes(entry.id)}
                      onSelect={conn.toggleSelect}
                      onToggleActive={(isActive) => conn.toggleActive(entry.id, isActive)}
                      onUpdateProxy={(proxyPoolId) => conn.updateProxy(entry.id, proxyPoolId)}
                      onEdit={() => actions.edit(entry)}
                      onDelete={() => conn.confirmDelete(entry.id)}
                      onMove={conn.moveConnection}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
            <span aria-live="polite" className="sr-only">
              {announcement}
            </span>
            <div className="mt-4 flex flex-wrap gap-2">{actions.addButtons}</div>
          </>
        )}
      </Card>

      <Modal
        isOpen={bulkProxyOpen}
        onClose={() => {
          if (!bulkProxyUpdating) setBulkProxyOpen(false);
        }}
        title={`Apply proxy (${connections.length} connections)`}
        footer={
          <Button
            variant="ghost"
            onClick={() => setBulkProxyOpen(false)}
            disabled={bulkProxyUpdating}
          >
            Cancel
          </Button>
        }
      >
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={handleApplyOneToOne}
            disabled={
              bulkProxyUpdating ||
              proxyPools.filter((entry) => entry.isActive === true).length === 0
            }
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[18px] text-muted" aria-hidden="true">
              sync_alt
            </span>
            One-to-one (rotate)
          </button>
          <button
            type="button"
            onClick={() => handleApplySinglePool(null)}
            disabled={bulkProxyUpdating}
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[18px] text-muted" aria-hidden="true">
              link_off
            </span>
            None (unbind all)
          </button>
          {proxyPools.map((pool) => (
            <button
              key={pool.id}
              type="button"
              onClick={() => handleApplySinglePool(pool.id)}
              disabled={bulkProxyUpdating || pool.isActive !== true}
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[18px] text-muted" aria-hidden="true">
                lan
              </span>
              <span className="truncate">{pool.name}</span>
              {bulkPoolId === pool.id ? (
                <span
                  className="material-symbols-outlined text-[16px] text-coral-ink"
                  aria-hidden="true"
                >
                  check
                </span>
              ) : null}
              {pool.isActive !== true ? (
                <span className="text-[10px] text-muted">(inactive)</span>
              ) : null}
            </button>
          ))}
        </div>
        {bulkProxyUpdating ? (
          <p className="mt-2 text-xs text-muted" aria-live="polite">
            Applying…
          </p>
        ) : null}
      </Modal>

      <ConfirmDialog
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />
    </>
  );
}

ConnectionsSection.propTypes = {
  providerId: PropTypes.string.isRequired,
  auth: PropTypes.shape({
    isOAuth: PropTypes.bool.isRequired,
    hasDualAuthModes: PropTypes.bool.isRequired,
    labels: PropTypes.object.isRequired,
  }).isRequired,
  strategy: PropTypes.object.isRequired,
  conn: PropTypes.object.isRequired,
  autoPing: PropTypes.shape({
    enabled: PropTypes.bool.isRequired,
    connections: PropTypes.object.isRequired,
    toggle: PropTypes.func.isRequired,
  }).isRequired,
  actions: PropTypes.shape({
    addButtons: PropTypes.node.isRequired,
    edit: PropTypes.func.isRequired,
    notifyError: PropTypes.func.isRequired,
  }).isRequired,
};
