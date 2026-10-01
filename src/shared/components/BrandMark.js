import { createElement } from "react";
import { ACTIVE, ACTIVE_BRAND_ID, LEGACY } from "@/shared/brand";

// Written with createElement instead of JSX so the vitest node environment can
// import and render this file directly (vitest has no JSX loader for .js).
//
// Legacy tile markup matches the sidebar exactly at size 36: 36px tile, 22px
// glyph, 11px radius, -8° tilt. The tokenhop mark inlines the paths from the
// brand resources (github.com/tokenhop/resources svg/mark.svg): coral tile via
// the Signal token, glyph follows the surrounding text color.
const MARK_VIEWBOX = 64;
const LEGACY_TILE = 36;
const LEGACY_GLYPH = 22;
const LEGACY_RADIUS = 11;

/**
 * The active brand's mark, with an accessible name.
 *
 * @param {object} props
 * @param {number} [props.size=36] Square edge length in px.
 * @param {boolean} [props.decorative=false] Hide from assistive tech when a
 *   visible brand name sits next to the mark (e.g. inside BrandLockup).
 * @param {string} [props.className] Extra classes for the tile element.
 */
export default function BrandMark({ size = LEGACY_TILE, decorative = false, className = "" }) {
  const aria = decorative ? { "aria-hidden": "true" } : { role: "img", "aria-label": ACTIVE.name };

  if (ACTIVE_BRAND_ID === LEGACY.slug) {
    return createElement(
      "span",
      {
        ...aria,
        className: `-rotate-[8deg] flex items-center justify-center bg-coral font-display font-extrabold text-on-coral shadow-card ${className}`,
        style: {
          width: size,
          height: size,
          fontSize: (size * LEGACY_GLYPH) / LEGACY_TILE,
          borderRadius: (size * LEGACY_RADIUS) / LEGACY_TILE,
        },
      },
      "9",
    );
  }

  return createElement(
    "svg",
    {
      ...aria,
      viewBox: `0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}`,
      width: size,
      height: size,
      className,
      focusable: "false",
    },
    createElement("rect", {
      width: MARK_VIEWBOX,
      height: MARK_VIEWBOX,
      rx: 16,
      fill: "var(--signal-coral)",
    }),
    createElement("path", {
      d: "M25 11V41.5C25 48.5 28.8 52 35.5 52H40",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 7.5,
      strokeLinecap: "round",
    }),
    createElement("path", {
      d: "M14 26.5C22 18.5 34 18 42 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 6.5,
      strokeLinecap: "round",
    }),
    // Dot as a path arc (cx 49.5, cy 29, r 6.5): an SVG circle element name collides
    // with a Material Symbols ligature in the icon-subset scanner.
    createElement("path", {
      d: "M43 29a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0-13 0z",
      fill: "currentColor",
    }),
  );
}
