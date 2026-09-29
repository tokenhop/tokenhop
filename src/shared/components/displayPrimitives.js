/**
 * Pure helpers for Signal display primitives (YAN-277).
 * No React/DOM. Fail fast on unsupported input.
 */

/** Semantic status word → pill variant. */
export const STATUS_TO_VARIANT = {
  connected: "ok",
  healthy: "ok",
  active: "ok",
  ok: "ok",
  success: "ok",
  cooldown: "warn",
  warning: "warn",
  low: "warn",
  warn: "warn",
  error: "err",
  empty: "err",
  err: "err",
  oauth: "info",
  info: "info",
  "api-key": "brand",
  brand: "brand",
  live: "live",
  disabled: "neutral",
  off: "neutral",
  neutral: "neutral",
};

/** Signal pill variant → class string (tinted bg + colored text). */
export const PILL_VARIANTS = {
  ok: "bg-ok-bg text-ok",
  warn: "bg-warn-bg text-warn",
  err: "bg-err-bg text-err",
  info: "bg-sky-bg text-sky-ink",
  brand: "bg-coral-bg text-coral-ink",
  live: "bg-lime-bg text-lime-ink",
  neutral: "bg-raised text-muted shadow-[inset_0_0_0_1px_var(--signal-line)]",
};

/**
 * Pill heights: `md` 24, `sm` 20 (compact). `xs` is legacy Badge usage and maps
 * to the 20px compact height (smaller would break the design scale); `lg` 28.
 */
export const PILL_SIZES = {
  xs: "h-5 px-2 text-[11px]",
  sm: "h-5 px-2 text-[11px]",
  md: "h-6 px-2.5 text-xs",
  lg: "h-7 px-3 text-sm",
};

/** Legacy Badge variant names → Signal variant. */
export const LEGACY_PILL_VARIANTS = {
  default: "neutral",
  primary: "brand",
  success: "ok",
  warning: "warn",
  error: "err",
};

/** Every value Badge/StatusPill accept for `variant` (for PropTypes). */
export const PILL_VARIANT_NAMES = [
  ...new Set([
    ...Object.keys(PILL_VARIANTS),
    ...Object.keys(LEGACY_PILL_VARIANTS),
    ...Object.keys(STATUS_TO_VARIANT),
  ]),
];

/**
 * Map a status word to a Signal pill variant.
 * @param {string} status
 * @returns {"ok"|"warn"|"err"|"info"|"brand"|"live"|"neutral"}
 */
export function statusVariant(status) {
  const variant = STATUS_TO_VARIANT[status];
  if (!variant) throw new Error(`statusVariant: unknown status "${status}"`);
  return variant;
}

/**
 * Normalize any accepted pill variant (Signal, legacy Badge, or status word)
 * to a Signal variant. Throws on anything else so typos fail at render time.
 * @param {string} variant
 * @returns {keyof typeof PILL_VARIANTS}
 */
export function resolvePillVariant(variant) {
  if (PILL_VARIANTS[variant]) return variant;
  const mapped = LEGACY_PILL_VARIANTS[variant] ?? STATUS_TO_VARIANT[variant];
  if (!mapped) throw new Error(`resolvePillVariant: unknown variant "${variant}"`);
  return mapped;
}

/**
 * Class string for a Badge/StatusPill variant + size.
 * @param {string} [variant="neutral"]
 * @param {"xs"|"sm"|"md"|"lg"} [size="md"]
 * @returns {string}
 */
export function pillClasses(variant = "neutral", size = "md") {
  const height = PILL_SIZES[size];
  if (!height) throw new Error(`pillClasses: unknown size "${size}"`);
  return `${PILL_VARIANTS[resolvePillVariant(variant)]} ${height}`;
}

/** Fill class for a meter variant. */
export const METER_FILLS = {
  ok: "bg-ok",
  warn: "bg-warn",
  err: "bg-err",
  live: "bg-lime",
  info: "bg-sky",
  brand: "bg-coral",
  neutral: "bg-subtle",
};

const METER_KINDS = new Set(["unlimited", "credits"]);

/**
 * Percent → fill variant. >45 ok, 21–45 warn, ≤20 err.
 * `unlimited` is lime (`live`), `credits` is sky (`info`).
 * @param {number} value
 * @param {"unlimited"|"credits"} [kind]
 * @returns {"ok"|"warn"|"err"|"live"|"info"}
 */
export function meterVariant(value, kind) {
  if (kind !== undefined && !METER_KINDS.has(kind)) {
    throw new Error(`meterVariant: unknown kind "${kind}"`);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`meterVariant: expected a finite number, got ${value}`);
  }
  if (kind === "unlimited") return "live";
  if (kind === "credits") return "info";
  if (value <= 20) return "err";
  if (value <= 45) return "warn";
  return "ok";
}

/**
 * Clamp a meter reading into 0–100 for aria-valuenow and the fill width.
 * @param {number} value
 * @returns {number}
 */
export function meterValue(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`meterValue: expected a finite number, got ${value}`);
  }
  return Math.min(100, Math.max(0, value));
}

/**
 * Shared table header styles (YAN-407, from the boards' `th` spec): 12px
 * semibold muted labels, sentence case (no upper-casing), no background tint.
 * `TABLE_HEAD_ROW` only draws the bottom border; cell padding and alignment
 * stay on each table (`text-end` on numeric columns, `text-start` elsewhere).
 */
export const TABLE_HEAD_ROW = "border-b border-line";
export const TABLE_HEAD_CELL = "whitespace-nowrap text-xs font-semibold text-muted";

/** Terminal line level → text color utility. */
export const TERMINAL_LEVELS = {
  LOG: "signal-terminal-log",
  INFO: "signal-terminal-info",
  WARN: "signal-terminal-warn",
  ERROR: "signal-terminal-error",
  DEBUG: "signal-terminal-debug",
};

/**
 * @param {string} level
 * @returns {string}
 */
export function terminalLevelClass(level) {
  const classes = TERMINAL_LEVELS[level];
  if (!classes) throw new Error(`terminalLevelClass: unknown level "${level}"`);
  return classes;
}
