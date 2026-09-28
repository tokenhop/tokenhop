"use client";

import PropTypes from "prop-types";
import { Button } from "@/shared/components";
import ProviderTile from "@/shared/components/ProviderTile";

const RELAYS = [
  {
    id: "cloudflare",
    logoId: "cloudflare-ai",
    name: "Cloudflare Worker relay",
    description: "Runs on your free Workers account",
    modal: "cloudflare",
  },
  {
    id: "vercel",
    logoId: "vercel",
    name: "Vercel relay",
    description: "A relay function in your project",
    modal: "vercel",
  },
  {
    id: "deno",
    // No Deno logo in public/providers: keep the monogram tile.
    code: "DN",
    tileBg: "#0F766E",
    name: "Deno Deploy relay",
    description: "One small app, free tier",
    modal: "deno",
  },
];

/**
 * Three relay deploy cards (Cloudflare Worker, Vercel, Deno Deploy).
 * Matches board `ProxyPools.dc.html` layout and copies.
 */
export default function RelayCards({ onDeploy }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {RELAYS.map((relay) => (
        <div
          key={relay.id}
          className="flex items-center gap-3 rounded-2xl border border-line bg-panel p-4 text-text shadow-card transition-colors duration-150 hover:border-subtle"
        >
          {relay.logoId ? (
            <ProviderTile providerId={relay.logoId} size="md" />
          ) : (
            <span
              className="flex size-9 shrink-0 items-center justify-center rounded-[10px] font-display text-sm font-bold text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)]"
              style={{ backgroundColor: relay.tileBg }}
              aria-hidden="true"
            >
              {relay.code}
            </span>
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <b className="truncate text-[15px] font-semibold text-text">{relay.name}</b>
            <span className="truncate text-xs text-muted">{relay.description}</span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onDeploy?.(relay.modal)}
            aria-label={`Deploy ${relay.name}`}
          >
            Deploy
          </Button>
        </div>
      ))}
    </div>
  );
}

RelayCards.propTypes = {
  onDeploy: PropTypes.func.isRequired,
};
