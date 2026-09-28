"use client";

import { useEffect } from "react";
import { eventShortcutFlags } from "@/shared/utils/commandPalette";

/**
 * Decide whether a keydown should focus page toolbar search.
 * True only for plain "/" outside editable or Monaco contexts.
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
export function shouldFocusSearch(event) {
  const flags = eventShortcutFlags(event, {
    inCodeEditor: Boolean(event?.target?.closest?.(".monaco-editor")),
  });
  return (
    event?.key === "/" &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !flags.defaultPrevented &&
    !flags.isComposing &&
    !flags.inEditable &&
    !flags.inCodeEditor
  );
}

/**
 * Focus and select `ref` on plain "/" keydown via one window listener.
 * @param {import("react").RefObject<HTMLInputElement|null>} ref
 */
export default function useSlashShortcut(ref) {
  useEffect(() => {
    const onKeyDown = (event) => {
      if (!shouldFocusSearch(event)) return;
      const node = ref.current;
      if (!node) return;
      event.preventDefault();
      node.focus();
      node.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ref]);
}
