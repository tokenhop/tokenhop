"use client";

import PropTypes from "prop-types";
import { ALL_TIME_NOTE, NO_PRIOR, PRIOR_LABELS, trendDelta } from "../lib/tileTrends";

/**
 * Signed percentage vs the previous equal window, or null without a usable
 * baseline. `hero` (lime tiles) drops the ok/err colors — they lack contrast
 * on lime — and inherits the tile's text color.
 * @param {object} props
 * @param {number} [props.current]
 * @param {number} [props.previous]
 * @param {boolean} [props.hero]
 * @returns {React.ReactNode}
 */
export function TrendPct({ current, previous, hero = false }) {
  const delta = trendDelta(current, previous);
  if (delta.kind === "none") return null;
  const tone = hero
    ? ""
    : delta.kind === "up"
      ? " text-ok"
      : delta.kind === "down"
        ? " text-err"
        : " text-muted";
  return (
    <span className={`font-semibold${tone}`}>
      {delta.pct > 0 ? "+" : ""}
      {delta.pct}%
    </span>
  );
}

TrendPct.propTypes = {
  current: PropTypes.number,
  previous: PropTypes.number,
  hero: PropTypes.bool,
};

/**
 * Trend line: signed percentage vs the previous equal window plus the
 * period caption, or muted "No prior data" without a usable baseline.
 * Percentage and caption are separate spans — no concatenated sentence.
 * @param {object} props
 * @param {number} [props.current]
 * @param {number} [props.previous]
 * @param {string} props.period
 * @param {boolean} [props.hero] lime tile: no ok/err/muted colors
 * @returns {React.ReactNode}
 */
export default function TrendLine({ current, previous, period, hero = false }) {
  const muted = hero ? "" : "text-muted";
  if (period === "all") {
    return <span className={muted}>{ALL_TIME_NOTE.caption}</span>;
  }
  if (trendDelta(current, previous).kind === "none") {
    return <span className={muted}>{NO_PRIOR.caption}</span>;
  }
  const caption = (PRIOR_LABELS[period] || PRIOR_LABELS.default).caption;
  return (
    <span>
      <TrendPct current={current} previous={previous} hero={hero} />{" "}
      <span className={muted}>{caption}</span>
    </span>
  );
}

TrendLine.propTypes = {
  current: PropTypes.number,
  previous: PropTypes.number,
  period: PropTypes.string,
  hero: PropTypes.bool,
};

/**
 * Two-metric trend (tokens in / out): `In +12% · Out −3% vs prior 7d`, or
 * "No prior data" when neither side has a baseline. A side without a baseline
 * is omitted. Labels are fixed In/Out JSX literals so the i18n extractor sees them.
 * @param {object} props
 * @param {Array<{label: "In"|"Out", current?: number, previous?: number}>} props.parts
 * @param {string} props.period
 * @param {boolean} [props.hero]
 * @returns {React.ReactNode}
 */
export function PairTrendLine({ parts, period, hero = false }) {
  const muted = hero ? "" : "text-muted";
  if (period === "all") {
    return <span className={muted}>{ALL_TIME_NOTE.caption}</span>;
  }
  const shown = parts.filter((part) => trendDelta(part.current, part.previous).kind !== "none");
  if (shown.length === 0) {
    return <span className={muted}>{NO_PRIOR.caption}</span>;
  }
  const caption = (PRIOR_LABELS[period] || PRIOR_LABELS.default).caption;
  return (
    <span>
      {shown.map((part, index) => (
        <span key={part.label}>
          {index > 0 && " · "}
          {part.label === "In" ? <span>In</span> : <span>Out</span>}{" "}
          <TrendPct current={part.current} previous={part.previous} hero={hero} />
        </span>
      ))}{" "}
      <span className={muted}>{caption}</span>
    </span>
  );
}

PairTrendLine.propTypes = {
  parts: PropTypes.arrayOf(
    PropTypes.shape({
      label: PropTypes.oneOf(["In", "Out"]).isRequired,
      current: PropTypes.number,
      previous: PropTypes.number,
    }),
  ).isRequired,
  period: PropTypes.string,
  hero: PropTypes.bool,
};
