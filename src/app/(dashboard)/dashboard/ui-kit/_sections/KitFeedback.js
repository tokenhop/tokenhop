"use client";

import { useState } from "react";
import Button from "@/shared/components/Button";
import Callout from "@/shared/components/Callout";
import EmptyState from "@/shared/components/EmptyState";
import { CardSkeleton, Skeleton, SkeletonText, Spinner } from "@/shared/components/Loading";
import { ErrorState, LoadingState } from "@/shared/components/StateViews";
import Terminal from "@/shared/components/Terminal";
import { useNotificationStore } from "@/store/notificationStore";

const LINES = [
  { id: "kit-log-1", time: "14:02:11", level: "LOG", message: "Gateway listening on :20128" },
  { id: "kit-log-2", time: "14:02:12", level: "INFO", message: "Loaded 14 provider connections" },
  {
    id: "kit-log-3",
    time: "14:03:40",
    level: "WARN",
    message: "gemini-cli rate limited, cooling down 2m 14s",
  },
  { id: "kit-log-4", time: "14:03:41", level: "ERROR", message: "kimi token refresh failed (401)" },
  {
    id: "kit-log-5",
    time: "14:03:42",
    level: "DEBUG",
    message: "combo coder -> openrouter/qwen3-coder",
  },
];

/** Kit section: callouts, empty state, skeletons, state views, toast action and terminal. */
export default function KitFeedback() {
  const notify = useNotificationStore();
  const [undoCount, setUndoCount] = useState(0);

  const showUndo = () => {
    notify.error("Couldn't save the combo. Your previous version is still active.", {
      action: {
        label: "Undo",
        onSelect: () => {
          setUndoCount((count) => count + 1);
          notify.success("Undone");
        },
      },
    });
  };

  return (
    <section aria-labelledby="kit-feedback" className="flex flex-col gap-4">
      <h2 id="kit-feedback" className="font-display text-xl font-bold">
        Feedback
      </h2>
      <div className="grid gap-3 md:grid-cols-2">
        <Callout variant="info" title="Info">
          <span dir="auto">Point any client at your endpoint.</span>
        </Callout>
        <Callout variant="warn" title="Cooling down">
          <span dir="auto">Gemini CLI hit a rate limit.</span>
        </Callout>
        <Callout variant="err" title="Sign-in expired">
          <span dir="auto">Requests are skipping this provider.</span>
        </Callout>
        <Callout variant="ok" title="Saved">
          <span dir="auto">All changes saved.</span>
        </Callout>
      </div>
      <div className="rounded-2xl border border-line bg-panel p-6 shadow-card">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" icon="undo" onClick={showUndo}>
            Error toast with undo
          </Button>
          <p aria-live="polite" className="text-xs text-muted">
            {undoCount > 0 ? `Undo pressed ${undoCount} time${undoCount === 1 ? "" : "s"}.` : ""}
          </p>
        </div>
      </div>
      <div className="rounded-2xl border border-line bg-panel shadow-card">
        <EmptyState
          icon="hub"
          title="No providers yet"
          body={
            <span dir="auto">
              Connect a provider to start routing traffic through your endpoint.
            </span>
          }
          action={<Button icon="add">Add provider</Button>}
        />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <CardSkeleton />
        <div className="rounded-2xl border border-line bg-panel p-6 shadow-card">
          <Skeleton className="mb-3 h-5 w-32" />
          <SkeletonText lines={3} />
        </div>
        <div className="flex items-center justify-center rounded-2xl border border-line bg-panel p-6 shadow-card">
          <Spinner size="lg" />
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-line bg-panel p-6 shadow-card">
          <p
            data-i18n-skip="true"
            className="mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-muted"
          >
            LoadingState
          </p>
          <LoadingState lines={3} label="Loading demo widget" />
        </div>
        <div className="rounded-2xl border border-line bg-panel p-6 shadow-card">
          <p
            data-i18n-skip="true"
            className="mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-muted"
          >
            ErrorState
          </p>
          <ErrorState
            title="Could not load this widget"
            message="The backend did not answer in time."
            onRetry={() => notify.info("Retry demo pressed")}
          />
        </div>
      </div>
      <Terminal lines={LINES} />
    </section>
  );
}
