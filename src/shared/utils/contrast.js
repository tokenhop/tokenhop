/**
 * WCAG 2.2 contrast helpers for the Signal design system.
 *
 * Pure math (relative luminance + contrast ratio); no DOM needed, so it can
 * run both in Node unit tests and (later) in browser a11y checks.
 */

/**
 * Parse a CSS color (`#rgb`, `#rrggbb`, `rgb()/rgba()`) into [r, g, b]
 * 0-255 channels. Throws on unsupported input (fail fast).
 * @param {string} color
 * @returns {[number, number, number]}
 */
export function parseColor(color) {
  const input = String(color).trim();
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(input);
  if (hex) {
    const h = hex[1];
    const full =
      h.length === 3
        ? h
            .split("")
            .map((c) => c + c)
            .join("")
        : h;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*[\d.]+)?\s*\)$/.exec(
    input,
  );
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  throw new Error(`contrast: unsupported color "${color}"`);
}

/**
 * Relative luminance of an sRGB color per WCAG 2.2.
 * @param {[number, number, number]} rgb
 * @returns {number}
 */
export function relativeLuminance([r, g, b]) {
  const linear = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/**
 * WCAG contrast ratio between two colors (1–21).
 * @param {string} foreground
 * @param {string} background
 * @returns {number}
 */
export function contrastRatio(foreground, background) {
  const l1 = relativeLuminance(parseColor(foreground));
  const l2 = relativeLuminance(parseColor(background));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Composite a foreground `rgba()` tint over an opaque background, returning
 * the resulting opaque `#rrggbb`. Used for `*-bg` tint tokens, which are
 * translucent fills over panel/raised surfaces.
 * @param {string} tint - `rgba(r, g, b, a)` (alpha < 1) or opaque color
 * @param {string} background - opaque base color
 * @returns {string} opaque hex color
 */
export function compositeOver(tint, background) {
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/.exec(
    String(tint).trim(),
  );
  if (!m) return tint;
  const alpha = m[4] === undefined ? 1 : Number(m[4]);
  if (alpha >= 1) return tint;
  const fg = [Number(m[1]), Number(m[2]), Number(m[3])];
  const bg = parseColor(background);
  const out = fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha)));
  return `#${out.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
