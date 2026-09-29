"use client";

import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { COUNT_UP_MS, formatCount, interpolateCount } from "./countUpMath.js";

/**
 * Animate a number from its previous value to `value` over 600ms. Reuses the
 * caller's formatter for every frame and the settled value; reduced motion
 * updates instantly. Two invisible grid cells reserve both old/new formatted
 * widths while the number changes (no animation-induced layout shift).
 *
 * @param {object} props
 * @param {number} props.value Target value.
 * @param {(value: number) => string} props.format Formatter for static and animated values.
 * @param {string} [props.suffix] Static text immediately after the formatted value.
 * @param {string} [props.className] Additional styling.
 */
export default function CountUp({ value, format, suffix = "", className = "" }) {
  const [display, setDisplay] = useState(value);
  const previous = useRef(value);
  const formatRef = useRef(format);
  formatRef.current = format;
  const [from, setFrom] = useState(value);

  useEffect(() => {
    if (Object.is(previous.current, value)) return undefined;
    const old = previous.current;
    previous.current = value;
    setFrom(old);
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (media.matches || !Number.isFinite(old) || !Number.isFinite(value)) {
      setDisplay(value);
      return undefined;
    }
    let frame;
    let start = null;
    const tick = (now) => {
      if (media.matches) {
        setDisplay(value);
        return;
      }
      if (start === null) start = now;
      const elapsed = now - start;
      setDisplay(interpolateCount(old, value, elapsed));
      if (elapsed < COUNT_UP_MS) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const onMotion = () => {
      if (media.matches) {
        cancelAnimationFrame(frame);
        setDisplay(value);
      }
    };
    media.addEventListener("change", onMotion);
    return () => {
      cancelAnimationFrame(frame);
      media.removeEventListener("change", onMotion);
    };
  }, [value]);

  const target = `${formatCount(value, format)}${suffix}`;
  return (
    <span className={`inline-grid tabular-nums ${className}`.trim()}>
      <span aria-hidden="true" className="invisible col-start-1 row-start-1 whitespace-nowrap">
        {formatCount(from, format)}
        {suffix}
      </span>
      <span aria-hidden="true" className="invisible col-start-1 row-start-1 whitespace-nowrap">
        {target}
      </span>
      <span aria-hidden="true" className="col-start-1 row-start-1 whitespace-nowrap">
        {formatCount(display, format)}
        {suffix}
      </span>
      <span className="sr-only">{target}</span>
    </span>
  );
}

CountUp.propTypes = {
  value: PropTypes.number.isRequired,
  format: PropTypes.func.isRequired,
  suffix: PropTypes.string,
  className: PropTypes.string,
};
