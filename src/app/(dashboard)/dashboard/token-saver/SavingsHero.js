"use client";

import PropTypes from "prop-types";
import { Button, Callout, Card, EmptyState, SegmentedControl, Skeleton } from "@/shared/components";
import { formatCompact, formatMoney } from "../home/format";
import {
  SAVINGS_METHOD_LABELS,
  SAVINGS_PERIODS,
  SAVINGS_SEGMENT_ORDER,
  savingsDollarLine,
  savingsShare,
} from "./tokenSaverUtils";

/**
 * Page toolbar: Today/7d/30d control. Shell Header owns the title.
 * @param {object} props
 * @param {string} props.period
 * @param {(period: string) => void} props.onPeriodChange
 */
export function TokenSaverHeader({ period, onPeriodChange }) {
  return (
    <div className="flex min-w-0 justify-end">
      <SegmentedControl
        aria-label="Savings period"
        options={SAVINGS_PERIODS}
        value={period}
        onChange={onPeriodChange}
        className="w-full sm:w-auto"
      />
    </div>
  );
}

TokenSaverHeader.propTypes = {
  period: PropTypes.string.isRequired,
  onPeriodChange: PropTypes.func.isRequired,
};

const SEGMENT_OPACITY = ["bg-on-lime/90", "bg-on-lime/55", "bg-on-lime/30"];

/**
 * Lime savings hero: total saved, % lighter, $ estimate at list prices and a
 * stacked bar by method. The $ value arrives inside the aggregation
 * (`costSavedEst`, priced server-side per request with its own model
 * pricing) — the hero renders it and never resolves pricing itself.
 * @param {object} props
 * @param {object|null} props.savings YAN-292 aggregation
 * @param {boolean} props.loading
 * @param {string|null} props.error
 * @param {string} props.period
 * @param {() => void} props.onRetry
 */
export function SavingsHero({ savings, loading, error, period, onRetry }) {
  const periodLabel = period === "today" ? "today" : `last ${period}`;
  if (loading) {
    return (
      <section aria-label="Savings summary">
        <div role="status" aria-label="Loading savings">
          <Skeleton className="h-36 w-full" />
        </div>
      </section>
    );
  }
  if (error || !savings) {
    return (
      <section aria-label="Savings summary">
        <Callout variant="err" title="Could not load savings">
          {error || "Savings data failed to load."}
          <div className="mt-3">
            <Button variant="secondary" size="sm" icon="refresh" onClick={onRetry}>
              Retry
            </Button>
          </div>
        </Callout>
      </section>
    );
  }
  const saved = Number(savings.tokensSavedEst) || 0;
  if (saved <= 0) {
    return (
      <section aria-label="Savings summary">
        <Card className="border-transparent bg-lime text-on-lime">
          <EmptyState
            icon="bolt"
            title={`No savings recorded ${periodLabel} yet`}
            body="Send traffic with a saver enabled — tool-output compression, Headroom, or prompts-as-images — and the totals land here."
            action={
              <Button variant="secondary" size="sm" href="/dashboard/usage">
                View Usage
              </Button>
            }
          />
        </Card>
      </section>
    );
  }
  const share = savingsShare(savings);
  const segments = SAVINGS_SEGMENT_ORDER.filter((method) => (share[method] || 0) > 0);

  return (
    <section
      aria-label="Savings summary"
      className="relative flex flex-col gap-6 overflow-hidden rounded-2xl bg-lime p-6 text-on-lime shadow-card inset-shadow-[0_0_0_1px_rgba(0,0,0,0.12)] lg:flex-row lg:items-center lg:gap-10 lg:px-7"
    >
      <div className="flex shrink-0 flex-col gap-1">
        <span className="text-xs font-semibold tracking-[0.08em] uppercase">
          Saved {periodLabel}
        </span>
        <span className="font-display text-5xl font-extrabold tabular-nums">
          {formatCompact(saved)} tokens
        </span>
        <span className="text-sm font-medium">
          {Math.round(Number(savings.percentage) || 0)}% lighter than raw requests
          {savingsDollarLine(savings, formatMoney)}
        </span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div
          className="flex h-[18px] gap-[3px] overflow-hidden rounded-full"
          role="img"
          aria-label={`Savings by method: ${segments.map((m) => `${SAVINGS_METHOD_LABELS[m] || m} ${share[m]}%`).join(", ")}`}
        >
          {segments.map((method, index) => (
            <span
              key={method}
              style={{ flexGrow: Math.max(1, share[method]) }}
              className={SEGMENT_OPACITY[index % SEGMENT_OPACITY.length]}
            />
          ))}
        </div>
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-[13px] font-semibold">
          {segments.map((method, index) => (
            <li key={method} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={`size-2 rounded-full ${SEGMENT_OPACITY[index % SEGMENT_OPACITY.length]}`}
              />
              {SAVINGS_METHOD_LABELS[method] || method}{" "}
              {formatCompact(savings.byMethod?.[method]?.tokensSavedEst || 0)}
            </li>
          ))}
        </ul>
      </div>
      <span
        aria-hidden="true"
        className="material-symbols-outlined pointer-events-none absolute -top-6 -end-6 text-[160px] opacity-10"
      >
        bolt
      </span>
    </section>
  );
}

SavingsHero.propTypes = {
  savings: PropTypes.object,
  loading: PropTypes.bool,
  error: PropTypes.string,
  period: PropTypes.string.isRequired,
  onRetry: PropTypes.func.isRequired,
};

/**
 * Per-card savings footer: saved total + share, or the off/label state.
 * @param {object} props
 * @param {object|null} props.savings
 * @param {string} props.method
 * @param {string} props.tag
 * @param {string} [props.offLabel]
 * @param {React.ReactNode} [props.action]
 */
export function MethodFooter({ savings, method, tag, offLabel, action }) {
  const saved = Number(savings?.byMethod?.[method]?.tokensSavedEst) || 0;
  const share = savingsShare(savings)[method];
  return (
    <div className="mt-4 flex items-center gap-2 text-[13px] text-muted">
      {saved > 0 ? (
        <>
          <span className="font-semibold text-lime-ink">{formatCompact(saved)} saved</span>
          {share != null && <span>· {share}%</span>}
        </>
      ) : (
        <span>{offLabel || "No savings recorded in this period"}</span>
      )}
      <span className="ms-auto inline-flex items-center gap-2">
        {action}
        <span className="rounded-full bg-raised px-2.5 py-0.5 text-xs font-semibold text-muted shadow-[inset_0_0_0_1px_var(--signal-line)]">
          {tag}
        </span>
      </span>
    </div>
  );
}

MethodFooter.propTypes = {
  savings: PropTypes.object,
  method: PropTypes.string.isRequired,
  tag: PropTypes.string.isRequired,
  offLabel: PropTypes.string,
  action: PropTypes.node,
};
