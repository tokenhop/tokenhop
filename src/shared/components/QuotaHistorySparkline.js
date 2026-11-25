"use client";

import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";
import {
  SPARKLINE_VIEW_H,
  SPARKLINE_VIEW_W,
  buildSparklineGeometry,
} from "@/shared/utils/quotaSparkline";
import Tooltip from "@/shared/components/Tooltip";

/**
 * Compact 7-day quota utilization sparkline for a QuotaRow (YAN-422).
 * Fixed 0–100% Y-axis so low usage stays visually low and spikes stand out.
 * Keyboard-focusable Tooltip anchor with discrete JSX text nodes for i18n.
 * Renders null when fewer than 2 samples exist.
 */
export default function QuotaHistorySparkline({ history, className }) {
  const geom = buildSparklineGeometry(history);
  if (!geom) return null;

  const toneClass =
    geom.latestPct >= 80 ? "text-err" : geom.latestPct >= 55 ? "text-warn" : "text-muted";

  return (
    <Tooltip
      text={
        <>
          <span>Used over last 7d</span> <span aria-hidden="true">·</span> <span>Min</span>{" "}
          <span className="tabular-nums">{geom.minPct}%</span> <span aria-hidden="true">·</span>{" "}
          <span>Max</span> <span className="tabular-nums">{geom.maxPct}%</span>{" "}
          <span aria-hidden="true">·</span> <span className="tabular-nums">{geom.count}</span>{" "}
          <span>samples</span>
        </>
      }
    >
      <div
        // biome-ignore lint/a11y/noNoninteractiveTabindex: tooltip anchor must be keyboard-focusable so the tip opens on focus (WCAG 2.1.1).
        tabIndex={0}
        className={cn(
          "flex min-w-0 items-center gap-2 rounded focus-visible:shadow-focus",
          toneClass,
          className,
        )}
        data-testid="quota-history-sparkline"
      >
        <span className="shrink-0 text-[11px] text-muted">7d used</span>
        <svg
          viewBox={`0 0 ${SPARKLINE_VIEW_W} ${SPARKLINE_VIEW_H}`}
          className="h-4 min-w-0 flex-1 overflow-visible"
          aria-hidden="true"
          preserveAspectRatio="none"
        >
          <polygon fill="currentColor" fillOpacity="0.12" points={geom.areaPoints} />
          <polyline
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            points={geom.linePoints}
          />
        </svg>
        <span className="sr-only">
          <span>Used over last 7d</span> {geom.minPct}%–{geom.maxPct}%
        </span>
      </div>
    </Tooltip>
  );
}

QuotaHistorySparkline.propTypes = {
  history: PropTypes.arrayOf(
    PropTypes.shape({
      ts: PropTypes.number.isRequired,
      usedPct: PropTypes.number.isRequired,
    }),
  ),
  className: PropTypes.string,
};
