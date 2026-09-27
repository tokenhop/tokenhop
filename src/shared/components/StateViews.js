"use client";

import PropTypes from "prop-types";
import Button from "./Button";
import Callout from "./Callout";
import EmptyState from "./EmptyState";
import { Skeleton } from "./Loading";

/** Layout-bearing loading state with skeleton slots and an accessible label. */
export function LoadingState({ lines = 4, label = "Loading", className = "" }) {
  return (
    <div role="status" aria-label={label} className={`flex min-w-0 flex-col gap-3 ${className}`}>
      <Skeleton className="h-5 w-24" />
      <Skeleton className="h-9 w-2/3" />
      {Array.from({ length: lines }, (_, position) => `line-${position}`).map((id) => (
        <Skeleton key={id} className="h-4 w-full" />
      ))}
    </div>
  );
}

LoadingState.propTypes = {
  lines: PropTypes.number,
  label: PropTypes.string,
  className: PropTypes.string,
};

/** User-safe error state with Retry. */
export function ErrorState({ message, onRetry, title = "Could not load this view", children }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Callout variant="err" title={title}>
        {message || "Something went wrong while loading."}
      </Callout>
      <div className="flex flex-wrap gap-2">
        {onRetry && (
          <Button variant="secondary" size="sm" icon="refresh" onClick={onRetry}>
            Retry
          </Button>
        )}
        {children}
      </div>
    </div>
  );
}

ErrorState.propTypes = {
  message: PropTypes.string,
  onRetry: PropTypes.func,
  title: PropTypes.string,
  children: PropTypes.node,
};

export { EmptyState };
