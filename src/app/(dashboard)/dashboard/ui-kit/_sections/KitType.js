"use client";

/** Kit section: type specimen mirroring Kit.dc.html. */
export default function KitType() {
  return (
    <section
      aria-labelledby="kit-type"
      className="flex flex-col gap-3 rounded-2xl border border-line bg-panel p-6 shadow-card"
    >
      <h2 id="kit-type" className="font-display text-xl font-bold">
        Type
      </h2>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-display text-[40px] leading-[1.05] font-bold">Command center</span>
        <span className="font-mono text-[11px] text-muted">Bricolage Grotesque 700</span>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span dir="auto" className="flex-1 text-[15px] leading-[1.5]">
          One endpoint, 40+ providers, automatic fallback.
        </span>
        <span className="font-mono text-[11px] text-muted">Geist 400/600</span>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="min-w-0 flex-1 break-all font-mono text-sm">
          cc/claude-sonnet-4-6 → cx/gpt-5.1-codex
        </span>
        <span className="font-mono text-[11px] text-muted">Geist Mono 500</span>
      </div>
    </section>
  );
}
