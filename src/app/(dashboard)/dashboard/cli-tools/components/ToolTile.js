"use client";

import PropTypes from "prop-types";
import ProviderTile from "@/shared/components/ProviderTile";
import { getToolBrand } from "../lib/toolStatus";

/** Tool tile: shipped logo via ProviderTile, brand monogram fallback. */
export default function ToolTile({ tool, size = "md" }) {
  const brand = getToolBrand(tool);
  const iconSrc = tool?.image || undefined;
  if (!iconSrc) {
    return (
      <span
        aria-hidden="true"
        style={{ backgroundColor: brand.color }}
        className={
          size === "lg"
            ? "flex size-14 shrink-0 items-center justify-center rounded-2xl font-display text-[22px] font-bold text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)]"
            : "flex size-9 shrink-0 items-center justify-center rounded-[10px] font-display text-sm font-bold text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)]"
        }
      >
        {brand.monogram}
      </span>
    );
  }
  return (
    <ProviderTile
      providerId={tool.name}
      size={size}
      brand={brand}
      iconSrc={iconSrc}
      className={size === "lg" ? "!size-14 !rounded-2xl" : ""}
    />
  );
}

ToolTile.propTypes = {
  tool: PropTypes.shape({
    name: PropTypes.string.isRequired,
    color: PropTypes.string,
    image: PropTypes.string,
  }).isRequired,
  size: PropTypes.oneOf(["sm", "md", "lg"]),
};
