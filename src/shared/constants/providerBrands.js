// Provider brand colors for Signal ProviderTile monograms.
// Derived from open-sse/providers/registry entries so display values stay the
// single source of truth. Any color that fails white text at 4.5:1 is darkened
// here (same hue) until it passes. Brand colors are the one raw-hex exception in
// the Signal component layer (docs/redesign/README.md).

import {
  PROVIDER_ALIASES,
  PROVIDER_DISPLAY,
  PROVIDER_UI_ALIASES,
} from "@/shared/constants/providerDisplay.generated";
import { contrastRatio, parseColor } from "@/shared/utils/contrast";

const TEXT_MIN = 4.5;

/** Dark tile used when a provider has no usable brand color. */
export const PROVIDER_BRAND_FALLBACK = { color: "#15171d", monogram: "?" };

/**
 * Darken a hex brand color (same hue) until white text reaches 4.5:1.
 * Accepts `#rrggbb` and `#rrggbbaa` (alpha dropped). Returns the fallback tile
 * color for anything else, so tiles never render white-on-light.
 * @param {string} hex
 * @returns {string} `#rrggbb`
 */
export function toTileColor(hex) {
  if (typeof hex !== "string" || !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) {
    return PROVIDER_BRAND_FALLBACK.color;
  }
  const input = hex.slice(0, 7).toLowerCase();
  if (contrastRatio("#ffffff", input) >= TEXT_MIN) return input;
  const rgb = parseColor(input);
  for (let step = 1; step <= 20; step += 1) {
    const shade = rgb.map((channel) => Math.round(channel * (1 - step * 0.05)));
    const darkened = `#${shade.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
    if (contrastRatio("#ffffff", darkened) >= TEXT_MIN) return darkened;
  }
  return PROVIDER_BRAND_FALLBACK.color;
}

/**
 * Canonical provider id for a registry id, alias (`cc`) or `alias/model` string.
 * Same precedence as the router (open-sse/services/model.js), resolved against
 * the generated alias snapshot instead of the full registry.
 * @param {string} value
 * @returns {string}
 */
export function resolveProviderId(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  const head = raw.includes("/") ? raw.slice(0, raw.indexOf("/")) : raw;
  const routed = PROVIDER_ALIASES[head] || head;
  if (routed === head && !PROVIDER_IDS.has(head)) return PROVIDER_UI_ALIASES[head] ?? head;
  return routed;
}

// Registry ids + dashboard short aliases (`ag`, `bb`) from the generated map.
// Registry ids still win on collisions (`mmf`).
const PROVIDER_IDS = new Set(Object.keys(PROVIDER_DISPLAY));

const displayColor = (id) => PROVIDER_DISPLAY[id]?.color;

/**
 * Brand keys for providers that are not registry entries (user-created nodes).
 * Compatible nodes reuse their parent vendor's registry color.
 */
const SYNTHETIC_BRANDS = {
  "openai-compatible": { source: displayColor("openai"), monogram: "OC" },
  "anthropic-compatible": { source: displayColor("anthropic"), monogram: "AC" },
  "custom-embedding": { source: "#6366F1", monogram: "CE" },
};

/**
 * @type {Record<string, { color: string, monogram: string }>}
 */
export const PROVIDER_BRANDS = {
  ...Object.fromEntries(
    Object.entries(PROVIDER_DISPLAY)
      .filter(([, entry]) => entry.name)
      .map(([id, entry]) => [
        id,
        {
          color: toTileColor(entry.color),
          monogram: entry.textIcon || id.slice(0, 2).toUpperCase(),
        },
      ]),
  ),
  ...Object.fromEntries(
    Object.entries(SYNTHETIC_BRANDS).map(([id, { source, monogram }]) => [
      id,
      { color: toTileColor(source), monogram },
    ]),
  ),
};

/**
 * Brand tile (color + monogram) for a provider id. Unknown ids get the dark
 * fallback tile with a two-letter monogram.
 * @param {string} id
 * @returns {{ color: string, monogram: string }}
 */
export function getProviderBrand(rawId) {
  const id = resolveProviderId(rawId);
  const family = Object.keys(SYNTHETIC_BRANDS).find((key) => String(id).startsWith(`${key}-`));
  return (
    PROVIDER_BRANDS[id] ??
    PROVIDER_BRANDS[family] ?? {
      color: PROVIDER_BRAND_FALLBACK.color,
      monogram: String(id || "?")
        .slice(0, 2)
        .toUpperCase(),
    }
  );
}
