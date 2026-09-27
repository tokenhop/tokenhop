"use client";

import PropTypes from "prop-types";
import { Modal } from "@/shared/components";
import { getConnectionLabel } from "../lib/quotaUtils";
import { formatCreditDate, formatTimeRemaining } from "../lib/resetCreditFormat";

/** Credit expiry details retain loading, error, empty, and credit-table states. */
export default function ResetCreditsDialog({ state, onClose }) {
  return (
    <Modal
      isOpen={Boolean(state)}
      onClose={onClose}
      title="Codex Reset Credit Expiry"
      description={state ? getConnectionLabel(state.connection) || "Codex account" : undefined}
      size="xl"
    >
      {state?.loading ? (
        <p role="status" className="py-10 text-center text-sm text-muted">
          Loading reset credits...
        </p>
      ) : state?.error ? (
        <p
          role="alert"
          className="rounded-xl border border-err bg-err-bg px-3 py-2 text-sm text-err"
        >
          {state.error}
        </p>
      ) : state?.data?.credits?.length ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-xl border border-line bg-raised px-3 py-2 text-xs text-muted">
            <span>
              {state.data.credits.length} reset credit{state.data.credits.length === 1 ? "" : "s"}
            </span>
            <span>{state.data.availableCount ?? 0} available</span>
          </div>
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[560px] text-start text-sm">
              <thead className="bg-raised text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Granted At</th>
                  <th className="px-3 py-2 font-medium">Expires At</th>
                  <th className="px-3 py-2 font-medium">Remaining</th>
                </tr>
              </thead>
              <tbody>
                {state.data.credits.map((credit, index) => (
                  <tr
                    key={`${credit.status}-${credit.expiresAt || index}`}
                    className="border-t border-line"
                  >
                    <td className="px-3 py-2">
                      <span className="rounded-full bg-coral-bg px-2 py-0.5 text-xs font-medium text-coral-ink">
                        {credit.status || "unknown"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted">{formatCreditDate(credit.grantedAt)}</td>
                    <td className="px-3 py-2 text-text">{formatCreditDate(credit.expiresAt)}</td>
                    <td className="px-3 py-2 font-medium text-text">
                      {formatTimeRemaining(credit.expiresAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : state ? (
        <p className="rounded-xl border border-line bg-raised px-3 py-8 text-center text-sm text-muted">
          No reset credit details returned for this account.
        </p>
      ) : null}
    </Modal>
  );
}

ResetCreditsDialog.propTypes = {
  state: PropTypes.shape({
    connection: PropTypes.object,
    loading: PropTypes.bool,
    error: PropTypes.string,
    data: PropTypes.shape({ credits: PropTypes.array, availableCount: PropTypes.number }),
  }),
  onClose: PropTypes.func.isRequired,
};
