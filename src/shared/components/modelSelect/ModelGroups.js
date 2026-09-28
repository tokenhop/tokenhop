"use client";

import PropTypes from "prop-types";
import ProviderTile from "../ProviderTile";
import CapacityBadges from "../CapacityBadges";

/**
 * Picker chips for one provider group: selection/add state, placeholders, capacity badges.
 *
 * @param {object} props
 * @param {string} props.providerId
 * @param {{ name: string, color: string, models: Array<object> }} props.group
 * @param {string} [props.selectedModel]
 * @param {string[]} [props.addedModelValues]
 * @param {(model: object) => unknown} props.getCaps
 * @param {(model: object) => void} props.onSelect
 */
export function ModelGroupChips({
  providerId,
  group,
  selectedModel,
  addedModelValues = [],
  getCaps,
  onSelect,
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5 sticky top-0 bg-panel py-0.5">
        <ProviderTile providerId={providerId} size="sm" />
        <span className="text-xs font-medium text-coral">{group.name}</span>
        <span className="text-[10px] text-muted">({group.models.length})</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {group.models.map((model) => (
          <ModelChipButton
            key={model.value}
            model={model}
            selected={selectedModel === model.value}
            added={addedModelValues.includes(model.value)}
            caps={getCaps(model.value)}
            onSelect={() => onSelect(model)}
          />
        ))}
      </div>
    </div>
  );
}

ModelGroupChips.propTypes = {
  providerId: PropTypes.string.isRequired,
  group: PropTypes.shape({
    name: PropTypes.string,
    color: PropTypes.string,
    models: PropTypes.arrayOf(PropTypes.object).isRequired,
  }).isRequired,
  selectedModel: PropTypes.string,
  addedModelValues: PropTypes.arrayOf(PropTypes.string),
  getCaps: PropTypes.func.isRequired,
  onSelect: PropTypes.func.isRequired,
};

/**
 * One model picker chip. Placeholders get dashed styling; custom rows show a
 * "custom" tag and capacity badges.
 */
export function ModelChipButton({ model, selected, added, caps, onSelect }) {
  const placeholder = model.isPlaceholder;
  const klass = placeholder
    ? "border-dashed border-line text-muted hover:border-coral/50 hover:text-coral bg-panel italic"
    : selected
      ? "bg-coral text-on-coral border-coral"
      : added
        ? "bg-coral border-coral text-on-coral hover:bg-coral-ink"
        : "bg-panel border-line text-text hover:border-coral/50 hover:bg-coral-bg";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={placeholder ? undefined : Boolean(selected || added)}
      title={placeholder ? "Select to pre-fill, then edit model ID in the input" : undefined}
      className={`px-2 py-1 rounded-xl text-xs font-medium transition-all border hover:cursor-pointer ${klass}`}
    >
      <span className="flex items-center gap-1">
        {added && !placeholder && (
          <span
            className="material-symbols-outlined leading-none"
            style={{ fontSize: "10px" }}
            aria-hidden="true"
          >
            check
          </span>
        )}
        {placeholder ? (
          <>
            <span className="material-symbols-outlined text-[11px]" aria-hidden="true">
              edit
            </span>
            {model.name}
          </>
        ) : (
          <>
            {model.name}
            {model.isCustom && <span className="text-[9px] opacity-60 font-normal">custom</span>}
            <CapacityBadges caps={caps} />
          </>
        )}
      </span>
    </button>
  );
}

ModelChipButton.propTypes = {
  model: PropTypes.shape({
    name: PropTypes.string.isRequired,
    value: PropTypes.string.isRequired,
    isPlaceholder: PropTypes.bool,
    isCustom: PropTypes.bool,
  }).isRequired,
  selected: PropTypes.bool,
  added: PropTypes.bool,
  caps: PropTypes.object,
  onSelect: PropTypes.func.isRequired,
};

/**
 * Combo chips, always first in the picker. Combos are LLM-only by design;
 * callers must pass the kind/capability-filtered combo list.
 */
export function ComboChips({ combos, selectedModel, addedModelValues = [], onSelect }) {
  if (combos.length === 0) return null;
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5 sticky top-0 bg-panel py-0.5">
        <span className="material-symbols-outlined text-coral text-[14px]" aria-hidden="true">
          layers
        </span>
        <span className="text-xs font-medium text-coral">Combos</span>
        <span className="text-[10px] text-muted">({combos.length})</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {combos.map((combo) => {
          const added = addedModelValues.includes(combo.name);
          const klass =
            selectedModel === combo.name
              ? "bg-coral text-on-coral border-coral"
              : added
                ? "bg-coral border-coral text-on-coral hover:bg-coral-ink"
                : "bg-panel border-line text-text hover:border-coral/50 hover:bg-coral-bg";
          return (
            <button
              type="button"
              key={combo.id}
              onClick={() => onSelect({ id: combo.name, name: combo.name, value: combo.name })}
              aria-pressed={selectedModel === combo.name || added}
              className={`px-2 py-1 rounded-xl text-xs font-medium transition-all border hover:cursor-pointer flex items-center gap-1 ${klass}`}
            >
              {added && (
                <span
                  className="material-symbols-outlined leading-none"
                  style={{ fontSize: "10px" }}
                  aria-hidden="true"
                >
                  check
                </span>
              )}
              {combo.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

ComboChips.propTypes = {
  combos: PropTypes.arrayOf(
    PropTypes.shape({ id: PropTypes.string, name: PropTypes.string.isRequired }),
  ).isRequired,
  selectedModel: PropTypes.string,
  addedModelValues: PropTypes.arrayOf(PropTypes.string),
  onSelect: PropTypes.func.isRequired,
};
