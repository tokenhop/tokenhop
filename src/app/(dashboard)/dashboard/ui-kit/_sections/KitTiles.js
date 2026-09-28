"use client";

import ProviderTile from "@/shared/components/ProviderTile";
import StatTile from "@/shared/components/StatTile";

/** Kit section: provider tiles and stat tiles. */
export default function KitTiles() {
  return (
    <section
      aria-labelledby="kit-tiles"
      className="rounded-2xl border border-line bg-panel p-6 shadow-card"
    >
      <h2 id="kit-tiles" className="font-display text-xl font-bold">
        Tiles
      </h2>
      <div className="mt-4 flex items-center gap-2.5">
        <ProviderTile providerId="claude" size="md" status="live" />
        <ProviderTile providerId="codex" size="md" status="warn" />
        <ProviderTile providerId="openrouter" size="md" status="ok" />
      </div>
      <div className="mt-4 flex items-end gap-3">
        <ProviderTile providerId="claude" size="sm" />
        <ProviderTile providerId="codex" size="md" />
        <ProviderTile providerId="cursor" size="lg" />
      </div>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatTile
          eyebrow="Requests"
          value="2,481"
          delta="+12% vs yesterday"
          sparkline={[3, 5, 4, 7, 6, 9, 8]}
        />
        <StatTile
          eyebrow="Tokens in / out"
          value="4.2M / 612K"
          delta="38% cached"
          sparkline={[8, 6, 9, 5, 7, 6, 8]}
        />
        <StatTile
          hero
          eyebrow="Saved by token saver"
          value="1.31M"
          delta="31% lighter"
          sparkline={[2, 4, 3, 5, 6, 7, 9]}
        />
      </div>
    </section>
  );
}
