import { createElement } from "react";
import { ACTIVE } from "@/shared/brand";
import BrandMark from "./BrandMark";

// createElement for the same reason as BrandMark (importable from vitest).

/**
 * Mark plus wordmark for the active brand. The wordmark is visible text, so the
 * mark is decorative and the link or heading around it gets its name from it.
 *
 * @param {object} props
 * @param {number} [props.size=36] Mark edge length in px; the wordmark scales with it.
 * @param {string} [props.className] Extra classes for the wrapper.
 */
export default function BrandLockup({ size = 36, className = "" }) {
  return createElement(
    "span",
    { className: `flex items-center gap-2.5 ${className}` },
    createElement(BrandMark, { size, decorative: true }),
    createElement(
      "span",
      {
        className: "font-display font-bold tracking-[-0.02em] text-text",
        style: { fontSize: (size * 22) / 36 },
      },
      ACTIVE.wordmark,
    ),
  );
}
