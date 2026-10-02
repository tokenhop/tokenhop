"use client";

import PropTypes from "prop-types";
import PageTitle from "@/shared/components/PageTitle";
import PeriodControl from "@/shared/components/PeriodControl";
import { deriveCommandCenterStatus } from "@/shared/utils/commandCenter";
import { PERIOD_VALUES } from "@/shared/utils/period";
import { summarizeProviders } from "@/shared/utils/providerHealth";

/**
 * Home page header: derived status line above the in-page H1, plus the period
 * control. The status text is plain English translated at render; the control
 * labels come from the shared period model (zh override lives in PeriodControl).
 *
 * @param {object} props
 * @param {Array<object>} props.connections provider connections for the status line
 * @param {boolean} props.providersLoading true while connections load ("…" line)
 * @param {"today"|"24h"|"7d"|"30d"|"60d"|null} props.period null while the period is unresolved
 * @param {Array<{value: string, label: string}>} props.options period choices from usePeriod
 * @param {(period: string) => void} props.onPeriodChange
 */
export default function HomeHeader({
  connections,
  providersLoading,
  period,
  options,
  onPeriodChange,
}) {
  // One status per provider (worst enabled connection), not one per connection.
  const statuses = Array.isArray(connections)
    ? summarizeProviders([], connections).providers.map(({ status }) => ({ status }))
    : [];
  const statusLine = providersLoading
    ? "Checking provider status…"
    : deriveCommandCenterStatus(
        statuses.map((item) => ({ status: item.status === "off" ? "idle" : item.status })),
      );

  // Home owns the page title in-page (status line above the H1), like provider detail (YAN-314).
  return (
    <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <p aria-live="polite" className="text-sm font-medium text-muted">
          {statusLine}
        </p>
        <PageTitle>Command center</PageTitle>
      </div>
      <PeriodControl
        aria-label="Stats period"
        options={options}
        value={period}
        onChange={onPeriodChange}
        className="w-full sm:w-auto sm:shrink-0"
      />
    </div>
  );
}

HomeHeader.propTypes = {
  connections: PropTypes.arrayOf(PropTypes.object),
  providersLoading: PropTypes.bool,
  period: PropTypes.oneOf(PERIOD_VALUES),
  options: PropTypes.arrayOf(PropTypes.shape({ value: PropTypes.string, label: PropTypes.string })),
  onPeriodChange: PropTypes.func.isRequired,
};
