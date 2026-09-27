"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Toggle from "@/shared/components/Toggle";
import Button from "@/shared/components/Button";
import ModelSelectModal from "@/shared/components/ModelSelectModal";
import CapacityBadges from "@/shared/components/CapacityBadges";

const CAPACITY_ADAPTER_CAPS = [
  {
    key: "vision",
    label: "Vision adapter",
    short: "Vision",
    icon: "visibility",
    desc: "Text-only models get eyes: images are described by a vision model before the request goes out.",
  },
  {
    key: "audioInput",
    label: "Audio adapter",
    short: "Audio",
    icon: "graphic_eq",
    desc: "Text-only models get ears: audio clips are transcribed by an audio model before the request goes out.",
  },
];

/**
 * Capability adapter card on the Combos page.
 * Manages Vision and Audio adapter pools, their enable toggles, round-robin
 * mode, and ordered fallback pools.
 *
 * @param {object} props
 * @param {Record<string, { enabled?: boolean, roundRobin?: boolean, models?: string[] }>} props.capacityAdapter
 * @param {(next: object) => void} props.onChange
 * @param {Array<{ provider: string }>} [props.activeProviders]
 * @param {(model: string) => object} [props.getCaps]
 */
export default function CapabilityAdapterCard({
  capacityAdapter = {},
  onChange,
  activeProviders = [],
  getCaps,
}) {
  const [activeCapForModal, setActiveCapForModal] = useState(null);

  const updateCap = (key, patch) => {
    const current = capacityAdapter[key] || { enabled: true, roundRobin: false, models: [] };
    const next = { ...current, ...patch };
    onChange?.({ ...capacityAdapter, [key]: next });
  };

  const handleAdd = (capKey, model) => {
    if (!model?.value) return;
    const entry = capacityAdapter[capKey] || { enabled: true, roundRobin: false, models: [] };
    const list = Array.isArray(entry.models) ? entry.models : [];
    if (list.includes(model.value)) return;
    updateCap(capKey, { models: [...list, model.value] });
  };

  const handleRemove = (capKey, index) => {
    const entry = capacityAdapter[capKey] || { enabled: true, roundRobin: false, models: [] };
    const list = Array.isArray(entry.models) ? entry.models : [];
    // An emptied pool stays empty: the "No models in pool" state says so.
    updateCap(capKey, { models: list.filter((_, i) => i !== index) });
  };

  const handleMove = (capKey, index, delta) => {
    const entry = capacityAdapter[capKey] || { enabled: true, roundRobin: false, models: [] };
    const list = Array.isArray(entry.models) ? [...entry.models] : [];
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    updateCap(capKey, { models: list });
  };

  const activeCapConfig = CAPACITY_ADAPTER_CAPS.find((c) => c.key === activeCapForModal);

  return (
    <div className="flex flex-col gap-3">
      {CAPACITY_ADAPTER_CAPS.map((cap) => {
        const entry = capacityAdapter[cap.key] || {
          enabled: true,
          roundRobin: false,
          models: [],
        };
        const enabled = entry.enabled !== false;
        const roundRobin = !!entry.roundRobin;
        const models = Array.isArray(entry.models) ? entry.models : [];

        return (
          <section
            key={cap.key}
            aria-label={cap.label}
            className={`flex flex-col gap-3 rounded-2xl border border-dashed border-line bg-panel p-4 transition-opacity ${
              enabled ? "opacity-100" : "opacity-60"
            }`}
          >
            <div className="flex items-center gap-2.5">
              <span
                className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-sky-bg text-sky"
                aria-hidden="true"
              >
                <span className="material-symbols-outlined text-[18px]">{cap.icon}</span>
              </span>
              <span className="min-w-0 flex-1 font-display text-sm font-semibold text-text">
                {cap.label}
              </span>
              <Toggle
                size="sm"
                checked={enabled}
                onChange={(val) => updateCap(cap.key, { enabled: val })}
                aria-label={`${cap.label} enabled`}
              />
            </div>

            <p className="text-xs text-muted leading-relaxed">{cap.desc}</p>

            <div className="flex items-center justify-between gap-2 pt-1 border-t border-line/60">
              <span className="flex items-center gap-2 text-xs text-muted">
                <Toggle
                  size="sm"
                  checked={roundRobin}
                  disabled={!enabled}
                  onChange={(val) => updateCap(cap.key, { roundRobin: val })}
                  label="Round robin"
                />
              </span>

              <Button
                variant="secondary"
                size="sm"
                icon="add"
                disabled={!enabled}
                onClick={() => setActiveCapForModal(cap.key)}
                className="h-8 border-dashed px-2.5 text-xs"
              >
                Add model
              </Button>
            </div>

            {/* Model list chips */}
            {models.length > 0 ? (
              <ul aria-label={`${cap.label} model pool`} className="flex flex-col gap-1.5 pt-1">
                {models.map((model, index) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: pools may repeat; position is the identity.
                    key={`${model}-${index}`}
                    className="group/chip flex min-w-0 items-center gap-1 rounded-md border border-line bg-raised ps-2 pe-1 py-0.5 font-mono text-xs text-text [&>*:not(:first-child)]:shrink-0"
                  >
                    <span className="min-w-0 flex-1 truncate" title={model}>
                      {model}
                    </span>
                    <CapacityBadges caps={getCaps?.(model)} />
                    <button
                      type="button"
                      disabled={!enabled || index === 0}
                      onClick={() => handleMove(cap.key, index, -1)}
                      aria-label={`Move ${model} up`}
                      title="Move up"
                      className="p-0.5 text-muted hover:text-coral disabled:opacity-20"
                    >
                      <span className="material-symbols-outlined text-[13px]" aria-hidden="true">
                        arrow_upward
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={!enabled || index === models.length - 1}
                      onClick={() => handleMove(cap.key, index, 1)}
                      aria-label={`Move ${model} down`}
                      title="Move down"
                      className="p-0.5 text-muted hover:text-coral disabled:opacity-20"
                    >
                      <span className="material-symbols-outlined text-[13px]" aria-hidden="true">
                        arrow_downward
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={!enabled}
                      onClick={() => handleRemove(cap.key, index)}
                      aria-label={`Remove ${model} from ${cap.label}`}
                      title="Remove"
                      className="p-0.5 text-muted hover:text-err disabled:opacity-20"
                    >
                      <span className="material-symbols-outlined text-[13px]" aria-hidden="true">
                        close
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-xs italic text-muted">No models in pool</span>
            )}
          </section>
        );
      })}

      {activeCapForModal && activeCapConfig && (
        <ModelSelectModal
          isOpen={true}
          onClose={() => setActiveCapForModal(null)}
          onSelect={(model) => handleAdd(activeCapForModal, model)}
          activeProviders={activeProviders}
          title={`Add ${activeCapConfig.short} Model`}
          capFilter={activeCapConfig.key}
          addedModelValues={capacityAdapter[activeCapForModal]?.models || []}
          closeOnSelect={false}
        />
      )}
    </div>
  );
}

CapabilityAdapterCard.propTypes = {
  capacityAdapter: PropTypes.object,
  onChange: PropTypes.func.isRequired,
  activeProviders: PropTypes.array,
  getCaps: PropTypes.func,
};
