"use client";

import PropTypes from "prop-types";
import { useState } from "react";
import { getProviderBrand } from "@/shared/constants/providerBrands";
import { getProviderIconSrc, markProviderIconMissing } from "@/shared/utils/providerIcon";

function resolveSrc(src, providerId) {
  if (providerId) return getProviderIconSrc(providerId);
  if (!src) return null;
  const m = String(src).match(/^\/providers\/([^/]+)\.(?:png|webp|svg)$/i);
  if (m) return getProviderIconSrc(m[1]);
  return src;
}

/**
 * Provider logo from `/public/providers/{id}.webp|svg` with a Signal monogram tile
 * (brand color, white text) as the fallback when the logo is missing.
 */
export default function ProviderIcon({
  src,
  providerId,
  alt,
  size = 32,
  className = "",
  fallbackText,
  fallbackColor,
}) {
  const effectiveSrc = resolveSrc(src, providerId);
  const [errored, setErrored] = useState(false);
  const idFromSrc = effectiveSrc?.match(/^\/providers\/([^/]+)\.(?:png|webp|svg)$/i)?.[1];
  const brand = getProviderBrand(providerId ?? idFromSrc);
  const background = fallbackColor ?? brand.color;

  if (!effectiveSrc || errored) {
    return (
      <span
        role="img"
        aria-label={alt ?? providerId ?? "provider"}
        className={`inline-flex shrink-0 items-center justify-center rounded-lg font-display font-bold text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] ${className}`.trim()}
        style={{
          width: size,
          height: size,
          backgroundColor: background,
          fontSize: Math.max(10, Math.floor(size * 0.38)),
        }}
      >
        {fallbackText ?? brand.monogram}
      </span>
    );
  }

  return (
    <img
      src={effectiveSrc}
      alt={alt}
      width={size}
      height={size}
      className={className}
      loading="lazy"
      decoding="async"
      onError={() => {
        if (idFromSrc) markProviderIconMissing(idFromSrc);
        if (providerId) markProviderIconMissing(providerId);
        setErrored(true);
      }}
    />
  );
}

ProviderIcon.propTypes = {
  src: PropTypes.string,
  providerId: PropTypes.string,
  alt: PropTypes.string,
  size: PropTypes.number,
  className: PropTypes.string,
  fallbackText: PropTypes.string,
  fallbackColor: PropTypes.string,
};
