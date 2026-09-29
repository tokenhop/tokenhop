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
  QUIET_COPY,
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
 * @param {string[]} [props.allowed] Periods this page offers (jump target must be one; any order).
 * @param {string|null} [props.error] Last-activity fetch error: shows the quiet copy with a retry.
 * @param {() => void} [props.onRetry] Re-read last activity after an error.
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
  error = null,
  onRetry,
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

  const title = (QUIET_COPY[period] ?? QUIET_COPY.default).title;

  if (error && lastRequestAt === undefined) {
    return (
      <EmptyState
        as={headingAs}
        compact={compact}
        className={className}
        icon="bedtime"
        title={title}
        body="Couldn't load the last request time."
        action={
          onRetry ? (
            <Button variant="secondary" size="sm" icon="refresh" onClick={onRetry}>
              Retry
            </Button>
          ) : undefined
        }
      />
    );
  }

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

  // Canonical ascending order: the first match is the smallest period with data.
  const ordered = PERIOD_VALUES.filter((value) => allowed.includes(value));
  const target = smallestPeriodWithData(lastRequestAt, ordered);
  const jump = target && ordered.indexOf(target) > ordered.indexOf(period);

  return (
    <EmptyState
      as={headingAs}
      compact={compact}
      className={className}
      icon="bedtime"
      title={title}
      body={
        <>
          <span>Last request</span> <time dateTime={lastRequestAt}>{relative}</time>
        </>
      }
      action={
        jump && onSelectPeriod ? (
          <Button variant="secondary" size="sm" onClick={() => onSelectPeriod(target)}>
            {QUIET_COPY[target].actionLabel}
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
  error: PropTypes.string,
  onRetry: PropTypes.func,
  compact: PropTypes.bool,
  className: PropTypes.string,
  headingAs: PropTypes.oneOf(["h1", "h2", "h3", "h4", "p", "div"]),
};
