"use client";

import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";

// Spinner loading (inline actions only; layout-bearing content uses Skeleton)
export function Spinner({ size = "md", className }) {
  const sizes = {
    sm: "text-[16px]",
    md: "text-[24px]",
    lg: "text-[32px]",
    xl: "text-[48px]",
  };

  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn("material-symbols-outlined animate-spin text-coral", sizes[size], className)}
    >
      progress_activity
    </span>
  );
}

// Full page loading
export function PageLoading({ message = "Loading..." }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-bg">
      <Spinner size="xl" />
      <p className="mt-4 text-muted">{message}</p>
    </div>
  );
}

/** Skeleton block: raised surface with the Signal pulse (off under reduced motion). */
export function Skeleton({ className, ...props }) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-[10px] bg-raised", className)}
      {...props}
    />
  );
}

Skeleton.propTypes = { className: PropTypes.string };

/** Skeleton text lines. */
export function SkeletonText({ lines = 3, className }) {
  const rows = Array.from({ length: lines }, (_unused, position) => position);
  return (
    <div className={cn("flex flex-col gap-2", className)} aria-hidden="true">
      {rows.map((position) => (
        <Skeleton
          key={`line-${position}`}
          className={cn("h-3", position === rows.length - 1 ? "w-2/3" : "w-full")}
        />
      ))}
    </div>
  );
}

SkeletonText.propTypes = { lines: PropTypes.number, className: PropTypes.string };

// Card skeleton
export function CardSkeleton() {
  return (
    <div className="rounded-2xl border border-line bg-panel p-6 shadow-card">
      <div className="mb-4 flex items-center justify-between">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="size-10 rounded-[10px]" />
      </div>
      <Skeleton className="mb-2 h-8 w-16" />
      <Skeleton className="h-3 w-20" />
    </div>
  );
}

export default function Loading({ type = "spinner", ...props }) {
  switch (type) {
    case "page":
      return <PageLoading {...props} />;
    case "skeleton":
      return <Skeleton {...props} />;
    case "card":
      return <CardSkeleton {...props} />;
    default:
      return <Spinner {...props} />;
  }
}
