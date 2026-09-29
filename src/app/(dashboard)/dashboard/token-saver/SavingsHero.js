"use client";

import PropTypes from "prop-types";
import { Button, Callout, Card, EmptyState, Skeleton } from "@/shared/components";
import PeriodControl from "@/shared/components/PeriodControl";
import { SUMMARY_PERIODS, periodOptions } from "@/shared/utils/period";
import { formatCompact, formatMoney } from "../home/format";
import {
  SAVINGS_METHOD_LABELS,
  SAVINGS_SEGMENT_ORDER,
  savingsDollarLine,
  savingsShare,
} from "./tokenSaverUtils";

const SAVINGS_OPTIONS = periodOptions(SUMMARY_PERIODS);

/**
 * Page toolbar: Today/7d/30d control. Shell Header owns the title. Renders
 * with no selection while the shared period resolves after mount.
 * @param {object} props
 * @param {string|null} props.period
 * @param {(period: string) => void} props.onPeriodChange
 */
export function TokenSaverHeader({ period, onPeriodChange }) {
  return (
    <div className="flex min-w-0 justify-end">
      <PeriodControl
        aria-label="Savings period"
        options={SAVINGS_OPTIONS}
        value={period}
        onChange={onPeriodChange}
        className="w-full sm:w-auto"
      />
    </div>
  );
}

TokenSaverHeader.propTypes = {
  period: PropTypes.string,
  onPeriodChange: PropTypes.func.isRequired,
};

const SEGMENT_OPACITY = ["bg-on-lime/90", "bg-on-lime/55", "bg-on-lime/30"];

/**
 * Hero copy, keyed so the i18n extractor reads every literal. SAVED_COPY is
 * the heading for the selected period when it holds savings; FALLBACK_COPY
 * when a larger period stands in, with a QUIET_NOTES caption about the empty
 * selected period. Each is a standalone phrase in its own element.
 */
const SAVED_COPY = {
  today: { eyebrow: "Saved today" },
  "7d": { eyebrow: "Saved last 7d" },
  "30d": { eyebrow: "Saved last 30d" },
  default: { eyebrow: "Saved in this period" },
};
const FALLBACK_COPY = {
  "7d": { eyebrow: "Saved in the last 7d" },
  "30d": { eyebrow: "Saved in the last 30d" },
  default: { eyebrow: "Saved in this period" },
};
const EMPTY_COPY = {
  never: { title: "No savings recorded yet" },
  period: { title: "No savings in this period" },
};
const QUIET_NOTES = {
  today: { caption: "None today" },
  "7d": { caption: "None in the last 7d" },
};

/**
 * Filled lime hero: total saved, % lighter, $ estimate at list prices and a
 * stacked bar by method. The heading and caption arrive as full static
 * phrases so the runtime i18n can translate them.
 * @param {object} props
 * @param {object} props.savings YAN-292 aggregation
 * @param {string} props.eyebrow
 * @param {string|null} [props.note] Quiet note about the empty selected period.
 */
function FilledHero({ savings, eyebrow, note = null }) {
  const saved = Number(savings.tokensSavedEst) || 0;
  const share = savingsShare(savings);
  const segments = SAVINGS_SEGMENT_ORDER.filter((method) => (share[method] || 0) > 0);

  return (
    <section
      aria-label="Savings summary"
      className="relative flex flex-col gap-6 overflow-hidden rounded-2xl bg-lime p-6 text-on-lime shadow-card inset-shadow-[0_0_0_1px_rgba(0,0,0,0.12)] lg:flex-row lg:items-center lg:gap-10 lg:px-7"
    >
      <div className="flex shrink-0 flex-col gap-1">
        <span className="text-xs font-semibold tracking-[0.08em] uppercase">{eyebrow}</span>
        <span className="font-display text-5xl font-extrabold tabular-nums">
          {formatCompact(saved)} tokens
        </span>
        <span className="text-sm font-medium">
          {Math.round(Number(savings.percentage) || 0)}% lighter than raw requests
          {savingsDollarLine(savings, formatMoney)}
        </span>
        {note && <span className="text-xs font-semibold text-on-lime/80">{note}</span>}
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

FilledHero.propTypes = {
  savings: PropTypes.object.isRequired,
  eyebrow: PropTypes.string.isRequired,
  note: PropTypes.string,
};

/**
 * Lime savings hero: total saved, % lighter, $ estimate at list prices and a
 * stacked bar by method. The $ value arrives inside the aggregation
 * (`costSavedEst`, priced server-side per request with its own model
 * pricing) — the hero renders it and never resolves pricing itself. When the
 * current period is empty but `fallback` holds a larger period with savings,
 * the fallback totals render with a quiet note about the current period;
 * when `neverSaved`, the hero collapses to a compact inline empty state.
 * @param {object} props
 * @param {object|null} props.savings YAN-292 aggregation
 * @param {boolean} props.loading
 * @param {string|null} props.error
 * @param {string|null} props.period
 * @param {() => void} props.onRetry
 * @param {{ period: string, savings: object }|null} [props.fallback] Best
 *   larger period with savings when the current period is empty.
 * @param {boolean} [props.neverSaved] Every larger period loaded empty too.
 */
export function SavingsHero({
  savings,
  loading,
  error,
  period,
  onRetry,
  fallback = null,
  neverSaved = false,
}) {
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
  if (saved > 0) {
    return (
      <FilledHero savings={savings} eyebrow={(SAVED_COPY[period] ?? SAVED_COPY.default).eyebrow} />
    );
  }
  if (fallback) {
    return (
      <FilledHero
        savings={fallback.savings}
        eyebrow={(FALLBACK_COPY[fallback.period] ?? FALLBACK_COPY.default).eyebrow}
        note={QUIET_NOTES[period]?.caption ?? null}
      />
    );
  }
  // neverSaved: every larger period loaded empty. Otherwise a fallback fetch
  // failed, so only the selected period is known to be empty.
  return (
    <section aria-label="Savings summary">
      <Card>
        <EmptyState
          compact
          icon="bolt"
          title={EMPTY_COPY[neverSaved ? "never" : "period"].title}
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

SavingsHero.propTypes = {
  savings: PropTypes.object,
  loading: PropTypes.bool,
  error: PropTypes.string,
  period: PropTypes.string,
  onRetry: PropTypes.func.isRequired,
  fallback: PropTypes.shape({
    period: PropTypes.string.isRequired,
    savings: PropTypes.object.isRequired,
  }),
  neverSaved: PropTypes.bool,
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
