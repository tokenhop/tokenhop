"use client";

import PropTypes from "prop-types";
import { EDGE_STATE_LABEL, edgeLabel, edgeStyle } from "@/shared/utils/routesMap";

/**
 * One route edge: a wide transparent hit path, the visible styled line(s) and
 * a label that appears on hover/focus (CSS, `.routes-map-edge`). The group is
 * keyboard-focusable and announces the full route via `aria-label`; a native
 * `<title>` mirrors it as a tooltip.
 *
 * @param {object} props
 * @param {{ from: string|null, to: string, state: string, count?: number, lastAt?: string|null }} props.edge
 * @param {Array<string>} props.segments SVG path data, client→hub (and hub→provider)
 * @param {number} props.labelX label anchor x
 * @param {number} props.labelY label anchor y
 */
export function RouteEdge({ edge, segments, labelX, labelY }) {
  const style = edgeStyle(edge.state);
  // The 1.1s dash flow is motion-safe; reduced motion strips it via globals.css.
  const lineClass = style.animated
    ? "routes-map-edge-line motion-safe:animate-flow"
    : "routes-map-edge-line";
  const visible = edge.from || EDGE_STATE_LABEL[edge.state] || edge.state;
  return (
    // biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: the SVG edge must be keyboard-focusable so its label is reachable on focus (WCAG 2.1.1, YAN-412); role="img" carries the route description as its accessible name.
    <g className="routes-map-edge" tabIndex={0} role="img" aria-label={edgeLabel(edge)}>
      {segments.map((d) => (
        <path key={d} d={d} fill="none" stroke="transparent" strokeWidth={16} />
      ))}
      {segments.map((d) => (
        <path
          key={d}
          className={lineClass}
          d={d}
          fill="none"
          stroke={style.stroke}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={style.dash || undefined}
        />
      ))}
      {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: the visible label duplicates the group's aria-label; hiding it keeps screen readers from reading both. */}
      <text
        className="routes-map-edge-label"
        x={labelX}
        y={labelY}
        textAnchor="middle"
        fontSize={11}
        fontWeight={500}
        fill="var(--signal-text)"
        style={{
          paintOrder: "stroke",
          stroke: "var(--signal-panel)",
          strokeWidth: 4,
          pointerEvents: "none",
        }}
        aria-hidden="true"
      >
        {visible.length > 24 ? `${visible.slice(0, 23)}…` : visible}
      </text>
      <title>{edgeLabel(edge)}</title>
    </g>
  );
}

RouteEdge.propTypes = {
  edge: PropTypes.shape({
    from: PropTypes.string,
    to: PropTypes.string.isRequired,
    state: PropTypes.string.isRequired,
    count: PropTypes.number,
    lastAt: PropTypes.string,
  }).isRequired,
  segments: PropTypes.arrayOf(PropTypes.string).isRequired,
  labelX: PropTypes.number.isRequired,
  labelY: PropTypes.number.isRequired,
};
