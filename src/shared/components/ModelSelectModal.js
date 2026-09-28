"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import Input from "./Input";
import Callout from "./Callout";
import EmptyState from "./EmptyState";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import { modelChoiceValue } from "./modelSelect/modelSelectHelpers";
import { useModelSelectData } from "./modelSelect/useModelSelectData";
import { ComboChips, ModelGroupChips } from "./modelSelect/ModelGroups";

/**
 * Model picker grouped by connected provider (design-system §4).
 * Live account catalogs, combos, custom/disabled models, search, typed-kind
 * and capability filters, and add/remove chip state. Same props as before.
 *
 * @param {object} props
 * @param {boolean} props.isOpen
 * @param {() => void} props.onClose
 * @param {(model: object) => void} props.onSelect
 * @param {(model: object) => void} [props.onDeselect] Added rows call this instead.
 * @param {string} [props.selectedModel] Highlighted full model value.
 * @param {Array<{ provider: string }>} [props.activeProviders]
 * @param {string} [props.title]
 * @param {Record<string, string>} [props.modelAliases]
 * @param {string} [props.kindFilter] Service kind such as image, tts or webSearch.
 * @param {string} [props.capFilter] Input-modality capability such as vision.
 * @param {string[]} [props.addedModelValues] Full values already added (toggle to remove).
 * @param {boolean} [props.closeOnSelect]
 */
export default function ModelSelectModal({
  isOpen,
  onClose,
  onSelect,
  onDeselect,
  selectedModel,
  activeProviders = [],
  title = "Select Model",
  modelAliases = {},
  kindFilter = null,
  capFilter = null,
  addedModelValues = [],
  closeOnSelect = true,
}) {
  const { getCaps } = useModelCaps();
  const [searchQuery, setSearchQuery] = useState("");
  const { filteredCombos, filteredGroups } = useModelSelectData({
    isOpen,
    activeProviders,
    kindFilter,
    capFilter,
    modelAliases,
    searchQuery,
    addedModelValues,
    getCaps,
  });

  const handleSelect = (model) => {
    const value = modelChoiceValue(model);
    if (addedModelValues.includes(value) && onDeselect) onDeselect(model);
    else onSelect(model);
    if (closeOnSelect) {
      onClose();
      setSearchQuery("");
    }
  };
  const handleClose = () => {
    onClose();
    setSearchQuery("");
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={title} size="md">
      <Callout variant="info" className="mb-3">
        Click to add, click again to remove. Changes are saved automatically.
      </Callout>
      <div className="mb-3">
        <Input
          icon="search"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Search..."
        />
      </div>
      <div className="max-h-[400px] overflow-y-auto space-y-3">
        <ComboChips
          combos={filteredCombos}
          selectedModel={selectedModel}
          addedModelValues={addedModelValues}
          onSelect={handleSelect}
        />
        {Object.entries(filteredGroups).map(([providerId, group]) => (
          <ModelGroupChips
            key={providerId}
            providerId={providerId}
            group={group}
            selectedModel={selectedModel}
            addedModelValues={addedModelValues}
            getCaps={getCaps}
            onSelect={handleSelect}
          />
        ))}
        {Object.keys(filteredGroups).length === 0 && filteredCombos.length === 0 && (
          <EmptyState icon="search_off" title="No models found" className="py-4" />
        )}
      </div>
    </Modal>
  );
}

ModelSelectModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onSelect: PropTypes.func.isRequired,
  onDeselect: PropTypes.func,
  selectedModel: PropTypes.string,
  activeProviders: PropTypes.arrayOf(
    PropTypes.shape({
      provider: PropTypes.string.isRequired,
    }),
  ),
  title: PropTypes.string,
  modelAliases: PropTypes.object,
  kindFilter: PropTypes.string,
  capFilter: PropTypes.string,
  addedModelValues: PropTypes.arrayOf(PropTypes.string),
  closeOnSelect: PropTypes.bool,
};
