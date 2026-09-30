/**
 * CountUp math (YAN-408), separated from the component so it is unit-testable
 * without a DOM: eased interpolation between the previous and next value over
 * the animation window, and value formatting through the caller's own
 * formatter so an animated number and its static twin render identically.
 */

/** Count-up duration. ~600ms per the design-system motion section. */
export const COUNT_UP_MS = 600;

/** Cubic ease-out: fast start, gentle settle. Clamps t to [0, 1]. */
export const easeOutCubic = (t) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

/**
 * Interpolated value `elapsedMs` into a count-up from `previous` to `next`.
 * @param {number} previous
 * @param {number} next
 * @param {number} elapsedMs
 * @param {number} [durationMs=COUNT_UP_MS]
 * @returns {number}
 */
export function interpolateCount(previous, next, elapsedMs, durationMs = COUNT_UP_MS) {
  const progress = durationMs > 0 ? Math.min(1, Math.max(0, elapsedMs / durationMs)) : 1;
  return previous + (next - previous) * easeOutCubic(progress);
}

/**
 * Format a (possibly mid-animation) value with the caller's formatter. The
 * formatter is the same function used for the static number, so the settled
 * render is byte-identical to the static render (no layout shift).
 * @param {number} value
 * @param {(value: number) => string} format
 * @returns {string}
 */
export function formatCount(value, format) {
  return format(value);
}
