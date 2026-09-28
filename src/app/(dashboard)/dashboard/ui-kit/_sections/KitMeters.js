"use client";

import Meter, { SegmentedHealthBar } from "@/shared/components/Meter";

/** Kit section: meters and the segmented health bar. */
export default function KitMeters() {
  return (
    <section
      aria-labelledby="kit-meters"
      className="rounded-2xl border border-line bg-panel p-6 shadow-card"
    >
      <h2 id="kit-meters" className="font-display text-xl font-bold">
        Meters
      </h2>
      <div className="mt-4 flex flex-col gap-4">
        <Meter value={76} label="Healthy account" valueText="76 percent remaining" />
        <Meter value={41} label="Cooling account" valueText="41 percent remaining" />
        <Meter value={18} label="Low account" valueText="18 percent remaining" />
        <Meter value={100} kind="unlimited" label="Unlimited plan" valueText="Unlimited" />
        <Meter value={64} kind="credits" label="Credit balance" valueText="64 percent remaining" />
        <SegmentedHealthBar
          segments={[
            { value: 82, label: "Work account" },
            { value: 41, label: "Personal account" },
            { value: 100, kind: "unlimited", label: "Backup account" },
          ]}
        />
      </div>
    </section>
  );
}
