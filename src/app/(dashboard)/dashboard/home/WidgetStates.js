"use client";

import PropTypes from "prop-types";
import Button from "@/shared/components/Button";
import { LoadingState, ErrorState } from "@/shared/components/StateViews";

/** Home widget loading state, backed by the shared skeleton view. */
export const WidgetSkeleton = LoadingState;

/** Home widget error state, backed by the shared retry view. */
export function WidgetError({ message, onRetry }) {
  return <ErrorState title="Could not load this widget" message={message} onRetry={onRetry} />;
}

WidgetError.propTypes = { message: PropTypes.string, onRetry: PropTypes.func.isRequired };

/** Compact guided empty state with a link to the page that fixes the gap. */
export function WidgetEmpty({ icon, title, body, actionLabel, actionHref }) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-3 py-2">
      <span className="flex size-10 items-center justify-center rounded-[10px] bg-raised text-muted">
        <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
          {icon}
        </span>
      </span>
      <div className="min-w-0">
        <p className="text-[15px] font-semibold text-text">{title}</p>
        <p className="mt-1 text-sm text-muted">{body}</p>
      </div>
      <Button variant="secondary" size="sm" href={actionHref} iconRight="arrow_forward">
        {actionLabel}
      </Button>
    </div>
  );
}

WidgetEmpty.propTypes = {
  icon: PropTypes.string.isRequired,
  title: PropTypes.string.isRequired,
  body: PropTypes.string.isRequired,
  actionLabel: PropTypes.string.isRequired,
  actionHref: PropTypes.string.isRequired,
};
