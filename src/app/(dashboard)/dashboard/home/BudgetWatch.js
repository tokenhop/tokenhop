"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import CardLink from "@/shared/components/CardLink";
import Meter from "@/shared/components/Meter";
import StatusPill from "@/shared/components/StatusPill";
import { SCOPE_LABELS, WINDOW_LABELS } from "../usage/lib/budgetLabels";
import BudgetMarker from "../usage/components/BudgetMarker";
import { budgetLimitRows, budgetResetAt, pctLeft } from "../usage/lib/budgetMeter";
import { formatReset } from "./format";

/**
 * Budget watch: up to 3 budgets closest to their cap, with the same
 * spent / cap numbers as Usage > Budgets (shared helpers). Renders nothing
 * when there is nothing to show (BudgetWatchCard owns that gate).
 *
 * @param {object} props
 * @param {Array<object>} props.budgets already sorted and sliced rows
 * @param {boolean} props.loading
 * @param {string|null} props.error
 */
export default function BudgetWatch({ budgets, loading, error }) {
  if (!hasBudgetsToShow({ budgets, loading, error })) return null;
  return (
    <ul className="flex min-w-0 flex-col gap-4" aria-label="Budgets closest to their cap">
      {budgets.map((budget) => {
        const { scopeType, scopeId, window: win } = budget;
        const limits = budgetLimitRows(budget);
        const scopeLabel = SCOPE_LABELS[scopeType] || scopeType;
        const reset = budget.window === "total" ? null : formatReset(budgetResetAt(budget));
        return (
          <li key={budget.id} className="flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-text">{scopeLabel}</span>
              {scopeType !== "workspace" && scopeType !== "user" && scopeId && (
                <code className="min-w-0 max-w-32 truncate rounded-md bg-raised px-1.5 py-0.5 font-mono text-xs text-muted">
                  {scopeId}
                </code>
              )}
              <StatusPill variant="info" size="sm">
                {WINDOW_LABELS[win] || win}
              </StatusPill>
              {budget.softLimitPct != null && (
                <StatusPill variant="warn" size="sm">
                  Soft at {budget.softLimitPct}%
                </StatusPill>
              )}
              <BudgetMarker budget={budget} limits={limits} />
            </div>
            {limits.length > 0 ? (
              limits.map(({ unit, label, spent, limit, format }) => {
                const left = pctLeft(spent, limit);
                return (
                  <div key={unit} className="flex min-w-0 flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="text-muted">{label}</span>
                      <span className="font-mono text-text">
                        {format(spent)} / {format(limit)}
                      </span>
                    </div>
                    <Meter
                      value={left ?? 0}
                      label={`${scopeLabel} ${label.toLowerCase()} budget used`}
                      valueText={`${format(spent)} of ${format(limit)} used, ${Math.round(left ?? 0)}% left`}
                    />
                  </div>
                );
              })
            ) : (
              <span className="text-xs text-muted">No limits set — tracking spend only.</span>
            )}
            {budget.window === "total" ? (
              <span className="text-xs text-muted">Never resets</span>
            ) : (
              reset && <span className="text-xs text-muted">{reset}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

BudgetWatch.propTypes = {
  budgets: PropTypes.arrayOf(PropTypes.object),
  loading: PropTypes.bool,
  error: PropTypes.string,
};

/** True when the tile has rows to render (hidden while loading, on error, or empty). */
export const hasBudgetsToShow = ({ budgets, loading, error }) =>
  !loading && !error && Array.isArray(budgets) && budgets.length > 0;

/** Card wrapper; renders no card at all when there is nothing to show. */
export function BudgetWatchCard(props) {
  if (!hasBudgetsToShow(props)) return null;
  return (
    <Card
      className="min-w-0"
      title="Budgets"
      action={<CardLink href="/dashboard/usage?tab=budgets">All budgets</CardLink>}
    >
      <BudgetWatch {...props} />
    </Card>
  );
}
