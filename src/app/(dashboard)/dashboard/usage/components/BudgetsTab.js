"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  Meter,
  StatusPill,
} from "@/shared/components";
import BudgetDialog from "./BudgetDialog";

// Budgets tab (YAN-376): read-only list over GET /api/workspaces/:id/budgets.
// Rows carry spent{usd,tokens,requests,notionalUsd} for the current window.
// Meter value is percentage LEFT so the shared level colors stay meaningful
// (≤20% left = err). Notional USD is an estimate, never billing. Create/edit
// uses BudgetDialog; `canManage` gates create and edit (server enforces).

const WINDOW_LABELS = { day: "Daily", week: "Weekly", month: "Monthly", total: "Total" };
const SCOPE_LABELS = {
  workspace: "Workspace",
  key: "API key",
  membership: "Member",
  grant: "Grant",
};

const money = (n) =>
  n == null ? "—" : `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const count = (n) =>
  n == null ? "—" : Number(n).toLocaleString(undefined, { notation: "compact" });
const pctLeft = (spent, limit) =>
  limit > 0 ? Math.max(0, 100 - ((spent ?? 0) / limit) * 100) : null;

function LimitRow({ label, spent, limit, format }) {
  const left = pctLeft(spent, limit);
  const used = limit > 0 ? Math.round(((spent ?? 0) / limit) * 100) : 0;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-muted">{label}</span>
        <span className="font-mono text-text">
          {format(spent)} / {format(limit)}
          <span className="ms-1 text-xs text-subtle">{used}% used</span>
        </span>
      </div>
      <Meter
        value={left ?? 0}
        label={`${label} budget used`}
        valueText={`${format(spent)} of ${format(limit)} used, ${Math.round(left ?? 0)}% left`}
      />
    </div>
  );
}

LimitRow.propTypes = {
  label: PropTypes.string.isRequired,
  spent: PropTypes.number,
  limit: PropTypes.number,
  format: PropTypes.func.isRequired,
};

function BudgetRow({ budget, onEdit }) {
  const { spent = {}, scopeType, scopeId, window: win, softLimitPct, resetAt } = budget;
  const limits = [
    { label: "Cost", spent: spent.usd, limit: budget.limitUsd, format: money },
    { label: "Tokens", spent: spent.tokens, limit: budget.limitTokens, format: count },
    { label: "Requests", spent: spent.requests, limit: budget.limitRequests, format: count },
  ].filter((row) => row.limit != null);
  return (
    <li className="flex min-w-0 flex-col gap-4 rounded-xl bg-raised p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-text">
          {SCOPE_LABELS[scopeType] || scopeType}
        </span>
        {scopeType !== "workspace" && scopeId && (
          <code className="truncate rounded-md bg-panel px-1.5 py-0.5 font-mono text-xs text-muted">
            {scopeId}
          </code>
        )}
        <StatusPill variant="info" size="sm">
          {WINDOW_LABELS[win] || win}
        </StatusPill>
        {softLimitPct != null && (
          <StatusPill variant="warn" size="sm">
            Soft at {softLimitPct}%
          </StatusPill>
        )}
        {onEdit && (
          <Button variant="ghost" size="sm" onClick={() => onEdit(budget)}>
            Edit
          </Button>
        )}
        {resetAt && (
          <span className="ms-auto text-xs text-subtle">
            Resets {new Date(resetAt).toLocaleString()}
          </span>
        )}
      </div>
      {limits.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-3">
          {limits.map((row) => (
            <LimitRow key={row.label} {...row} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">No limits set — tracking spend only.</p>
      )}
      <p className="text-xs text-subtle">
        Est. spend {money(spent.notionalUsd)} — estimate, not billing.
      </p>
    </li>
  );
}

BudgetRow.propTypes = { budget: PropTypes.object.isRequired, onEdit: PropTypes.func };

export default function BudgetsTab({ workspaceId, canManage = false }) {
  const [state, setState] = useState({ budgets: null, error: null, loading: true });
  const [reload, setReload] = useState(0);
  const retry = useCallback(() => setReload((value) => value + 1), []);
  const [dialog, setDialog] = useState(null); // null | { budget: object|null }

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reload` re-fetches after a save
  useEffect(() => {
    if (!workspaceId) return undefined;
    const controller = new AbortController();
    setState({ budgets: null, error: null, loading: true });
    fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/budgets`, {
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`budgets ${r.status}`))))
      .then(
        (data) =>
          controller.signal.aborted ||
          setState({
            budgets: Array.isArray(data.budgets) ? data.budgets : [],
            error: null,
            loading: false,
          }),
      )
      .catch((error) => {
        if (!controller.signal.aborted) setState({ budgets: null, error, loading: false });
      });
    return () => controller.abort();
  }, [workspaceId, reload]);

  return (
    <Card
      title="Budgets"
      subtitle="Spend limits for this workspace. Meters show what's left in the current window."
      action={
        canManage ? (
          <Button
            variant="secondary"
            size="sm"
            icon="add"
            onClick={() => setDialog({ budget: null })}
          >
            Add budget
          </Button>
        ) : null
      }
    >
      {state.loading ? (
        <LoadingState label="Loading budgets" />
      ) : state.error ? (
        <ErrorState
          title="Couldn't load budgets"
          message={state.error.message || "Try reloading the page."}
          onRetry={retry}
        />
      ) : state.budgets.length === 0 ? (
        <EmptyState
          icon="savings"
          title="No budgets yet"
          body="Budgets cap cost, tokens or requests per window for this workspace, its keys, members and grants."
        />
      ) : (
        <ul className="flex min-w-0 flex-col gap-3">
          {state.budgets.map((budget) => (
            <BudgetRow
              key={budget.id}
              budget={budget}
              onEdit={canManage ? (b) => setDialog({ budget: b }) : undefined}
            />
          ))}
        </ul>
      )}
      {dialog && workspaceId && (
        <BudgetDialog
          isOpen
          onClose={() => setDialog(null)}
          workspaceId={workspaceId}
          budget={dialog.budget}
          onSaved={retry}
        />
      )}
    </Card>
  );
}

BudgetsTab.propTypes = {
  workspaceId: PropTypes.string,
  canManage: PropTypes.bool,
};
