/**
 * Pure helpers for Signal overlays (YAN-278).
 * No React. Focus cycling, ref-counted scroll lock, menu typeahead, class maps.
 */

/** Next tabbable index. -1 when the list is empty. Out-of-range index means focus is outside. */
export function cycleTabFocus(index, length, shift = false) {
  if (!Number.isInteger(length) || length <= 0) return -1;
  if (!Number.isInteger(index) || index < 0 || index >= length) return shift ? length - 1 : 0;
  return shift ? (index - 1 + length) % length : (index + 1) % length;
}

function scrollbarGutter(doc) {
  const view = doc.defaultView;
  if (!view || !doc.documentElement) return 0;
  return Math.max(0, view.innerWidth - doc.documentElement.clientWidth);
}

/**
 * Ref-counted body scroll lock. Nested overlays share one lock.
 * Extra unlocks at zero are no-ops. Restores overflow and padding-inline-end.
 * @param {Document} [doc]
 */
export function createScrollLock(doc) {
  let count = 0;
  let saved = null;
  return {
    get count() {
      return count;
    },
    lock(target = doc) {
      if (!target?.body) throw new Error("createScrollLock: document with body required");
      if (count === 0) {
        saved = {
          overflow: target.body.style.overflow,
          paddingInlineEnd: target.body.style.paddingInlineEnd,
        };
        target.body.style.overflow = "hidden";
        const gutter = scrollbarGutter(target);
        if (gutter > 0) target.body.style.paddingInlineEnd = `${gutter}px`;
      }
      count += 1;
      return count;
    },
    unlock(target = doc) {
      if (count === 0) return 0;
      count -= 1;
      if (count === 0 && saved && target?.body) {
        target.body.style.overflow = saved.overflow;
        target.body.style.paddingInlineEnd = saved.paddingInlineEnd;
        saved = null;
      }
      return count;
    },
  };
}

/** Shared lock used by useScrollLock. */
export const scrollLock = createScrollLock();

/** Stack of Escape handlers. The top handler wins so nested overlays close inside-out. */
export function createDismissStack() {
  const stack = [];
  return {
    push(handler) {
      stack.push(handler);
      return stack.length;
    },
    pop(handler) {
      const index = stack.lastIndexOf(handler);
      if (index >= 0) stack.splice(index, 1);
      return stack.length;
    },
    top() {
      return stack.length ? stack[stack.length - 1] : null;
    },
  };
}

/** A tooltip shows only while open, enabled and with non-empty text. */
export function tooltipVisible(open, disabled, text) {
  return Boolean(open) && !disabled && text != null && text !== false && text !== "";
}

/**
 * Decision logic for the ConfirmDialog busy lifecycle, DOM-free and testable.
 * A ref lock prevents double-invoking `onConfirm`; a request id plus the
 * live `isOpen` flag let stale settles (from a previous open) be ignored.
 */

/** True when a new confirm press may start (not locked, not busy). */
export function confirmMayStart(lockRef, busy) {
  return !lockRef?.current && !busy;
}

/**
 * True when a settled confirm request may still write state: it is the
 * latest request and the dialog is still open.
 */
export function confirmSettleFresh(requestId, latestRef, isOpen) {
  return latestRef?.current === requestId && Boolean(isOpen);
}

export const dismissStack = createDismissStack();

/** Stack of active focus traps. Only the top trap handles Tab (nested overlays). */
export const trapStack = createDismissStack();

/**
 * True when `el` renders (has layout boxes). Uses `checkVisibility` when the
 * browser has it, so `visibility:hidden` / `display:none` ancestors are excluded.
 * @param {Element} el
 */
export function isElementVisible(el) {
  if (!el || typeof el.getClientRects !== "function") return false;
  if (el.getClientRects().length === 0) return false;
  if (typeof el.checkVisibility === "function") {
    return el.checkVisibility({ visibilityProperty: true });
  }
  return true;
}

/**
 * Roving index that skips disabled items. Delegates key math to `nextIndex`
 * (e.g. formPrimitives.nextRovingIndex) and keeps stepping in the same
 * direction past disabled entries. Home/End land on the first/last enabled.
 * Returns `index` unchanged when every item is disabled.
 * @param {number} index
 * @param {string} key
 * @param {boolean[]} disabled
 * @param {(i: number, key: string, opts: {length: number, rtl?: boolean}) => number} nextIndex
 * @param {{rtl?: boolean}} [opts]
 */
export function nextEnabledIndex(index, key, disabled, nextIndex, { rtl = false } = {}) {
  const length = disabled.length;
  if (length === 0 || disabled.every(Boolean)) return index;
  if (key === "Home") return disabled.indexOf(false);
  if (key === "End") return disabled.lastIndexOf(false);
  let next = nextIndex(index, key, { length, rtl });
  for (let step = 0; step < length && disabled[next]; step += 1) {
    next = nextIndex(next, key, { length, rtl });
  }
  return disabled[next] ? index : next;
}

/** First enabled index at or after `start` (wrapping), -1 when none. */
export function firstEnabledIndex(disabled, start = 0, backward = false) {
  const length = disabled.length;
  for (let step = 0; step < length; step += 1) {
    const i = backward ? (start - step + length * 2) % length : (start + step) % length;
    if (!disabled[i]) return i;
  }
  return -1;
}

/**
 * Menu typeahead. A single character (or a repeated run of it) searches forward from the next item.
 * A multi-character buffer matches a prefix starting at the current item.
 * @param {string[]} labels
 * @param {string} buffer
 * @param {number} currentIndex
 * @param {boolean[]} [disabled] Indexes skipped while matching.
 * @returns {number}
 */
export function matchMenuTypeahead(labels, buffer, currentIndex = -1, disabled) {
  const query = String(buffer ?? "").toLowerCase();
  const length = labels?.length ?? 0;
  if (!query || length === 0) return currentIndex;
  const repeated = [...query].every((char) => char === query[0]);
  const stepFromNext = query.length === 1 || repeated;
  const needle = stepFromNext ? query[0] : query;
  for (let step = 0; step < length; step += 1) {
    const index = stepFromNext
      ? (currentIndex + 1 + step + length) % length
      : (Math.max(currentIndex, 0) + step) % length;
    if (!disabled?.[index] && String(labels[index]).toLowerCase().startsWith(needle)) return index;
  }
  return currentIndex;
}

/** Keystrokes closer together than this extend one typeahead search (APG ~500ms). */
export const TYPEAHEAD_TIMEOUT_MS = 500;

/**
 * One typeahead keystroke (APG menu). Pure: pass the previous session and a timestamp.
 * Keys within `TYPEAHEAD_TIMEOUT_MS` of the previous key extend the buffer;
 * a later key starts a new one. The first key searches from the item after
 * `currentIndex`; extending keys match the whole buffer as a prefix starting
 * at the session's last match, so `s` then `h` on
 * [Change Log, Theme, Shutdown, Logout] lands on Shutdown even if focus has
 * not caught up yet.
 * @param {{buffer: string, at: number, index: number} | null} session Previous state (null to start).
 * @param {string} key Printable key (`event.key`, length 1).
 * @param {number} now Timestamp in ms (e.g. `event.timeStamp`).
 * @param {string[]} labels
 * @param {number} currentIndex Focused item when the key arrived.
 * @param {boolean[]} [disabled]
 * @returns {{session: {buffer: string, at: number, index: number}, index: number}}
 */
export function typeaheadStep(session, key, now, labels, currentIndex, disabled) {
  const extend = Boolean(session) && now >= session.at && now - session.at < TYPEAHEAD_TIMEOUT_MS;
  const buffer = (extend ? session.buffer : "") + String(key);
  const from = extend ? session.index : currentIndex;
  const index = matchMenuTypeahead(labels, buffer, from, disabled);
  // No match keeps focus where it was, not on the session anchor.
  const result = index === from && !extend ? currentIndex : index;
  return { session: { buffer, at: now, index: result }, index: result };
}

export const MODAL_SIZES = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
  full: "max-w-4xl",
};

/** @param {string} [size="md"] */
export function modalSizeClass(size = "md") {
  const classes = MODAL_SIZES[size];
  if (!classes) throw new Error(`modalSizeClass: unknown size "${size}"`);
  return classes;
}

export const DRAWER_WIDTHS = {
  sm: "w-[400px] max-w-full",
  md: "w-[500px] max-w-full",
  lg: "w-[600px] max-w-full",
  xl: "w-[800px] max-w-full",
  full: "w-full",
  nav: "w-[280px] max-w-[85vw]",
};

/** @param {string} [width="md"] */
export function drawerWidthClass(width = "md") {
  const classes = DRAWER_WIDTHS[width];
  if (!classes) throw new Error(`drawerWidthClass: unknown width "${width}"`);
  return classes;
}

export const DRAWER_SIDES = {
  end: "end-0 border-s border-line",
  start: "start-0 border-e border-line",
};

/** @param {"start"|"end"} [side="end"] */
export function drawerSideClass(side = "end") {
  const classes = DRAWER_SIDES[side];
  if (!classes) throw new Error(`drawerSideClass: unknown side "${side}"`);
  return classes;
}

export const TOOLTIP_VARIANTS = {
  neutral: "bg-text text-bg",
  err: "bg-err-bg text-err",
  warn: "bg-warn-bg text-warn",
  info: "bg-sky-bg text-sky",
};

/** @param {string} [variant="neutral"] */
export function tooltipVariantClass(variant = "neutral") {
  const classes = TOOLTIP_VARIANTS[variant];
  if (!classes) throw new Error(`tooltipVariantClass: unknown variant "${variant}"`);
  return classes;
}

/** Physical left/right map to logical start/end. */
export const TOOLTIP_POSITIONS = {
  top: "bottom-full start-1/2 mb-1.5 -translate-x-1/2 rtl:translate-x-1/2",
  bottom: "top-full start-1/2 mt-1.5 -translate-x-1/2 rtl:translate-x-1/2",
  start: "end-full top-1/2 me-1.5 -translate-y-1/2",
  end: "start-full top-1/2 ms-1.5 -translate-y-1/2",
  left: "end-full top-1/2 me-1.5 -translate-y-1/2",
  right: "start-full top-1/2 ms-1.5 -translate-y-1/2",
};

/** @param {string} [position="top"] */
export function tooltipPositionClass(position = "top") {
  const classes = TOOLTIP_POSITIONS[position];
  if (!classes) throw new Error(`tooltipPositionClass: unknown position "${position}"`);
  return classes;
}

const FLOAT_GAP = 6;
const FLOAT_MARGIN = 8;

/**
 * Viewport coordinates for a floating panel next to `anchor`. Logical sides
 * (`start`/`end`) flip under RTL; legacy `left`/`right` are physical. Result is
 * clamped inside the viewport. Pure: pass `viewport` explicitly (defaults to
 * `window` in the browser, throws on the server when omitted).
 * @param {{top:number,left:number,right:number,bottom:number,width:number,height:number}} anchor
 * @param {{width: number, height: number}} panel
 * @param {string} placement top|bottom|start|end|left|right
 * @param {boolean} rtl
 * @param {{width: number, height: number}} [viewport]
 * @returns {{top: number, left: number}}
 */
export function floatingPosition(anchor, panel, placement, rtl, viewport) {
  const view =
    viewport ??
    (typeof window !== "undefined"
      ? { width: window.innerWidth, height: window.innerHeight }
      : null);
  if (!view) throw new Error("floatingPosition: viewport required outside the browser");
  const physical =
    placement === "start"
      ? rtl
        ? "right"
        : "left"
      : placement === "end"
        ? rtl
          ? "left"
          : "right"
        : placement;
  let top;
  let left;
  if (physical === "top" || physical === "bottom") {
    left = anchor.left + anchor.width / 2 - panel.width / 2;
    top = physical === "top" ? anchor.top - panel.height - FLOAT_GAP : anchor.bottom + FLOAT_GAP;
  } else if (physical === "left" || physical === "right") {
    top = anchor.top + anchor.height / 2 - panel.height / 2;
    left = physical === "left" ? anchor.left - panel.width - FLOAT_GAP : anchor.right + FLOAT_GAP;
  } else {
    throw new Error(`floatingPosition: unknown placement "${placement}"`);
  }
  const maxLeft = view.width - panel.width - FLOAT_MARGIN;
  const maxTop = view.height - panel.height - FLOAT_MARGIN;
  return {
    top: Math.max(FLOAT_MARGIN, Math.min(top, maxTop)),
    left: Math.max(FLOAT_MARGIN, Math.min(left, maxLeft)),
  };
}

const MENU_GAP = 4;

/**
 * Menu panel position. Defaults to below the anchor; flips above when the
 * panel would not fit below and there is more room above, so the panel never
 * covers its trigger. Horizontal aligns the requested inline edge.
 * @param {{top:number,left:number,right:number,bottom:number,width:number,height:number}} anchor
 * @param {{width: number, height: number}} panel
 * @param {"start"|"end"} align
 * @param {boolean} rtl
 * @param {{width: number, height: number}} [viewport]
 * @returns {{top: number, left: number, placement: "top"|"bottom"}}
 */
export function menuPosition(anchor, panel, align, rtl, viewport) {
  const view =
    viewport ??
    (typeof window !== "undefined"
      ? { width: window.innerWidth, height: window.innerHeight }
      : null);
  if (!view) throw new Error("menuPosition: viewport required outside the browser");
  const spaceBelow = view.height - anchor.bottom;
  const spaceAbove = anchor.top;
  const placement =
    spaceBelow < panel.height + MENU_GAP && spaceAbove > spaceBelow ? "top" : "bottom";
  const top = placement === "top" ? anchor.top - panel.height - MENU_GAP : anchor.bottom + MENU_GAP;
  let left;
  if (align === "start") left = rtl ? anchor.right - panel.width : anchor.left;
  else left = rtl ? anchor.left : anchor.right - panel.width;
  const maxLeft = view.width - panel.width - FLOAT_MARGIN;
  return {
    top: Math.max(FLOAT_MARGIN, Math.min(top, view.height - panel.height - FLOAT_MARGIN)),
    left: Math.max(FLOAT_MARGIN, Math.min(left, maxLeft)),
    placement,
  };
}
