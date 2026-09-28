"use client";

import PropTypes from "prop-types";
import { METER_FILLS, meterValue, meterVariant } from "./displayPrimitives";

/**
 * Signal meter. 8px track, fill colored by level (>45 ok, 21–45 warn, ≤20 err).
 * `unlimited` = lime, `credits` = sky. Exposes `role="meter"`.
 *
 * @param {object} props
 * @param {number} props.value 0–100.
 * @param {"unlimited"|"credits"} [props.kind]
 * @param {string} props.label Accessible name (aria-label), required.
 * @param {string} [props.valueText] Human-readable value for screen readers.
 * @param {string} [props.className]
 */
export default function Meter({ value, kind, label, valueText, className }) {
  if (!label) throw new Error("Meter: `label` is required for the meter accessible name");
  const clamped = meterValue(value);
  const fill = meterVariant(clamped, kind);
  return (
    // biome-ignore lint/a11y/useSemanticElements: native <meter> cannot take the Signal track/fill styling cross-browser; ARIA meter carries the same semantics.
    <div
      role="meter"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={valueText}
      aria-label={label}
      className={`h-2 w-full overflow-hidden rounded-pill bg-raised shadow-[inset_0_0_0_1px_var(--signal-line)]${className ? ` ${className}` : ""}`}
    >
      <div
        className={`h-full rounded-pill ${METER_FILLS[fill]}`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

Meter.propTypes = {
  value: PropTypes.number.isRequired,
  kind: PropTypes.oneOf(["unlimited", "credits"]),
  label: PropTypes.string.isRequired,
  valueText: PropTypes.string,
  className: PropTypes.string,
};

/**
 * Segmented health bar: one Meter cell per account/segment.
 *
 * @param {object} props
 * @param {{value: number, kind?: "unlimited"|"credits", label: string}[]} props.segments
 */
export function SegmentedHealthBar({ segments, className }) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("SegmentedHealthBar: needs at least one segment");
  }
  return (
    <fieldset
      aria-label="Account health"
      className={`m-0 grid min-w-0 auto-cols-fr grid-flow-col gap-1 border-0 p-0${className ? ` ${className}` : ""}`}
    >
      {segments.map((segment, index) => (
        <Meter
          key={`${segment.label ?? "segment"}-${index}`}
          value={segment.value}
          kind={segment.kind}
          label={segment.label}
          className="rounded-sm shadow-none"
        />
      ))}
    </fieldset>
  );
}

SegmentedHealthBar.propTypes = {
  segments: PropTypes.arrayOf(
    PropTypes.shape({
      value: PropTypes.number.isRequired,
      kind: PropTypes.oneOf(["unlimited", "credits"]),
      label: PropTypes.string.isRequired,
    }),
  ).isRequired,
  className: PropTypes.string,
};
