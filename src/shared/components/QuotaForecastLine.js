"use client";

import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";
import { describeForecast } from "@/shared/utils/quotaForecast";
import Tooltip from "@/shared/components/Tooltip";

const TONE_CLASS = {
  err: "text-err",
  warn: "text-warn",
  muted: "text-muted",
};

const ICON_SIZE_CLASS = "material-symbols-outlined text-[14px] shrink-0";

/**
 * Compact quota runway forecast line: state icon, lead phrase and the
 * approximate time to empty, with an optional "resets in" tail. The whole
 * line is a focusable Tooltip anchor (hover or keyboard) whose tip shows the
 * burn rate and sample window.
 *
 * Every fixed phrase is its own JSX text-node literal so the runtime DOM
 * translator can match it; only the dynamic values (times, numbers) come
 * from helpers. The visible (translated) text is the accessible name, so no
 * English-only aria-label. Status is never color-only: icon + distinct lead.
 *
 * @param {object} props
 * @param {object|null|undefined} props.forecast Forecast object from the server contract; unknown/missing renders null.
 * @param {boolean} [props.showReset=false] Append "resets in ~1d 18h" when a reset time exists.
 * @param {string} [props.className] Extra classes for the line.
 */
export default function QuotaForecastLine({ forecast, showReset = false, className }) {
  const described = describeForecast(forecast);
  if (!described) return null;
  const { state, tone, icon, emptyIn, resetsIn, burnRate, sampleWindow } = described;
  const leadClass = tone === "muted" ? undefined : "font-medium";

  return (
    <Tooltip
      text={
        <>
          <span>Burn rate</span> <span className="tabular-nums">{burnRate}</span>{" "}
          <span aria-hidden="true">·</span> <span>Sample window</span>{" "}
          <span className="tabular-nums">{sampleWindow}</span>
        </>
      }
    >
      <span
        // biome-ignore lint/a11y/noNoninteractiveTabindex: tooltip anchor must be keyboard-focusable so the tip opens on focus (WCAG 2.1.1, YAN-401).
        tabIndex={0}
        className={cn(
          "-my-3 flex min-w-0 items-center gap-1.5 rounded py-3 text-xs focus-visible:shadow-focus",
          TONE_CLASS[tone],
          className,
        )}
      >
        <span aria-hidden="true" className={ICON_SIZE_CLASS}>
          {icon}
        </span>
        {state === "will-run-out" && (
          <>
            <span className={leadClass}>At this pace, empty in</span>{" "}
            {emptyIn && <span className="tabular-nums">{emptyIn}</span>}
          </>
        )}
        {state === "tight" && (
          <>
            <span className={leadClass}>Cutting it close, empty in</span>{" "}
            {emptyIn && <span className="tabular-nums">{emptyIn}</span>}
          </>
        )}
        {state === "on-track" && <span className={leadClass}>On track</span>}
        {state === "idle" && <span className={leadClass}>Idle lately</span>}
        {showReset && resetsIn ? (
          <>
            {" "}
            <span aria-hidden="true">·</span> <span>resets in</span>{" "}
            <span className="tabular-nums">{resetsIn}</span>
          </>
        ) : null}
      </span>
    </Tooltip>
  );
}

QuotaForecastLine.propTypes = {
  forecast: PropTypes.shape({
    state: PropTypes.string,
    emptyAt: PropTypes.string,
    resetAt: PropTypes.string,
    burnPctPerHour: PropTypes.number,
    sampleSpanMs: PropTypes.number,
  }),
  showReset: PropTypes.bool,
  className: PropTypes.string,
};
