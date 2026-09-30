"use client";

import dynamic from "next/dynamic";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import { Skeleton } from "@/shared/components/Loading";
import { cn } from "@/shared/utils/cn";

// Lazy-load the SVG diagram (handbook: heavy client-only widgets load via next/dynamic).
const RoutesMap = dynamic(() => import("./RoutesMap"), {
  ssr: false,
  loading: () => <RoutesMapLoading />,
});

function RoutesMapLoading() {
  return (
    <div role="status" aria-label="Loading live routes" className="py-2">
      <Skeleton className="h-[220px] w-full" />
    </div>
  );
}

/**
 * "Live routes" card shared by Home (compact) and Usage (full): header pill +
 * lazily loaded routes map with idle awareness.
 *
 * @param {object} props
 * @param {object|null} props.routes flow model from /api/home/live-routes
 * @param {boolean} props.loading
 * @param {string|null} props.error
 * @param {() => void} props.onRetry
 * @param {"compact"|"full"} [props.variant="compact"]
 * @param {string|null|undefined} [props.lastRequestAt]
 * @param {string|null} [props.lastActivityError]
 * @param {() => void} [props.onRetryLastActivity]
 * @param {string} [props.className]
 */
export function RoutesMapCard({
  routes,
  loading,
  error,
  onRetry,
  variant = "compact",
  lastRequestAt,
  lastActivityError,
  onRetryLastActivity,
  className,
}) {
  return (
    <Card
      className={cn("min-w-0", className)}
      title="Live routes"
      action={
        <span className="inline-flex items-center gap-1.5 rounded-full bg-lime-bg px-2.5 py-1 text-xs font-semibold text-lime-ink">
          <span
            aria-hidden="true"
            className="size-2 rounded-full bg-lime-ink motion-safe:animate-pulse"
          />
          last 5 min
        </span>
      }
    >
      <RoutesMap
        routes={routes}
        loading={loading}
        error={error}
        onRetry={onRetry}
        compact={variant === "compact"}
        lastRequestAt={lastRequestAt}
        lastActivityError={lastActivityError}
        onRetryLastActivity={onRetryLastActivity}
      />
    </Card>
  );
}

RoutesMapCard.propTypes = {
  routes: PropTypes.shape({
    clients: PropTypes.arrayOf(PropTypes.object),
    providers: PropTypes.arrayOf(PropTypes.object),
    edges: PropTypes.arrayOf(PropTypes.object),
    fallbacks: PropTypes.arrayOf(PropTypes.object),
  }),
  loading: PropTypes.bool,
  error: PropTypes.string,
  onRetry: PropTypes.func.isRequired,
  variant: PropTypes.oneOf(["compact", "full"]),
  lastRequestAt: PropTypes.string,
  lastActivityError: PropTypes.string,
  onRetryLastActivity: PropTypes.func,
  className: PropTypes.string,
};
