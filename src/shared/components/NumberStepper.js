"use client";

import PropTypes from "prop-types";
import { useState } from "react";
import { cn } from "@/shared/utils/cn";
import { clampNumber, stepNumber } from "./formPrimitives";
import Field from "./Field";

/**
 * Signal numeric stepper: minus/plus buttons flank a numeric input. Holds a
 * string draft so partial input ("-", "1.") stays editable; commits a clamped
 * number on blur or step.
 */
export default function NumberStepper({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  error,
  hint,
  disabled = false,
  required = false,
  className,
  id,
  ...props
}) {
  const [draft, setDraft] = useState(null);

  const shown = draft ?? value ?? "";

  const commit = (next) => {
    const clamped = clampNumber(next, { min, max });
    setDraft(null);
    // Partial input ("-", ".") is not a number: drop it and keep the last good value.
    if (typeof clamped === "string" && clamped !== "") return;
    if (clamped !== value) onChange?.(clamped);
  };

  const stepBy = (direction) => {
    const base = draft ?? value;
    const next = stepNumber(base === "" ? undefined : base, { min, max, step, direction });
    setDraft(null);
    onChange?.(next);
  };

  const stepperButton =
    "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-line bg-raised text-muted transition-colors hover:text-text focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <Field
      id={id}
      label={label}
      hint={hint}
      error={error}
      required={required}
      className={className}
    >
      {({ inputId, describedBy, invalid }) => (
        <div className="flex items-stretch gap-2">
          <button
            type="button"
            aria-label="Decrease value"
            aria-controls={inputId}
            disabled={disabled}
            onClick={() => stepBy(-1)}
            className={stepperButton}
          >
            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
              remove
            </span>
          </button>
          <input
            {...props}
            id={inputId}
            type="number"
            inputMode="decimal"
            value={shown}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => commit(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commit(event.currentTarget.value);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                stepBy(1);
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                stepBy(-1);
              }
            }}
            className={cn(
              "w-full h-11 px-3 text-center text-sm text-text bg-raised rounded-lg",
              "border border-line focus:outline-none focus:border-coral focus:shadow-focus",
              "transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed",
              "text-[16px] sm:text-sm [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
              invalid && "border-err focus:border-err",
            )}
          />
          <button
            type="button"
            aria-label="Increase value"
            aria-controls={inputId}
            disabled={disabled}
            onClick={() => stepBy(1)}
            className={stepperButton}
          >
            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
              add
            </span>
          </button>
        </div>
      )}
    </Field>
  );
}

NumberStepper.propTypes = {
  label: PropTypes.node,
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  onChange: PropTypes.func,
  min: PropTypes.number,
  max: PropTypes.number,
  step: PropTypes.number,
  error: PropTypes.node,
  hint: PropTypes.node,
  disabled: PropTypes.bool,
  required: PropTypes.bool,
  className: PropTypes.string,
  id: PropTypes.string,
};
