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
  Select,
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
  user: "User",
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
        {scopeType !== "workspace" && scopeType !== "user" && scopeId && (
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

export default function BudgetsTab({ workspaceId, canManage = false, canManageUsers = false }) {
  const [state, setState] = useState({ budgets: null, error: null, loading: true });
  const [reload, setReload] = useState(0);
  const retry = useCallback(() => setReload((value) => value + 1), []);
  const [dialog, setDialog] = useState(null); // null | { budget: object|null }
  // Admin/owner only (server enforces): "User" target picks one account via
  // GET /api/users ({users:[{id,displayName,username,email}]}); budgets then
  // read from GET /api/users/:id/budgets. Hidden when OFF (404 → error state).
  const [target, setTarget] = useState("workspace");
  const [userId, setUserId] = useState("");
  const [users, setUsers] = useState([]);
  const userTarget = canManageUsers && target === "user";
  const canEdit = userTarget ? canManageUsers && Boolean(userId) : canManage;

  useEffect(() => {
    if (!canManageUsers) return undefined;
    const controller = new AbortController();
    fetch("/api/users?pageSize=100", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`users ${r.status}`))))
      .then(
        (data) =>
          !controller.signal.aborted && setUsers(Array.isArray(data.users) ? data.users : []),
      )
      .catch(() => {
        if (!controller.signal.aborted) setUsers([]);
      });
    return () => controller.abort();
  }, [canManageUsers]);

  const listUrl =
    userTarget && userId
      ? `/api/users/${encodeURIComponent(userId)}/budgets`
      : `/api/workspaces/${encodeURIComponent(workspaceId)}/budgets`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reload` re-fetches after a save
  useEffect(() => {
    if (!workspaceId) return undefined;
    if (userTarget && !userId) {
      setState({ budgets: [], error: null, loading: false });
      return undefined;
    }
    const controller = new AbortController();
    setState({ budgets: null, error: null, loading: true });
    fetch(listUrl, {
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
  }, [workspaceId, userTarget, userId, listUrl, reload]);

  return (
    <Card
      title="Budgets"
      subtitle={
        userTarget
          ? "Spend limits for one account. Meters show what's left in the current window."
          : "Spend limits for this workspace. Meters show what's left in the current window."
      }
      action={
        canEdit ? (
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
      {canManageUsers && (
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <Select
            label="Budgets for"
            placeholder={null}
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              setUserId("");
            }}
            options={[
              { value: "workspace", label: "Workspace" },
              { value: "user", label: "User" },
            ]}
          />
          {target === "user" && (
            <Select
              label="User"
              placeholder={null}
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              options={[
                { value: "", label: users.length ? "Select a user" : "No users found" },
                ...users.map((u) => ({
                  value: u.id,
                  label: u.displayName || u.username || u.email || u.id,
                })),
              ]}
            />
          )}
        </div>
      )}
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
          title={userTarget && !userId ? "Pick a user" : "No budgets yet"}
          body={
            userTarget
              ? userId
                ? "Budgets cap cost, tokens or requests per window for this account."
                : "Choose a user above to see their budgets."
              : "Budgets cap cost, tokens or requests per window for this workspace, its keys, members and grants."
          }
        />
      ) : (
        <ul className="flex min-w-0 flex-col gap-3">
          {state.budgets.map((budget) => (
            <BudgetRow
              key={budget.id}
              budget={budget}
              onEdit={canEdit ? (b) => setDialog({ budget: b }) : undefined}
            />
          ))}
        </ul>
      )}
      {dialog && workspaceId && (
        <BudgetDialog
          isOpen
          onClose={() => setDialog(null)}
          workspaceId={workspaceId}
          userId={userTarget ? userId : undefined}
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
  canManageUsers: PropTypes.bool,
};
