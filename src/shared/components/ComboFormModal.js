"use client";

import { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import Input from "./Input";
import Button from "./Button";
import ModelSelectModal from "./ModelSelectModal";
import EmptyState from "./EmptyState";

const VALID_NAME_REGEX = /^[a-zA-Z0-9_.-]+$/;

/** One editable combo row: inline edit, reorder, remove. */
function ModelItem({ index, model, isFirst, isLast, onEdit, onMoveUp, onMoveDown, onRemove }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(model);
  const editRef = useRef(null);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== model) onEdit(trimmed);
    else setDraft(model);
    setEditing(false);
  };
  const handleKeyDown = (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") {
      e.preventDefault(); // keep the dialog open; Esc cancels the inline edit
      setDraft(model);
      setEditing(false);
    }
  };
  useEffect(() => {
    if (editing) editRef.current?.focus();
  }, [editing]);
  return (
    <li className="group flex min-w-0 items-center gap-1.5 rounded-md bg-raised px-2 py-1 transition-colors hover:bg-line/40">
      <span className="w-3 shrink-0 text-center text-[10px] font-medium text-muted">
        {index + 1}
      </span>
      {editing ? (
        <input
          ref={editRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          aria-label={`Model ${index + 1}`}
          className="min-w-0 flex-1 rounded border border-coral bg-raised px-1.5 py-0.5 font-mono text-xs text-text outline-none focus:shadow-focus"
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="Click to edit"
          aria-label={`Edit model ${index + 1}: ${model}`}
          className="min-w-0 flex-1 cursor-text truncate rounded px-1.5 py-0.5 text-start font-mono text-xs text-text hover:bg-raised"
        >
          {model}
        </button>
      )}
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={onMoveUp}
          disabled={isFirst}
          aria-label="Move up"
          title="Move up"
          className="rounded p-0.5 text-muted transition-colors hover:bg-raised hover:text-coral disabled:cursor-not-allowed disabled:opacity-30"
        >
          <span className="material-symbols-outlined text-[12px]" aria-hidden="true">
            arrow_upward
          </span>
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={isLast}
          aria-label="Move down"
          title="Move down"
          className="rounded p-0.5 text-muted transition-colors hover:bg-raised hover:text-coral disabled:cursor-not-allowed disabled:opacity-30"
        >
          <span className="material-symbols-outlined text-[12px]" aria-hidden="true">
            arrow_downward
          </span>
        </button>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove"
        title="Remove"
        className="rounded p-0.5 text-muted transition-all hover:bg-err-bg hover:text-err"
      >
        <span className="material-symbols-outlined text-[12px]" aria-hidden="true">
          close
        </span>
      </button>
    </li>
  );
}

/**
 * Reusable combo create/edit dialog. `forcePrefix` is stripped for editing and
 * re-prepended on save. `onSave` receives `{ name, models }`; the nested
 * ModelSelectModal multi-selects while open.
 */
export default function ComboFormModal({
  isOpen,
  combo,
  onClose,
  onSave,
  activeProviders,
  kindFilter = null,
  forcePrefix = "",
  title,
}) {
  // Strip prefix when editing existing combo so user only edits suffix
  const initialName = combo?.name
    ? forcePrefix && combo.name.startsWith(forcePrefix)
      ? combo.name.slice(forcePrefix.length)
      : combo.name
    : "";
  const [name, setName] = useState(initialName);
  const [models, setModels] = useState(combo?.models || []);
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState("");
  const [modelAliases, setModelAliases] = useState({});

  useEffect(() => {
    if (!isOpen) return;
    fetch("/api/models/alias")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setModelAliases(d.aliases || {}))
      .catch(() => {});
  }, [isOpen]);

  const validateName = (value) => {
    if (!value.trim()) {
      setNameError("Name is required");
      return false;
    }
    const full = forcePrefix + value;
    if (!VALID_NAME_REGEX.test(full)) {
      setNameError("Only letters, numbers, -, _ and . allowed");
      return false;
    }
    setNameError("");
    return true;
  };

  const handleNameChange = (e) => {
    let value = e.target.value;
    // If user types prefix manually, strip it (we always prepend)
    if (forcePrefix && value.startsWith(forcePrefix)) value = value.slice(forcePrefix.length);
    setName(value);
    if (value) validateName(value);
    else setNameError("");
  };

  const handleAddModel = (model) => {
    if (!models.includes(model.value)) setModels([...models, model.value]);
  };
  const handleDeselectModel = (model) => {
    setModels(models.filter((m) => m !== model.value));
  };
  const handleRemoveModel = (i) => setModels(models.filter((_, idx) => idx !== i));
  const handleMoveUp = (i) => {
    if (i === 0) return;
    const a = [...models];
    [a[i - 1], a[i]] = [a[i], a[i - 1]];
    setModels(a);
  };
  const handleMoveDown = (i) => {
    if (i === models.length - 1) return;
    const a = [...models];
    [a[i], a[i + 1]] = [a[i + 1], a[i]];
    setModels(a);
  };

  const handleSave = async () => {
    if (!validateName(name)) return;
    setSaving(true);
    try {
      await onSave({ name: forcePrefix + name.trim(), models });
    } catch (error) {
      setNameError(error?.message || "Failed to create combo");
    } finally {
      setSaving(false);
    }
  };

  const isEdit = !!combo;

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={title || (isEdit ? "Edit Combo" : "Create Combo")}
      >
        <div className="flex flex-col gap-3">
          <div>
            {forcePrefix ? (
              <>
                <label
                  htmlFor="combo-name-input"
                  className="mb-1 block text-sm font-medium text-text"
                >
                  Combo name
                </label>
                <div className="flex items-stretch">
                  <span className="inline-flex items-center rounded-s border border-e-0 border-line bg-raised px-2 font-mono text-sm text-muted">
                    {forcePrefix}
                  </span>
                  <input
                    id="combo-name-input"
                    value={name}
                    onChange={handleNameChange}
                    placeholder="my-combo"
                    className="min-w-0 flex-1 rounded-e border border-line bg-raised px-2 py-1.5 font-mono text-sm text-text outline-none focus:border-coral focus:shadow-focus"
                  />
                </div>
                {nameError && (
                  <p role="alert" className="mt-0.5 text-[11px] text-err">
                    {nameError}
                  </p>
                )}
              </>
            ) : (
              <Input
                label="Combo name"
                value={name}
                onChange={handleNameChange}
                placeholder="my-combo"
                error={nameError}
              />
            )}
            <p className="mt-0.5 text-[10px] text-muted">
              {forcePrefix ? `Auto-prefixed with "${forcePrefix}". ` : ""}Only letters, numbers, -,
              _ and . allowed
            </p>
          </div>

          <div>
            <p id="combo-models-label" className="mb-1.5 block text-sm font-medium text-text">
              Models
            </p>
            {models.length === 0 ? (
              <EmptyState icon="layers" title="No models added yet" className="py-4" />
            ) : (
              <ul
                aria-labelledby="combo-models-label"
                className="flex max-h-[55vh] min-w-0 flex-col gap-1 overflow-y-auto sm:max-h-[350px]"
              >
                {models.map((model, index) => (
                  <ModelItem
                    // biome-ignore lint/suspicious/noArrayIndexKey: models may repeat; position is the identity
                    key={`${model}-${index}`}
                    index={index}
                    model={model}
                    isFirst={index === 0}
                    isLast={index === models.length - 1}
                    onEdit={(v) => {
                      const a = [...models];
                      a[index] = v;
                      setModels(a);
                    }}
                    onMoveUp={() => handleMoveUp(index)}
                    onMoveDown={() => handleMoveDown(index)}
                    onRemove={() => handleRemoveModel(index)}
                  />
                ))}
              </ul>
            )}
            <Button
              variant="secondary"
              size="sm"
              fullWidth
              icon="add"
              onClick={() => setShowModelSelect(true)}
              className="mt-2 border-dashed"
            >
              Add model
            </Button>
          </div>

          <div className="flex flex-col gap-2 pt-1 sm:flex-row">
            <Button onClick={onClose} variant="ghost" fullWidth size="sm">
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              fullWidth
              size="sm"
              loading={saving}
              disabled={!name.trim() || !!nameError}
            >
              {isEdit ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      </Modal>

      {showModelSelect && (
        <ModelSelectModal
          isOpen={showModelSelect}
          onClose={() => setShowModelSelect(false)}
          onSelect={handleAddModel}
          onDeselect={handleDeselectModel}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title="Add model to combo"
          kindFilter={kindFilter}
          addedModelValues={models}
          closeOnSelect={false}
        />
      )}
    </>
  );
}

ModelItem.propTypes = {
  index: PropTypes.number.isRequired,
  model: PropTypes.string.isRequired,
  isFirst: PropTypes.bool,
  isLast: PropTypes.bool,
  onEdit: PropTypes.func.isRequired,
  onMoveUp: PropTypes.func.isRequired,
  onMoveDown: PropTypes.func.isRequired,
  onRemove: PropTypes.func.isRequired,
};

ComboFormModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  combo: PropTypes.shape({ name: PropTypes.string, models: PropTypes.arrayOf(PropTypes.string) }),
  onClose: PropTypes.func.isRequired,
  onSave: PropTypes.func.isRequired,
  activeProviders: PropTypes.array,
  kindFilter: PropTypes.string,
  forcePrefix: PropTypes.string,
  title: PropTypes.string,
};
