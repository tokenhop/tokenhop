"use client";

// Budget state pill shared by Usage > Budgets and the Home budget tile
// (YAN-1833), so both surfaces mark the same row the same way.
import PropTypes from "prop-types";
import StatusPill from "@/shared/components/StatusPill";
import { isOverCap } from "../lib/budgetMeter";

/**
 * Hard/soft notices plus "Over" when a cap is passed (exact, a zero
 * cap counts) before the hard notice is recorded. JSX literals so the i18n
 * extractor catalogs them.
 */
export default function BudgetMarker({ budget, limits }) {
  if (budget.notices?.hard) {
    return (
      <StatusPill variant="err" size="sm">
        Limit hit
      </StatusPill>
    );
  }
  if (limits.some(isOverCap)) {
    return (
      <StatusPill variant="err" size="sm">
        Over
      </StatusPill>
    );
  }
  if (budget.notices?.soft) {
    return (
      <StatusPill variant="warn" size="sm">
        Soft limit reached
      </StatusPill>
    );
  }
  return null;
}

BudgetMarker.propTypes = {
  budget: PropTypes.object.isRequired,
  limits: PropTypes.arrayOf(PropTypes.object).isRequired,
};
