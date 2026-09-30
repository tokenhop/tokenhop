"use client";

import PropTypes from "prop-types";
import { Card, Input, Toggle } from "@/shared/components";

/** Name editor (validates on change, saves on blur) and the round-robin toggle. */
export default function ComboSettingsCard({
  name,
  nameError,
  saveStatus,
  onNameChange,
  onNameBlur,
  roundRobin,
  savingStrategy,
  onToggleRoundRobin,
}) {
  return (
    <Card>
      <h2 className="mb-3 text-lg font-semibold">Settings</h2>
      <div className="flex flex-col gap-4">
        <Input
          label="Combo name"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          onBlur={onNameBlur}
          error={nameError}
          hint="Only letters, numbers, -, _ and ."
        />
        <span aria-live="polite" className="sr-only">
          {saveStatus}
        </span>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Round robin</p>
            <p className="text-xs text-muted">
              Rotate providers across requests instead of strict fallback order.
            </p>
          </div>
          <Toggle
            checked={roundRobin}
            onChange={onToggleRoundRobin}
            disabled={savingStrategy}
            aria-label="Round robin"
          />
        </div>
      </div>
    </Card>
  );
}

ComboSettingsCard.propTypes = {
  name: PropTypes.string.isRequired,
  nameError: PropTypes.string,
  saveStatus: PropTypes.string,
  onNameChange: PropTypes.func.isRequired,
  onNameBlur: PropTypes.func.isRequired,
  roundRobin: PropTypes.bool.isRequired,
  savingStrategy: PropTypes.bool.isRequired,
  onToggleRoundRobin: PropTypes.func.isRequired,
};
