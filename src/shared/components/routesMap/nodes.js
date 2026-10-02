"use client";

import PropTypes from "prop-types";
import { useState } from "react";
import { getProviderIconSrc, markProviderIconMissing } from "@/shared/utils/providerIcon";
import { getProviderBrand, resolveProviderId } from "@/shared/constants/providerBrands";
import { EDGE_STATE_LABEL } from "@/shared/utils/routesMap";
import { formatCompact } from "@/shared/utils/format";
import BrandMark from "@/shared/components/BrandMark";
import { HUB_H, NODE_H, NODE_W } from "./layout";

/** Client node: API key name or user-agent family with a request count. */
export function ClientNode({ x, y, client }) {
  return (
    <g className="routes-map-node">
      <rect
        x={x}
        y={y}
        width={NODE_W.client}
        height={NODE_H}
        rx={10}
        fill="none"
        stroke="var(--signal-line)"
      />
      <text x={x + 12} y={y + 21} fill="var(--signal-text)" fontSize="12" fontWeight="500">
        {client.id.length > 18 ? `${client.id.slice(0, 17)}…` : client.id}
      </text>
      <text
        x={x + NODE_W.client - 10}
        y={y + 21}
        textAnchor="end"
        fill="var(--signal-muted)"
        fontSize="11"
        fontFamily="var(--signal-font-mono)"
      >
        {formatCompact(client.count)}
      </text>
    </g>
  );
}

ClientNode.propTypes = {
  x: PropTypes.number.isRequired,
  y: PropTypes.number.isRequired,
  client: PropTypes.shape({
    id: PropTypes.string.isRequired,
    count: PropTypes.number.isRequired,
  }).isRequired,
};

/** Provider node: status dot, brand tile and name. Idle nodes render muted. */
export function ProviderNode({ x, y, provider }) {
  const id = resolveProviderId(provider.id);
  const brand = getProviderBrand(id);
  const [logoMissing, setLogoMissing] = useState(false);
  const logo = logoMissing ? null : getProviderIconSrc(id);
  const plateY = y + (NODE_H - 22) / 2;
  const idle = provider.state === "idle";
  return (
    <g className="routes-map-node">
      <rect
        x={x}
        y={y}
        width={NODE_W.provider}
        height={NODE_H}
        rx={10}
        fill="none"
        stroke={
          provider.state === "cooling"
            ? "var(--signal-warn)"
            : provider.state === "error"
              ? "var(--signal-err)"
              : "var(--signal-line)"
        }
      />
      <circle
        cx={x + 16}
        cy={y + NODE_H / 2}
        r={5}
        fill={
          provider.state === "flowing"
            ? "var(--signal-lime)"
            : provider.state === "cooling"
              ? "var(--signal-warn)"
              : provider.state === "error"
                ? "var(--signal-err)"
                : "var(--signal-line)"
        }
      />
      {/* Brand plate behind the logo keeps dark glyph logos visible on dark
          panels (providerBrands' documented brand-color exception). */}
      <rect
        x={x + 28}
        y={plateY}
        width={22}
        height={22}
        rx={6}
        fill={logo ? `color-mix(in srgb, ${brand.color} 8%, #ffffff)` : brand.color}
      />
      {logo ? (
        <image
          href={logo}
          x={x + 28}
          y={plateY}
          width={22}
          height={22}
          style={{ clipPath: "inset(0 round 6px)" }}
          preserveAspectRatio="xMidYMid meet"
          onError={() => {
            markProviderIconMissing(id);
            setLogoMissing(true);
          }}
        />
      ) : (
        /* White monogram on the brand tile is the one raw-color exception
           (providerBrands keeps it at ≥4.5:1). */
        <text
          x={x + 39}
          y={y + NODE_H / 2 + 3.5}
          textAnchor="middle"
          fontSize="9"
          fontWeight="700"
          fill="#ffffff"
        >
          {brand.monogram}
        </text>
      )}
      <text
        x={x + 58}
        y={y + 21}
        fill={idle ? "var(--signal-muted)" : "var(--signal-text)"}
        fontSize="12"
        fontWeight="500"
      >
        {provider.name.length > 16 ? `${provider.name.slice(0, 15)}…` : provider.name}
      </text>
      {provider.state === "error" || provider.state === "cooling" ? (
        <text
          x={x + NODE_W.provider - 10}
          y={y + 21}
          textAnchor="end"
          fontSize="11"
          fontWeight="600"
          fontFamily="var(--signal-font-mono)"
          fill={provider.state === "error" ? "var(--signal-err)" : "var(--signal-warn)"}
        >
          {provider.code || (provider.state === "error" ? "ERR" : "429")}
        </text>
      ) : provider.state === "flowing" ? (
        <circle cx={x + NODE_W.provider - 14} cy={y + NODE_H / 2} r={4} fill="var(--signal-ok)" />
      ) : null}
      <title>{`${provider.name}: ${EDGE_STATE_LABEL[provider.state] || provider.state}`}</title>
    </g>
  );
}

ProviderNode.propTypes = {
  x: PropTypes.number.isRequired,
  y: PropTypes.number.isRequired,
  provider: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    state: PropTypes.string.isRequired,
    code: PropTypes.string,
  }).isRequired,
};

/** Center hub tile: the active brand's mark. */
export function HubNode({ x, y }) {
  return <BrandMark x={x} y={y - HUB_H / 2} size={NODE_W.hub} decorative />;
}

HubNode.propTypes = {
  x: PropTypes.number.isRequired,
  y: PropTypes.number.isRequired,
};
