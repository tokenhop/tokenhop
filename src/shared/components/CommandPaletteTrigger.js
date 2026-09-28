"use client";

import { useCommandPalette } from "./CommandPaletteProvider";
import Kbd from "./Kbd";

/**
 * Header trigger button for the Signal command palette (Main.dc.html board).
 * Renders as a 44px-high raised pill with search icon, placeholder and Kbd hint.
 */
export default function CommandPaletteTrigger() {
  const palette = useCommandPalette();
  if (!palette) return null;

  return (
    <button
      type="button"
      onClick={palette.openPalette}
      aria-label="Open command palette"
      aria-haspopup="dialog"
      className="flex h-11 items-center gap-2.5 rounded-xl border border-line bg-raised px-3 text-start text-sm text-muted transition-colors hover:border-line/80 hover:text-text focus-visible:outline-none focus-visible:shadow-focus max-sm:size-11 max-sm:justify-center max-sm:px-0 sm:min-w-[140px] sm:max-w-[320px] sm:flex-1"
    >
      <span
        className="material-symbols-outlined shrink-0 text-[18px] text-muted"
        aria-hidden="true"
      >
        search
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-subtle sm:text-sm max-sm:hidden">
        Jump to provider, model, combo…
      </span>
      <span className="hidden shrink-0 items-center gap-1 sm:flex" aria-hidden="true">
        <Kbd>⌘K</Kbd>
      </span>
    </button>
  );
}
