"use client";

import PropTypes from "prop-types";

/**
 * Stat tile: eyebrow, display number, delta line, optional inline-SVG sparkline.
 * `hero` is the lime variant (savings tile).
 */
export default function StatTile({ eyebrow, value, delta, sparkline, hero = false, className }) {
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
      <span className="font-display text-4xl font-bold tabular-nums">{value}</span>
      {delta && <span className={`text-sm ${hero ? "" : "text-muted"}`}>{delta}</span>}
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
            points={sparkline
              .map((point, index) => {
                const max = Math.max(...sparkline);
                const min = Math.min(...sparkline);
                const range = max - min || 1;
                const x = (index / (sparkline.length - 1)) * 100;
                const y = 22 - ((point - min) / range) * 20;
                return `${x},${y}`;
              })
              .join(" ")}
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
  sparkline: PropTypes.arrayOf(PropTypes.number),
  hero: PropTypes.bool,
  className: PropTypes.string,
};
