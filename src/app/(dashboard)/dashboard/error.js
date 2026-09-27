"use client";

import PropTypes from "prop-types";
import { ErrorState } from "@/shared/components/StateViews";
import { copyTextToClipboard } from "@/shared/components/formPrimitives";
import { useNotificationStore } from "@/store/notificationStore";
import { getCopyableErrorDetails } from "./errorDetails";

/** Dashboard render errors stay visible and retryable inside the Signal shell. */
export default function DashboardError({ error, reset }) {
  const notify = useNotificationStore();
  const copyDetails = async () => {
    try {
      // Client-side error text can carry secrets, so only copy the server
      // digest (or fixed support text), never the raw message.
      await copyTextToClipboard(getCopyableErrorDetails(error));
      notify.success("Error details copied");
    } catch {
      notify.error("Could not copy error details");
    }
  };

  return (
    <section className="rounded-[20px] border border-line bg-panel p-6 shadow-card">
      <h1 className="mb-4 font-display text-2xl font-bold text-text">Dashboard error</h1>
      <ErrorState
        title="This page could not load"
        message="Try again. If it keeps failing, copy the error details for support."
        onRetry={reset}
      >
        <button
          type="button"
          onClick={copyDetails}
          className="inline-flex h-10 items-center rounded-lg border border-line px-3 text-sm font-semibold text-text hover:bg-raised focus-visible:shadow-focus"
        >
          Copy details
        </button>
      </ErrorState>
      {process.env.NODE_ENV === "development" && (
        <pre className="mt-4 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-raised p-3 font-mono text-xs text-err">
          {error.message}
        </pre>
      )}
    </section>
  );
}

DashboardError.propTypes = {
  error: PropTypes.shape({ message: PropTypes.string, digest: PropTypes.string }).isRequired,
  reset: PropTypes.func.isRequired,
};
