"use client";

import PropTypes from "prop-types";
import { useState } from "react";
import { getProviderBrand, resolveProviderId } from "@/shared/constants/providerBrands";
import { getProviderIconSrc, markProviderIconMissing } from "@/shared/utils/providerIcon";

const SIZES = {
  sm: { tile: "size-6 rounded-md", text: "text-[10px]" },
  md: { tile: "size-9 rounded-[10px]", text: "text-sm" },
  lg: { tile: "size-14 rounded-[14px]", text: "text-lg" },
};

const STATUS_RING = {
  ok: "bg-ok",
  warn: "bg-warn",
  err: "bg-err",
  info: "bg-sky",
  live: "bg-lime",
  neutral: "bg-line",
};

/**
 * Signal provider tile. Shows the provider logo (`/public/providers/{id}.png|svg`)
 * edge to edge on a near-white plate washed with the brand color, so every logo —
 * dark glyphs, transparent marks, full-bleed app icons — reads in both themes.
 * Falls back to the white-on-brand monogram when no logo exists.
 *
 * @param {object} props
 * @param {string} props.providerId Provider id, alias, `alias/model` string, or brand key.
 * @param {"sm"|"md"|"lg"} [props.size="md"] sm 24, md 36, lg 56.
 * @param {"ok"|"warn"|"err"|"info"|"live"|"neutral"} [props.status] Optional status dot with panel ring.
 * @param {string} [props.className]
 */
export default function ProviderTile({ providerId, size = "md", status, className }) {
  const [missingFor, setMissingFor] = useState(null);
  const dims = SIZES[size];
  if (!dims) throw new Error(`ProviderTile: unknown size "${size}"`);
  if (status !== undefined && !STATUS_RING[status]) {
    throw new Error(`ProviderTile: unknown status "${status}"`);
  }
  const id = resolveProviderId(providerId);
  const brand = getProviderBrand(id);
  const src = missingFor === id ? null : getProviderIconSrc(id);

  const plate = src
    ? {
        // Logo fills the tile edge to edge. Near-white brand-washed plate shows
        // only behind transparent glyph logos so dark marks stay visible.
        style: { backgroundColor: `color-mix(in srgb, ${brand.color} 8%, #ffffff)` },
        className: "",
      }
    : {
        style: { backgroundColor: brand.color },
        className: `font-display font-bold text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] ${dims.text}`,
      };

  return (
    <span
      aria-hidden="true"
      title={providerId}
      style={plate.style}
      className={`relative inline-flex shrink-0 items-center justify-center ${dims.tile} ${plate.className}${className ? ` ${className}` : ""}`}
    >
      {src ? (
        // biome-ignore lint/performance/noImgElement: tiny static logo with onError fallback; next/image adds nothing.
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full rounded-[inherit] object-contain"
          onError={() => {
            markProviderIconMissing(id);
            setMissingFor(id);
          }}
        />
      ) : (
        brand.monogram
      )}
      {status && (
        <span
          className={`absolute -end-0.5 -bottom-0.5 size-2.5 rounded-full shadow-[0_0_0_2px_var(--signal-panel)] ${STATUS_RING[status]}`}
        />
      )}
    </span>
  );
}

ProviderTile.propTypes = {
  providerId: PropTypes.string.isRequired,
  size: PropTypes.oneOf(Object.keys(SIZES)),
  status: PropTypes.oneOf(Object.keys(STATUS_RING)),
  className: PropTypes.string,
};
