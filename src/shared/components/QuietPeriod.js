"use client";

import PropTypes from "prop-types";
import { useEffect, useState } from "react";
import { getCurrentLocale, onLocaleChange } from "@/i18n/runtime";
// Direct file imports (not the barrel) keep this leaf free of cycles.
import Button from "@/shared/components/Button";
import EmptyState from "@/shared/components/EmptyState";
import { Skeleton } from "@/shared/components/Loading";
import { LoadingState } from "@/shared/components/StateViews";
import { useLocalBaseUrl } from "@/shared/hooks/useEndpointShell";
import {
  formatRelativeFromNow,
  PERIOD_VALUES,
  QUIET_TITLES,
  SHOW_PERIOD_LABELS,
  smallestPeriodWithData,
} from "@/shared/utils/period";

/**
 * Shared quiet-period empty state: explains "no requests in this period" with
 * the real last-activity time and offers a jump to the smallest period that
 * still has data. `lastRequestAt === null` renders the fresh-install hint.
 *
 * @param {object} props
 * @param {string} props.period Currently selected period value.
 * @param {string|null|undefined} props.lastRequestAt ISO timestamp of the last request,
 *   undefined until loaded, null when there was never one.
 * @param {boolean} [props.loading] True while last-activity loads.
 * @param {string[]} [props.allowed] Periods this page offers (jump target must be one).
 * @param {(value: string) => void} [props.onSelectPeriod] Called with the jump target.
 * @param {boolean} [props.compact] Horizontal row instead of the centered card.
 * @param {string} [props.className]
 * @param {"h1"|"h2"|"h3"|"h4"|"p"|"div"} [props.headingAs="h2"] Heading element for EmptyState.
 */
export default function QuietPeriod({
  period,
  lastRequestAt,
  loading,
  allowed = PERIOD_VALUES,
  onSelectPeriod,
  compact = false,
  className,
  headingAs = "h2",
}) {
  const baseUrl = useLocalBaseUrl();
  const [relative, setRelative] = useState("");

  // Relative time computed after mount so SSR and the first client render
  // match; recomputed when the locale or the timestamp changes.
  useEffect(() => {
    const update = () => setRelative(formatRelativeFromNow(lastRequestAt, getCurrentLocale()));
    update();
    return onLocaleChange(update);
  }, [lastRequestAt]);

  if (loading || lastRequestAt === undefined) {
    if (compact) {
      return (
        <div role="status" aria-label="Loading last activity" className={className}>
          <Skeleton className="h-16 w-full" />
        </div>
      );
    }
    return <LoadingState label="Loading last activity" className={className} />;
  }

  if (lastRequestAt === null) {
    return (
      <EmptyState
        as={headingAs}
        compact={compact}
        className={className}
        icon="bolt"
        title="No traffic yet"
        body={
          <>
            Point any OpenAI-compatible client at{" "}
            <code className="font-mono text-text">{baseUrl}</code>
          </>
        }
      />
    );
  }

  const target = smallestPeriodWithData(lastRequestAt, allowed);
  const jump = target && allowed.indexOf(target) > allowed.indexOf(period);

  return (
    <EmptyState
      as={headingAs}
      compact={compact}
      className={className}
      icon="bedtime"
      title={QUIET_TITLES[period] || "Quiet in this period"}
      body={
        <>
          <span>Last request</span> <time dateTime={lastRequestAt}>{relative}</time>
        </>
      }
      action={
        jump && onSelectPeriod ? (
          <Button variant="secondary" size="sm" onClick={() => onSelectPeriod(target)}>
            {SHOW_PERIOD_LABELS[target]}
          </Button>
        ) : undefined
      }
    />
  );
}

QuietPeriod.propTypes = {
  period: PropTypes.string,
  lastRequestAt: PropTypes.string,
  loading: PropTypes.bool,
  allowed: PropTypes.arrayOf(PropTypes.oneOf(PERIOD_VALUES)),
  onSelectPeriod: PropTypes.func,
  compact: PropTypes.bool,
  className: PropTypes.string,
  headingAs: PropTypes.oneOf(["h1", "h2", "h3", "h4", "p", "div"]),
};
