"use client";

import PropTypes from "prop-types";

/**
 * One shared line renderer so the `delta` and `trend` rows can't drift apart.
 */
function mutedLine(hero, children) {
  return <span className={`text-sm ${hero ? "" : "text-muted"}`}>{children}</span>;
}

/**
 * Sparkline polyline points, normalized into the 100×24 viewBox. min/max are
 * derived once per render (outside the per-point map).
 */
function sparkPoints(sparkline) {
  const max = Math.max(...sparkline);
  const min = Math.min(...sparkline);
  const range = max - min || 1;
  return sparkline
    .map((point, index) => {
      const x = (index / (sparkline.length - 1)) * 100;
      const y = 22 - ((point - min) / range) * 20;
      return `${x},${y}`;
    })
    .join(" ");
}

/**
 * Stat tile: eyebrow, display number, delta line, optional trend line, and
 * an optional inline-SVG sparkline. `hero` is the lime variant (savings
 * tile). `trend` renders on its own line under `delta` (both may be set).
 */
export default function StatTile({
  eyebrow,
  value,
  delta,
  trend,
  sparkline,
  hero = false,
  className,
}) {
  return (
    <div
      className={`flex flex-col gap-1 rounded-2xl border p-5 shadow-card ${
        hero ? "border-transparent bg-lime text-on-lime" : "border-line bg-panel text-text"
      }${className ? ` ${className}` : ""}`}
    >
      <span
        className={`text-xs font-semibold uppercase tracking-[0.08em] ${hero ? "" : "text-muted"}`}
      >
        {eyebrow}
      </span>
      <span className="min-w-0 font-display text-4xl font-bold tabular-nums [word-break:break-word]">
        {value}
      </span>
      {delta && mutedLine(hero, delta)}
      {trend && mutedLine(hero, trend)}
      {sparkline && sparkline.length > 1 && (
        <svg
          viewBox="0 0 100 24"
          className="mt-1 h-6 w-full"
          aria-hidden="true"
          preserveAspectRatio="none"
        >
          <polyline
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={sparkPoints(sparkline)}
          />
        </svg>
      )}
    </div>
  );
}

StatTile.propTypes = {
  eyebrow: PropTypes.string.isRequired,
  value: PropTypes.node.isRequired,
  delta: PropTypes.node,
  trend: PropTypes.node,
  sparkline: PropTypes.arrayOf(PropTypes.number),
  hero: PropTypes.bool,
  className: PropTypes.string,
};
