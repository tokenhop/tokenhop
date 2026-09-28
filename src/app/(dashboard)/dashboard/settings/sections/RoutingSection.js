"use client";

import PropTypes from "prop-types";
import Link from "next/link";
import SectionCard from "@/shared/components/SectionCard";
import SettingRow from "@/shared/components/SettingRow";
import SegmentedControl from "@/shared/components/SegmentedControl";
import NumberStepper from "@/shared/components/NumberStepper";
import Toggle from "@/shared/components/Toggle";
import Callout from "@/shared/components/Callout";
import StatusPill from "@/shared/components/StatusPill";
import { useSettingsField } from "../useSettingsField";
import ProviderOverrideList from "./ProviderOverrideList";
import { summarizeRouting } from "./routingSettings";

const ACCOUNT_OPTIONS = [
  { value: "fill-first", label: "Fill first" },
  { value: "round-robin", label: "Round robin" },
  { value: "weighted", label: "Weighted" },
];

const KNOWN_COMBO_STRATEGIES = new Set(["fallback", "round-robin", "fusion", "weighted"]);

/**
 * Routing section: account strategy + sticky limit, combo round-robin toggle +
 * sticky limit, plain-language summary, per-provider overrides list, and
 * read-only capability-adapter pills linking to Combos.
 */
export default function RoutingSection({ settings, onSettingsChange }) {
  const onSaved = (key) => (value) => onSettingsChange?.({ [key]: value });
  const fallbackField = useSettingsField(
    "fallbackStrategy",
    settings.fallbackStrategy ?? "fill-first",
    {
      onSaved: onSaved("fallbackStrategy"),
    },
  );
  const stickyField = useSettingsField(
    "stickyRoundRobinLimit",
    settings.stickyRoundRobinLimit ?? 3,
    {
      onSaved: onSaved("stickyRoundRobinLimit"),
    },
  );
  const comboField = useSettingsField("comboStrategy", settings.comboStrategy ?? "fallback", {
    onSaved: onSaved("comboStrategy"),
  });
  const comboStickyField = useSettingsField(
    "comboStickyRoundRobinLimit",
    settings.comboStickyRoundRobinLimit ?? 1,
    { onSaved: onSaved("comboStickyRoundRobinLimit") },
  );

  const overrides =
    settings.providerStrategies && typeof settings.providerStrategies === "object"
      ? settings.providerStrategies
      : {};

  const comboKnown = KNOWN_COMBO_STRATEGIES.has(comboField.value);
  const comboIsRR = comboField.value === "round-robin";
  // The global toggle only switches the two backend-supported globals
  // (fallback/round-robin); fusion/weighted are per-combo only and must not be
  // silently overwritten by flipping the switch.
  const stickyEnabled = fallbackField.value === "round-robin" || fallbackField.value === "weighted";
  const showWeightedWarning = fallbackField.value === "weighted" && Number(stickyField.value) === 1;

  const adapter =
    settings.capacityAdapter && typeof settings.capacityAdapter === "object"
      ? settings.capacityAdapter
      : {};
  const adapterPills = ["vision", "pdf", "audioInput", "videoInput"].map((cap) => {
    const entry = adapter[cap];
    const enabled = entry && typeof entry === "object" ? entry.enabled !== false : Boolean(entry);
    // Labels match the Combos page capability names.
    const label =
      cap === "vision"
        ? "Vision"
        : cap === "audioInput"
          ? "Audio"
          : cap === "pdf"
            ? "PDF"
            : "Video";
    return { cap, label, enabled };
  });

  const summary = summarizeRouting({
    fallbackStrategy: fallbackField.value,
    stickyRoundRobinLimit: stickyField.value,
    comboStrategy: comboField.value,
    comboStickyRoundRobinLimit: comboStickyField.value,
    providerStrategies: overrides,
  });

  return (
    <div id="routing" className="scroll-mt-24 space-y-4">
      <SectionCard icon="route" title="Routing" subtitle="How accounts and combos take turns." />
      <div className="rounded-2xl border border-line bg-panel p-5 shadow-card divide-y divide-line">
        <div className="py-4 first:pt-0">
          <SettingRow
            label="Account strategy"
            description="Picks between accounts of the same provider."
            settingKey="fallbackStrategy"
            control={
              <SegmentedControl
                options={ACCOUNT_OPTIONS}
                value={fallbackField.value}
                onChange={(next) => fallbackField.set(next)}
                aria-label="Account strategy"
              />
            }
          />
          {fallbackField.error && (
            <p className="py-1 text-xs text-err" role="alert">
              {fallbackField.error}
            </p>
          )}
        </div>

        <div className="py-4">
          <SettingRow
            label="Sticky limit"
            description="Calls per account before rotating. Round robin and weighted only."
            settingKey="stickyRoundRobinLimit"
            control={
              <NumberStepper
                value={stickyField.value ?? 3}
                onChange={(next) => stickyField.set(next)}
                min={1}
                max={100}
                disabled={!stickyEnabled || stickyField.saving}
                error={stickyField.error}
                aria-label="Sticky limit"
              />
            }
          />
          {showWeightedWarning && (
            <Callout variant="warn" title="Sticky 1 with weighted routing">
              Every request may land on a different subscription account, which can trip anti-abuse
              flags. Prefer 3 or higher.
            </Callout>
          )}
        </div>

        <div className="py-4">
          <SettingRow
            label="Combo round robin"
            description={
              comboKnown
                ? "Rotate inside combos by default instead of falling back in order."
                : `This combo strategy is managed per combo: “${comboField.value}” is not one of the global options, so the toggle is shown off without changing it.`
            }
            settingKey="comboStrategy"
            control={
              <Toggle
                checked={comboIsRR}
                onChange={(next) => comboField.set(next ? "round-robin" : "fallback")}
                aria-label="Combo round robin"
              />
            }
          />
          {comboField.error && (
            <p className="py-1 text-xs text-err" role="alert">
              {comboField.error}
            </p>
          )}
        </div>

        <div className="py-4">
          <SettingRow
            label="Combo sticky limit"
            description="Calls per combo model before rotating."
            settingKey="comboStickyRoundRobinLimit"
            control={
              <NumberStepper
                value={comboStickyField.value ?? 1}
                onChange={(next) => comboStickyField.set(next)}
                min={1}
                max={100}
                disabled={!comboIsRR || comboStickyField.saving}
                error={comboStickyField.error}
                aria-label="Combo sticky limit"
              />
            }
          />
        </div>

        <div className="py-4">
          <Callout variant="info">{summary}</Callout>
        </div>

        <div className="py-4">
          <ProviderOverrideList
            overrides={overrides}
            onOverridesChange={(next) => onSettingsChange?.({ providerStrategies: next })}
          />
        </div>

        <div className="py-4 last:pb-0">
          <SettingRow
            label="Capability adapter"
            description={
              <span>
                Images or audio go to a capable model when the chosen one can’t read them.{" "}
                <Link href="/dashboard/combos" className="underline">
                  Edit in Combos
                </Link>
              </span>
            }
            settingKey="capacityAdapter"
            control={
              <div className="flex flex-wrap gap-2">
                {adapterPills.map(({ cap, label, enabled }) => (
                  <StatusPill key={cap} variant={enabled ? "ok" : "neutral"} size="sm" dot>
                    {label} {enabled ? "on" : "off"}
                  </StatusPill>
                ))}
              </div>
            }
          />
        </div>
      </div>
    </div>
  );
}

RoutingSection.propTypes = {
  settings: PropTypes.object.isRequired,
  onSettingsChange: PropTypes.func,
};
