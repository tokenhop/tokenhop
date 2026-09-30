"use client";

import PropTypes from "prop-types";
import {
  formatResetTime,
  getRemainingPercentage,
} from "@/app/(dashboard)/dashboard/quota/lib/quotaUtils.js";
import Meter from "@/shared/components/Meter";
import QuotaForecastLine from "@/shared/components/QuotaForecastLine";

/**
 * Signal quota row: name, level-colored remaining text,
 * a shared `Meter` fill, and the reset text (relative + absolute).
 *
 * The hide button is revealed on row hover or keyboard focus on devices that
 * hover; touch devices (no hover) always show it. It stays in the tab order.
 *
 * Handles special rows per parity with the old QuotaTable:
 * - `unlimited` rows show "Unlimited" in level lime with no meter
 * - `isCreditBalance` rows show "Credit: $x" in level sky with no meter
 * - `recurring: false` rows are worded as "expires in {x}"
 *
 * @param {object} props
 * @param {object} props.quota Normalized quota row.
 * @param {boolean} [props.compact] Single-line reset text.
 * @param {() => void} [props.onHide] Hide-row action (eye-off button).
 */
export default function QuotaRow({ quota, compact = false, onHide }) {
  const isUnlimited = quota.unlimited === true;
  const isCredit = quota.isCreditBalance === true;
  const remaining = getRemainingPercentage(quota);
  const kind = isUnlimited ? "unlimited" : isCredit ? "credits" : undefined;

  const levelClass = isUnlimited
    ? "text-lime-ink dark:text-lime"
    : isCredit
      ? "text-sky"
      : remaining <= 20
        ? "text-err"
        : remaining <= 45
          ? "text-warn"
          : "text-ok";

  const usedText = Number(quota.used || 0).toLocaleString();
  const totalText = quota.total > 0 ? Number(quota.total).toLocaleString() : "∞";

  const headline = isUnlimited
    ? `${usedText} used · Unlimited`
    : isCredit
      ? `Credit: ${Number(quota.total).toFixed(2)} ${quota.currency || ""}`.trim()
      : `${usedText} / ${totalText}`;

  const tail = isUnlimited ? "Unlimited" : isCredit ? "" : `${remaining}%`;

  const countdown = formatResetTime(quota.resetAt);
  const resetDisplay = quota.resetAt ? formatAbsoluteReset(quota.resetAt) : null;
  const recurring = quota.recurring !== false;
  const countdownLabel =
    countdown !== "-" ? (recurring ? `in ${countdown}` : `expires in ${countdown}`) : null;

  return (
    <div className="group flex min-w-0 flex-col gap-1.5" data-testid="quota-row">
      <div className="flex min-w-0 items-baseline gap-2 text-[13px]">
        <span className="min-w-0 flex-1 truncate font-semibold text-text">{quota.name}</span>
        <span className={`shrink-0 font-semibold tabular-nums ${levelClass}`}>
          {tail || headline}
        </span>
      </div>

      {!isUnlimited && !isCredit && (
        <Meter
          value={remaining}
          kind={kind}
          label={`${quota.name} quota: ${remaining}% left`}
          valueText={`${remaining}% left`}
        />
      )}

      {!isUnlimited && !isCredit && <QuotaForecastLine forecast={quota.forecast} />}

      <div className="flex min-w-0 items-center gap-2">
        <span
          className="min-w-0 flex-1 truncate text-xs text-muted"
          title={resetDisplay || undefined}
        >
          {compact ? (
            countdownLabel || resetDisplay || "N/A"
          ) : (
            <>
              {countdownLabel && <span className="font-medium text-text">{countdownLabel}</span>}
              {countdownLabel && resetDisplay && " · "}
              {resetDisplay && <span>{resetDisplay}</span>}
              {!countdownLabel && !resetDisplay && <span className="italic">N/A</span>}
            </>
          )}
        </span>

        {typeof onHide === "function" && (
          <button
            type="button"
            onClick={() => onHide(quota)}
            className="-my-3 inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-muted transition-[opacity,color,background-color] hover:bg-raised hover:text-text focus-visible:shadow-focus [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100"
            title="Hide this quota row"
            aria-label={`Hide quota ${quota.name}`}
          >
            <span className="material-symbols-outlined text-[15px]" aria-hidden="true">
              visibility_off
            </span>
          </button>
        )}
      </div>

      <span className="sr-only">{headline}</span>
    </div>
  );
}

QuotaRow.propTypes = {
  quota: PropTypes.shape({
    name: PropTypes.string,
    used: PropTypes.number,
    total: PropTypes.number,
    remaining: PropTypes.number,
    remainingPercentage: PropTypes.number,
    unlimited: PropTypes.bool,
    isCreditBalance: PropTypes.bool,
    currency: PropTypes.string,
    resetAt: PropTypes.string,
    recurring: PropTypes.bool,
    forecast: PropTypes.object,
  }).isRequired,
  compact: PropTypes.bool,
  onHide: PropTypes.func,
};

/**
 * Absolute reset display ("Today, 2:20 PM" / "Tomorrow, 9:00 AM" / "Oct 3, 6:00 PM").
 * @param {string|Date} resetTime
 * @returns {string|null}
 */
export function formatAbsoluteReset(resetTime) {
  if (!resetTime) return null;
  try {
    const date = new Date(resetTime);
    if (Number.isNaN(date.getTime())) return null;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dayAfter = new Date(tomorrow);
    dayAfter.setDate(dayAfter.getDate() + 1);

    let dayStr;
    if (date >= today && date < tomorrow) dayStr = "Today";
    else if (date >= tomorrow && date < dayAfter) dayStr = "Tomorrow";
    else dayStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });

    const timeStr = date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    return `${dayStr}, ${timeStr}`;
  } catch {
    return null;
  }
}
