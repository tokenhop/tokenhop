/**
 * Pure helpers for the Signal action & form primitives (YAN-276).
 *
 * No React/DOM here: variant→class maps, roving-tabindex index math,
 * stepper clamping and clipboard fallback are importable from Node unit tests
 * and reused by the client components in this directory. Fail fast on
 * unsupported input — the components never need fallbacks.
 */

/**
 * Copy `text` to the clipboard. Uses `navigator.clipboard` when available and
 * falls back to a hidden textarea + `execCommand("copy")`. Throws when every
 * path fails, so callers (e.g. CopyField) can surface a real failure instead
 * of pretending the copy worked.
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function copyTextToClipboard(text) {
  if (typeof navigator !== "undefined" && navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(String(text));
      return;
    } catch {
      // Permission or insecure context: fall through to the execCommand path.
    }
  }
  if (typeof document === "undefined") {
    throw new Error("copyTextToClipboard: clipboard API unavailable");
  }
  const textarea = document.createElement("textarea");
  textarea.value = String(text);
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
  if (!ok) {
    throw new Error("copyTextToClipboard: execCommand('copy') failed");
  }
}

/**
 * Clamp a NumberStepper value. Non-finite input (empty string, NaN, undefined)
 * stays un-clamped as the raw value so the stepper can keep an editable
 * partial state; finite input is snapped into [min, max] when those bounds are
 * finite numbers.
 * @param {number|string|undefined} value
 * @param {{min?: number, max?: number}} [bounds]
 * @returns {number|string|undefined}
 */
export function clampNumber(value, { min, max } = {}) {
  if (value === "" || value === undefined || value === null) return value;
  const num = Number(value);
  if (!Number.isFinite(num)) return value;
  let out = num;
  if (Number.isFinite(min)) out = Math.max(min, out);
  if (Number.isFinite(max)) out = Math.min(max, out);
  return out;
}

/**
 * Next value after one NumberStepper step. Non-numeric starting values start
 * from `min` (or 0). The result is clamped into [min, max]; the last digit
 * precision is preserved so 0.1 + 0.2 ≠ 0.30000000000000004.
 * @param {number|string|undefined} value
 * @param {{min?: number, max?: number, step?: number, direction: 1|-1}} opts
 * @returns {number}
 */
export function stepNumber(value, { min, max, step = 1, direction } = {}) {
  const empty = value === "" || value === undefined || value === null;
  const base = empty ? Number.NaN : Number(clampNumber(value, { min, max }));
  const num = Number.isFinite(base) ? base : Number.isFinite(min) ? min : 0;
  const raw = num + direction * step;
  const decimals = Math.max(
    String(step).split(".")[1]?.length ?? 0,
    String(num).split(".")[1]?.length ?? 0,
  );
  const rounded = Number(raw.toFixed(Math.min(decimals, 10)));
  return clampNumber(rounded, { min, max });
}

/**
 * Roving-tabindex index math for WAI-ARIA radio groups, segmented controls and
 * tablists. `ArrowRight`/`ArrowDown` move to the next option, `ArrowLeft`/
 * `ArrowUp` to the previous, wrapping around; `Home`/`End` jump to the ends.
 * When `rtl` is true the left/right arrows swap direction (up/down are
 * direction-neutral and unchanged). Returns the current index for keys that
 * are not navigation keys.
 * @param {number} index - current index
 * @param {string} key - `event.key`
 * @param {{length: number, rtl?: boolean}} opts
 * @returns {number}
 */
export function nextRovingIndex(index, key, { length, rtl = false } = {}) {
  if (!Number.isInteger(length) || length <= 0) return index;
  const i = ((index % length) + length) % length;
  switch (key) {
    case "ArrowRight":
      return (i + (rtl ? -1 : 1) + length) % length;
    case "ArrowLeft":
      return (i + (rtl ? 1 : -1) + length) % length;
    case "ArrowDown":
      return (i + 1) % length;
    case "ArrowUp":
      return (i - 1 + length) % length;
    case "Home":
      return 0;
    case "End":
      return length - 1;
    default:
      return i;
  }
}

/** True when `key` is handled by {@link nextRovingIndex}. */
export function isRovingKey(key) {
  return ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(key);
}

/**
 * Button variant → class map. Pure so unit tests pin every variant/size, and
 * the component just composes. Variant class strings use Signal tokens only.
 */
export const BUTTON_VARIANTS = {
  primary:
    "bg-lime text-on-lime border border-transparent shadow-[inset_0_0_0_1px_rgba(0,0,0,0.14)] hover:brightness-95",
  secondary: "bg-raised text-text border border-line hover:bg-line/60",
  ghost: "bg-transparent text-text border border-line hover:bg-raised",
  danger: "bg-err-bg text-err border border-transparent hover:bg-err/15",
  outline: "bg-transparent text-muted border border-line hover:bg-raised hover:text-text",
  success: "bg-ok-bg text-ok border border-transparent hover:bg-ok/15",
};

/**
 * Button size → class map. `md` is the 44px target, `sm` 40px (dense tables);
 * `lg` keeps working for the zero existing call sites that pass it.
 */
export const BUTTON_SIZES = {
  sm: "h-10 px-3 text-sm rounded-lg",
  md: "h-11 px-4 text-sm rounded-lg",
  lg: "h-11 px-6 text-sm rounded-lg",
};

/**
 * SegmentedControl / Tabs size → height/text map (design-system §6: selected
 * is inverted text-on-ground, container raised with a 1px line ring).
 */
export const SEGMENTED_SIZES = {
  sm: "h-9 text-xs",
  md: "h-9 text-sm",
  lg: "h-11 text-sm",
};

/**
 * Resolve a button variant+size to its class list. Throws on an unknown
 * variant or size so a typo fails at render time instead of shipping an
 * unstyled button.
 * @param {string} variant
 * @param {string} size
 * @returns {string}
 */
export function buttonClasses(variant = "primary", size = "md") {
  const v = BUTTON_VARIANTS[variant];
  if (!v) throw new Error(`buttonClasses: unknown variant "${variant}"`);
  const s = BUTTON_SIZES[size];
  if (!s) throw new Error(`buttonClasses: unknown size "${size}"`);
  return `${v} ${s}`;
}

/**
 * Build the `aria-describedby` id list for a Field control: hint id when a
 * hint is present and no error, error id when an error is present (errors win
 * over hints, matching the visible UI). Returns undefined when neither exists
 * so callers can omit the attribute.
 * @param {string} id - control id
 * @param {{hint?: unknown, error?: unknown}} state
 * @returns {string|undefined}
 */
export function describedByFor(id, { hint, error } = {}) {
  if (error) return `${id}-error`;
  if (hint) return `${id}-hint`;
  return undefined;
}

/**
 * WAI-ARIA tabs: a tabpanel is a tab stop (`tabIndex=0`) only when it renders
 * content. Tabs used purely as a view switcher have empty panels, which must
 * not add an invisible focus stop.
 * @param {unknown} content - the panel's React node
 * @returns {boolean}
 */
export function hasPanelContent(content) {
  return content !== undefined && content !== null && content !== false && content !== "";
}
