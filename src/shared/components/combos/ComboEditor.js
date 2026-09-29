"use client";

import { useRef, useState } from "react";
import PropTypes from "prop-types";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import Button from "@/shared/components/Button";
import CopyField from "@/shared/components/CopyField";
import IconButton from "@/shared/components/IconButton";
import Input from "@/shared/components/Input";
import ModelSelectModal from "@/shared/components/ModelSelectModal";
import { ConfirmDialog } from "@/shared/components/Modal";
import {
  roleLabel,
  explainWeightedShares,
  shareDetailText,
  parseWeight,
  validateComboName,
  assignStepIds,
  pruneKeys,
} from "./comboBuilder";
import StrategyPicker from "./StrategyPicker";
import RouteStep from "./RouteStep";
import RouteTestPanel from "./RouteTestPanel";

/**
 * Combo editor card: header (rename, CopyField, Delete/Save), strategy
 * cards + explainer, numbered route track with drag-reorder, weighted
 * inputs + share meters, fusion judge row, model picker.
 */
export default function ComboEditor({
  combo,
  strategy,
  weights,
  judgeModel,
  headroom,
  headroomQuotaSource,
  healthByProvider,
  providerLabelById,
  saving,
  dirty,
  emptyAdapters = [],
  onAddAdapterModel,
  saveError,
  onRename,
  onDelete,
  onSave,
  onDiscard,
  onStrategyChange,
  onWeightSave,
  onJudgeChange,
  onModelsChange,
  activeProviders,
  modelAliases,
}) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(combo.name);
  const [nameError, setNameError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [showJudgeSelect, setShowJudgeSelect] = useState(false);
  const [drafts, setDrafts] = useState({});
  const [weightErrors, setWeightErrors] = useState({});
  const [announcement, setAnnouncement] = useState("");
  const [trackStates, setTrackStates] = useState([]);
  const prevStepsRef = useRef([]);

  const models = combo.models || [];
  const isWeighted = strategy === "weighted";
  const isFusion = strategy === "fusion";
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const steps = assignStepIds(models, prevStepsRef.current);
  prevStepsRef.current = steps;
  const modelById = (id) => steps.find((s) => s.id === id)?.model;
  // Effective shares come from the router's own math (comboWeights.js via
  // explainWeightedShares): unsaved weight drafts preview like saved ones.
  const weightByModel = {};
  for (const { id, model } of steps) {
    const parsed = parseWeight(drafts[id]);
    weightByModel[model] = parsed.ok ? parsed.value : (weights[model] ?? 1);
  }
  const explanations = isWeighted
    ? explainWeightedShares(
        steps.map((s) => s.model),
        weightByModel,
        headroom,
        headroomQuotaSource,
      )
    : [];

  const commitRename = () => {
    const result = validateComboName(nameDraft);
    if (!result.ok) {
      setNameError(result.error);
      return;
    }
    setNameError("");
    setRenaming(false);
    if (result.value !== combo.name) onRename?.(result.value);
  };

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = steps.findIndex((s) => s.id === active.id);
    const newIndex = steps.findIndex((s) => s.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const moved = steps[oldIndex];
    const next = arrayMove(steps, oldIndex, newIndex).map((s) => s.model);
    prevStepsRef.current = arrayMove(steps, oldIndex, newIndex);
    onModelsChange?.(next);
    setAnnouncement(`Moved ${moved.model} to position ${newIndex + 1} of ${steps.length}`);
  };

  const saveWeight = (stepId) => {
    if (!(stepId in drafts)) return;
    const model = modelById(stepId);
    const clearDraft = () =>
      setDrafts((prev) => {
        const { [stepId]: _dropped, ...rest } = prev;
        return rest;
      });
    const parsed = parseWeight(drafts[stepId]);
    if (!parsed.ok) {
      setWeightErrors((prev) => ({ ...prev, [stepId]: parsed.error }));
      return;
    }
    if (model !== undefined && parsed.value === (weights[model] ?? 1)) {
      clearDraft();
      setWeightErrors((prev) => {
        const { [stepId]: _dropped, ...rest } = prev;
        return rest;
      });
      return;
    }
    setWeightErrors((prev) => {
      const { [stepId]: _dropped, ...rest } = prev;
      return rest;
    });
    clearDraft();
    if (model !== undefined) onWeightSave?.(model, parsed.value);
  };

  return (
    <section
      aria-label={`Edit combo ${combo.name}`}
      className="flex min-w-0 flex-1 flex-col gap-5 rounded-[20px] border border-line bg-panel p-5 shadow-card sm:p-7"
    >
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>

      {/* Header: name + rename, CopyField, Delete/Save */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex shrink-0 flex-col gap-1">
          {renaming ? (
            <div className="flex max-w-sm flex-col gap-1">
              <Input
                value={nameDraft}
                onChange={(e) => {
                  setNameDraft(e.target.value);
                  if (e.target.value) {
                    const r = validateComboName(e.target.value);
                    setNameError(r.ok ? "" : r.error);
                  } else setNameError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") {
                    // Claim Esc for the inline rename so the dismiss layer
                    // never sees it: the rename cancels, the route card stays.
                    e.preventDefault();
                    setNameDraft(combo.name);
                    setNameError("");
                    setRenaming(false);
                  }
                }}
                aria-label="Combo name"
                error={nameError}
                autoFocus
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={commitRename}
                  disabled={!!nameError || !nameDraft.trim()}
                >
                  Apply
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setNameDraft(combo.name);
                    setNameError("");
                    setRenaming(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-semibold tracking-wider text-muted uppercase">Combo</h2>
              <IconButton
                icon="edit"
                label={`Rename combo ${combo.name}`}
                onClick={() => {
                  setNameDraft(combo.name);
                  setNameError("");
                  setRenaming(true);
                }}
                className="size-8 rounded-md"
              />
            </div>
          )}
        </div>
        <CopyField
          value={`"model": "${combo.name}"`}
          copyValue={combo.name}
          label="Copy combo model name"
          className="w-full min-w-0 sm:w-auto sm:min-w-52 sm:flex-1"
        />
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <Button variant="danger" icon="delete" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
          <Button
            variant="secondary"
            icon="undo"
            disabled={!dirty || saving}
            onClick={() => {
              setDrafts({});
              setWeightErrors({});
              onDiscard?.();
            }}
          >
            Discard
          </Button>
          <Button
            variant="primary"
            icon="save"
            loading={saving}
            disabled={!dirty || saving}
            onClick={onSave}
          >
            Save
          </Button>
        </div>
      </div>
      <p
        aria-live="polite"
        className={`-mt-2 flex items-center gap-2 text-xs font-medium ${dirty ? "text-warn" : "text-muted"}`}
      >
        <span
          aria-hidden="true"
          className={`size-2 rounded-full ${dirty ? "bg-warn" : "bg-subtle"}`}
        />
        {dirty ? "Unsaved changes" : "No changes"}
      </p>
      {saveError && (
        <p role="alert" className="text-sm text-err">
          {saveError}
        </p>
      )}

      {emptyAdapters.length > 0 && (
        <p role="status" className="rounded-xl border border-warn bg-warn-bg p-3 text-sm text-warn">
          {emptyAdapters.map((key) => (key === "vision" ? "Vision" : "Audio")).join(" and ")}{" "}
          adapter on, but no models. 9router tries oc/mimo-v2.5-free; if it can't handle the
          request, the original route may reject the media.{" "}
          <button
            type="button"
            className="font-semibold underline underline-offset-2 focus-visible:shadow-focus focus-visible:outline-none"
            onClick={() => onAddAdapterModel?.(emptyAdapters[0])}
          >
            Add model
          </button>
        </p>
      )}
      <StrategyPicker value={strategy} onChange={onStrategyChange} />

      {/* Route track */}
      <div className="flex flex-col">
        <p className="mb-3 text-xs font-semibold tracking-wider text-muted uppercase">The route</p>
        {models.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-muted">
            No models in this route yet. Add one below.
          </p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          >
            <SortableContext items={steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              <ol className="m-0 list-none p-0">
                {steps.map(({ id, model }, index) => {
                  const providerId = model.includes("/")
                    ? model.slice(0, model.indexOf("/"))
                    : model;
                  const health = healthByProvider?.[providerId] || {
                    label: "No data",
                    variant: "neutral",
                  };
                  const explanation = explanations[index];
                  const track = trackStates[index];
                  return (
                    <RouteStep
                      key={id}
                      uid={id}
                      index={index}
                      model={model}
                      providerLabel={providerLabelById?.[providerId] || providerId}
                      role={roleLabel(strategy, index)}
                      health={health.label}
                      healthVariant={health.variant}
                      showWeight={isWeighted}
                      weight={drafts[id] ?? String(weights[model] ?? 1)}
                      weightDetail={explanation ? shareDetailText(explanation) : undefined}
                      share={explanation?.share ?? 0}
                      replayState={track?.state}
                      replayReason={track?.reason}
                      weightError={weightErrors[id]}
                      onWeightChange={(v) => {
                        setDrafts((prev) => ({ ...prev, [id]: v }));
                        setWeightErrors((prev) => {
                          const { [id]: _dropped, ...rest } = prev;
                          return rest;
                        });
                        const parsed = parseWeight(v);
                        if (parsed.ok && model !== undefined) onWeightSave?.(model, parsed.value);
                      }}
                      onWeightBlur={() => saveWeight(id)}
                      onRemove={() => {
                        const valid = new Set(steps.map((s) => s.id).filter((x) => x !== id));
                        setDrafts((prev) => pruneKeys(prev, valid));
                        setWeightErrors((prev) => pruneKeys(prev, valid));
                        onModelsChange?.(models.filter((_, i) => i !== index));
                      }}
                    />
                  );
                })}
              </ol>
            </SortableContext>
          </DndContext>
        )}
        <div className="flex gap-3.5">
          <div className="flex w-8 shrink-0 justify-center" aria-hidden="true">
            <span className="size-7 rounded-full border-2 border-dashed border-subtle" />
          </div>
          <Button
            variant="ghost"
            icon="add"
            onClick={() => setShowModelSelect(true)}
            className="flex-1 justify-start border-dashed text-muted"
          >
            Add a model to this route
          </Button>
        </div>

        {isFusion && (
          <div className="mt-3.5 ms-11 flex items-center gap-3 rounded-xl border border-coral bg-coral-bg p-3.5 sm:p-4">
            <span
              className="material-symbols-outlined shrink-0 text-[20px] text-coral-ink"
              aria-hidden="true"
            >
              gavel
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-text">
                Judge ·{" "}
                <code className="font-mono">
                  {judgeModel || `Auto — ${models[0] || "first model"}`}
                </code>
              </p>
              <p className="text-xs text-muted">
                Reads every panel answer and returns the best one
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {judgeModel && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onJudgeChange?.("")}
                  aria-label="Reset judge to Auto"
                >
                  Reset to Auto
                </Button>
              )}
              <Button size="sm" variant="secondary" onClick={() => setShowJudgeSelect(true)}>
                Change
              </Button>
            </div>
          </div>
        )}
      </div>

      {showModelSelect && (
        <ModelSelectModal
          isOpen={showModelSelect}
          onClose={() => setShowModelSelect(false)}
          onSelect={(m) => {
            if (m?.value && !models.includes(m.value)) onModelsChange?.([...models, m.value]);
          }}
          onDeselect={(m) => {
            if (m?.value) onModelsChange?.(models.filter((x) => x !== m.value));
          }}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title="Add Model to Route"
          addedModelValues={models}
          closeOnSelect={false}
        />
      )}
      {showJudgeSelect && (
        <ModelSelectModal
          isOpen={showJudgeSelect}
          onClose={() => setShowJudgeSelect(false)}
          onSelect={(m) => {
            onJudgeChange?.(m?.value || "");
            setShowJudgeSelect(false);
          }}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title="Select Judge Model"
          addedModelValues={judgeModel ? [judgeModel] : []}
          closeOnSelect
        />
      )}
      <ConfirmDialog
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          onDelete?.();
        }}
        title="Delete Combo"
        message={`Delete combo "${combo.name}"? This cannot be undone.`}
        confirmText="Delete"
        variant="danger"
      />
      <RouteTestPanel
        comboId={combo.id}
        models={models}
        comboName={combo.name}
        onTrackStatesChange={setTrackStates}
      />
    </section>
  );
}

ComboEditor.propTypes = {
  combo: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    models: PropTypes.arrayOf(PropTypes.string),
  }).isRequired,
  strategy: PropTypes.string.isRequired,
  weights: PropTypes.object,
  judgeModel: PropTypes.string,
  headroom: PropTypes.objectOf(PropTypes.number),
  headroomQuotaSource: PropTypes.objectOf(PropTypes.string),
  quotaByModel: PropTypes.objectOf(
    PropTypes.shape({ headroom: PropTypes.number, source: PropTypes.string }),
  ),
  healthByProvider: PropTypes.object,
  providerLabelById: PropTypes.object,
  saving: PropTypes.bool,
  dirty: PropTypes.bool,
  emptyAdapters: PropTypes.arrayOf(PropTypes.string),
  onAddAdapterModel: PropTypes.func,
  saveError: PropTypes.string,
  onRename: PropTypes.func,
  onDelete: PropTypes.func,
  onSave: PropTypes.func,
  onDiscard: PropTypes.func,
  onStrategyChange: PropTypes.func,
  onWeightSave: PropTypes.func,
  onJudgeChange: PropTypes.func,
  onModelsChange: PropTypes.func,
  activeProviders: PropTypes.array,
  modelAliases: PropTypes.object,
};
