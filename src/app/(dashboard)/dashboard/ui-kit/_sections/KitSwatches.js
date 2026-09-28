"use client";

/** Kit section: the 12 Signal token swatches (bg via tokens, works in both themes). */
const SWATCHES = [
  { bg: "bg-bg", token: "--signal-bg", label: "Ground" },
  { bg: "bg-panel", token: "--signal-panel", label: "Panel" },
  { bg: "bg-raised", token: "--signal-raised", label: "Raised" },
  { bg: "bg-line", token: "--signal-line", label: "Line" },
  { bg: "bg-text", token: "--signal-text", label: "Text" },
  { bg: "bg-muted", token: "--signal-muted", label: "Muted" },
  { bg: "bg-coral", token: "--signal-coral", label: "Coral · brand" },
  { bg: "bg-lime", token: "--signal-lime", label: "Lime · live" },
  { bg: "bg-sky", token: "--signal-sky", label: "Sky · info" },
  { bg: "bg-ok", token: "--signal-ok", label: "OK" },
  { bg: "bg-warn", token: "--signal-warn", label: "Warn" },
  { bg: "bg-err", token: "--signal-err", label: "Error" },
];

export default function KitSwatches() {
  return (
    <section
      aria-labelledby="kit-swatches"
      className="rounded-2xl border border-line bg-panel p-6 shadow-card"
    >
      <h2 id="kit-swatches" className="font-display text-xl font-bold">
        Tokens
      </h2>
      <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {SWATCHES.map((swatch) => (
          <div key={swatch.label} className="flex flex-col gap-1">
            <span
              className={`${swatch.bg} h-[52px] rounded-lg shadow-[inset_0_0_0_1px_var(--signal-line)]`}
            />
            <span className="text-xs font-semibold">{swatch.label}</span>
            <span className="font-mono text-[11px] text-muted">{swatch.token}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
