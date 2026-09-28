"use client";

import { useState } from "react";
import Button from "@/shared/components/Button";
import Checkbox from "@/shared/components/Checkbox";
import CopyField from "@/shared/components/CopyField";
import IconButton from "@/shared/components/IconButton";
import Input from "@/shared/components/Input";
import Kbd from "@/shared/components/Kbd";
import NumberStepper from "@/shared/components/NumberStepper";
import SegmentedControl from "@/shared/components/SegmentedControl";
import Select from "@/shared/components/Select";
import Tabs from "@/shared/components/Tabs";
import Textarea from "@/shared/components/Textarea";
import Toggle from "@/shared/components/Toggle";
import UnitInput from "@/shared/components/UnitInput";
import ThemeToggle from "@/shared/components/ThemeToggle";
import KitPills from "./_sections/KitPills";
import KitSwatches from "./_sections/KitSwatches";
import KitType from "./_sections/KitType";
import KitTiles from "./_sections/KitTiles";
import KitMeters from "./_sections/KitMeters";
import KitCards from "./_sections/KitCards";
import KitFeedback from "./_sections/KitFeedback";
import KitOverlays from "./_sections/KitOverlays";

/**
 * Dev-only Signal kit page (YAN-277). Renders YAN-276 + YAN-277 primitives in
 * all variants. The page wrapper calls notFound() in production.
 */
export default function KitClient() {
  const [period, setPeriod] = useState("today");
  const [tab, setTab] = useState("forms");
  const [enabled, setEnabled] = useState(true);
  const [limit, setLimit] = useState(3);
  const [ttl, setTtl] = useState("60");
  const [checked, setChecked] = useState(true);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
            9router UI kit
          </p>
          <h1 className="font-display text-[68px] leading-none font-extrabold">Signal</h1>
          <p dir="auto" className="mt-1 max-w-[72ch] text-[15px] text-muted">
            Warm ink surfaces. Coral is the brand and your selection. Lime means traffic is live, or
            it is the one thing to press.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <IconButton icon="search" label="Search" />
          <ThemeToggle />
        </div>
      </header>

      <section
        aria-labelledby="kit-actions"
        className="rounded-2xl border border-line bg-panel p-6 shadow-card"
      >
        <h2 id="kit-actions" className="font-display text-xl font-bold">
          Buttons
        </h2>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button>Copy endpoint</Button>
          <Button variant="secondary">Test all</Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="danger">Delete</Button>
          <Button variant="secondary" size="sm" loading>
            Testing
          </Button>
          <Kbd>⌘K</Kbd>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <Toggle checked={enabled} onChange={setEnabled} aria-label="Sample toggle on" />
          <Toggle checked={false} aria-label="Sample toggle off" />
          <SegmentedControl
            aria-label="Period"
            options={[
              { value: "today", label: "Today" },
              { value: "7d", label: "7d" },
              { value: "30d", label: "30d" },
            ]}
            value={period}
            onChange={setPeriod}
          />
          <Tabs
            tabs={[
              { value: "forms", label: "Forms" },
              { value: "display", label: "Display" },
            ]}
            value={tab}
            onChange={setTab}
            aria-label="Kit tabs"
          />
        </div>
      </section>

      <section
        aria-labelledby="kit-forms"
        className="rounded-2xl border border-line bg-panel p-6 shadow-card"
      >
        <h2 id="kit-forms" className="font-display text-xl font-bold">
          Forms
        </h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Input
            label="Provider name"
            hint={<span dir="auto">Shown in lists and logs.</span>}
            placeholder="claude-work"
          />
          <Input
            label="API key"
            error={<span dir="auto">Key is required.</span>}
            placeholder="sk-..."
          />
          <Textarea label="Notes" placeholder="Anything the team should know." />
          <Select
            label="Auto-refresh"
            value={ttl}
            onChange={(event) => setTtl(event.target.value)}
            options={[
              { value: "60", label: "Every 60s" },
              { value: "0", label: "Off" },
            ]}
          />
          <NumberStepper label="Sticky limit" value={limit} min={1} max={10} onChange={setLimit} />
          <UnitInput
            label="Cache TTL"
            value={ttl}
            unit="s"
            onChange={(event) => setTtl(event.target.value)}
          />
          <Input label="Disabled" value="read only" disabled readOnly />
          <Checkbox checked={checked} onChange={setChecked} label="Enable provider" />
        </div>
        <div className="mt-4">
          <CopyField value="http://localhost:20128/v1" label="Endpoint URL" />
        </div>
      </section>

      <KitSwatches />
      <KitType />
      <KitPills />
      <KitTiles />
      <KitMeters />
      <KitCards />
      <KitFeedback />
      <KitOverlays />
    </div>
  );
}
