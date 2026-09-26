"use client";

import PropTypes from "prop-types";
import { Modal, StatusPill } from "@/shared/components";
import ProviderTile from "@/shared/components/ProviderTile";

/**
 * Restyled Signal test results modal.
 * Shows passed/failed/tested summary in Signal pills,
 * and per-connection rows with latency in mono + status/diagnosis pills.
 */
export default function TestResultsModal({ isOpen, onClose, results }) {
  if (!results) return null;

  const { summary, mode, error } = results;
  const items = results.results || [];
  const modeLabel =
    {
      oauth: "OAuth",
      free: "Free",
      apikey: "API Key",
      provider: "Provider",
      all: "All",
    }[mode] || mode;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Test Results" size="lg">
      {error && !items.length ? (
        <div className="py-6 text-center">
          <span
            className="material-symbols-outlined mb-2 block text-[32px] text-err"
            aria-hidden="true"
          >
            error
          </span>
          <p className="text-sm text-err">{error}</p>
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          {summary && (
            <div
              className="mb-1 flex flex-wrap items-center gap-2 text-xs sm:gap-3"
              aria-live="polite"
            >
              <span className="text-muted">{modeLabel} Test</span>
              <StatusPill variant="ok" size="sm">
                {summary.passed} passed
              </StatusPill>
              {summary.failed > 0 && (
                <StatusPill variant="err" size="sm">
                  {summary.failed} failed
                </StatusPill>
              )}
              <span className="text-muted sm:ms-auto">{summary.total} tested</span>
            </div>
          )}

          <div className="flex max-h-[460px] flex-col gap-2 overflow-y-auto pe-1">
            {items.map((r, i) => {
              const diagType = r.diagnosis?.type;
              return (
                <div
                  key={r.connectionId || i}
                  className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-line bg-raised px-3.5 py-2.5 text-xs sm:flex-nowrap"
                >
                  <span
                    className={`material-symbols-outlined text-[18px] ${
                      r.valid ? "text-ok" : "text-err"
                    }`}
                    aria-hidden="true"
                  >
                    {r.valid ? "check_circle" : "error"}
                  </span>
                  <ProviderTile providerId={r.provider} size="sm" />
                  <div className="min-w-0 flex-[1_1_160px]">
                    <span className="block truncate font-medium text-text sm:inline">
                      {r.connectionName}
                    </span>
                    <span className="block truncate text-muted sm:ms-1.5 sm:inline">
                      ({r.provider})
                    </span>
                  </div>
                  {r.latencyMs !== undefined && (
                    <span className="shrink-0 font-mono tabular-nums text-muted">
                      {r.latencyMs}ms
                    </span>
                  )}
                  <StatusPill variant={r.valid ? "ok" : "err"} size="sm">
                    {r.valid ? "OK" : diagType || "ERROR"}
                  </StatusPill>
                </div>
              );
            })}
          </div>

          {items.length === 0 && (
            <div className="py-6 text-center text-sm text-muted">
              No active connections found for this group.
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

TestResultsModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  results: PropTypes.shape({
    mode: PropTypes.string,
    results: PropTypes.array,
    summary: PropTypes.shape({
      total: PropTypes.number,
      passed: PropTypes.number,
      failed: PropTypes.number,
    }),
    error: PropTypes.string,
  }),
};
