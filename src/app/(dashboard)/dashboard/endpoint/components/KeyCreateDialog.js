"use client";

import PropTypes from "prop-types";
import { Button, Input, Modal, Select } from "@/shared/components";

/**
 * Create API key modal (Signal primitives). Name always; hashed mode adds the
 * key-owner radio (service only when the capability allows), model/combo
 * scope, the optional USD spend limit + window, and expiry. Validation, the
 * one-time reveal banner, and permission gating stay in the parent.
 */
export default function KeyCreateDialog({
  isOpen,
  onClose,
  onCreate,
  newName,
  onNewName,
  createError,
  hashedMode,
  canCreateService,
  createType,
  onSetCreateType,
  createModels,
  onSetCreateModels,
  createCombos,
  onSetCreateCombos,
  createBudgetUsd,
  onSetCreateBudgetUsd,
  createBudgetWindow,
  onSetCreateBudgetWindow,
  createExpiry,
  onSetCreateExpiry,
  customExpiryDate,
  onSetCustomExpiryDate,
  creating = false,
}) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Create API key"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={onCreate}
            loading={creating}
            disabled={!newName.trim() || creating}
          >
            Create
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!creating) onCreate();
        }}
      >
        <Input
          label="Key name"
          value={newName}
          onChange={(e) => onNewName(e.target.value)}
          placeholder="Production key"
          error={createError}
          maxLength={64}
        />
        {hashedMode && (
          <>
            {canCreateService && (
              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-medium text-text">Key owner</legend>
                <label className="flex items-center gap-2 text-sm text-text">
                  <input
                    type="radio"
                    name="key-owner"
                    value="user"
                    checked={createType === "user"}
                    onChange={() => onSetCreateType("user")}
                    className="size-4 accent-coral"
                  />
                  Me (user key)
                </label>
                <label className="flex items-center gap-2 text-sm text-text">
                  <input
                    type="radio"
                    name="key-owner"
                    value="service"
                    checked={createType === "service"}
                    onChange={() => onSetCreateType("service")}
                    className="size-4 accent-coral"
                  />
                  Service key
                </label>
              </fieldset>
            )}
            <Input
              label="Limit models (optional)"
              value={createModels}
              onChange={(e) => onSetCreateModels(e.target.value)}
              placeholder="openai/gpt-4o, anthropic/claude"
              hint="Empty means all models in the workspace."
            />
            <Input
              label="Limit combos (optional)"
              value={createCombos}
              onChange={(e) => onSetCreateCombos(e.target.value)}
              placeholder="fast-cheap, balanced"
              hint="Workspace combo ids. Empty means all combos."
            />
            <Input
              label="Spend limit (USD, optional)"
              type="number"
              min="0"
              step="0.01"
              value={createBudgetUsd}
              onChange={(e) => onSetCreateBudgetUsd(e.target.value)}
              placeholder="50"
              hint="Cap this key's spend. Empty means no budget."
            />
            <Select
              label="Spend window"
              value={createBudgetWindow}
              onChange={(e) => onSetCreateBudgetWindow(e.target.value)}
              options={[
                { value: "day", label: "Daily" },
                { value: "week", label: "Weekly" },
                { value: "month", label: "Monthly" },
                { value: "total", label: "Total" },
              ]}
            />
            <Select
              label="Expires"
              value={createExpiry}
              onChange={(e) => onSetCreateExpiry(e.target.value)}
              options={[
                { value: "never", label: "Never" },
                { value: "7", label: "7 days" },
                { value: "30", label: "30 days" },
                { value: "90", label: "90 days" },
                { value: "custom", label: "Custom date" },
              ]}
            />
            {createExpiry === "custom" && (
              <Input
                label="Custom expiry date"
                type="date"
                value={customExpiryDate}
                onChange={(e) => onSetCustomExpiryDate(e.target.value)}
                min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)}
              />
            )}
          </>
        )}
        {createError && (
          <p className="sr-only" role="alert">
            {createError}
          </p>
        )}
      </form>
    </Modal>
  );
}

KeyCreateDialog.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onCreate: PropTypes.func.isRequired,
  newName: PropTypes.string.isRequired,
  onNewName: PropTypes.func.isRequired,
  createError: PropTypes.string,
  hashedMode: PropTypes.bool,
  canCreateService: PropTypes.bool,
  createType: PropTypes.string,
  onSetCreateType: PropTypes.func,
  createModels: PropTypes.string,
  onSetCreateModels: PropTypes.func,
  createCombos: PropTypes.string,
  onSetCreateCombos: PropTypes.func,
  createBudgetUsd: PropTypes.string,
  onSetCreateBudgetUsd: PropTypes.func,
  createBudgetWindow: PropTypes.string,
  onSetCreateBudgetWindow: PropTypes.func,
  createExpiry: PropTypes.string,
  onSetCreateExpiry: PropTypes.func,
  customExpiryDate: PropTypes.string,
  onSetCustomExpiryDate: PropTypes.func,
  creating: PropTypes.bool,
};
