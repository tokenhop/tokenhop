"use client";

import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";
import Field from "./Field";

/**
 * Signal value + unit input: a field with a muted unit suffix inside the
 * chrome. The suffix is announced to screen readers via `aria-describedby`.
 */
export default function UnitInput({
  label,
  value,
  onChange,
  unit,
  type = "number",
  error,
  hint,
  disabled = false,
  required = false,
  className,
  id,
  ...props
}) {
  return (
    <Field
      id={id}
      label={label}
      hint={hint}
      error={error}
      required={required}
      className={className}
    >
      {({ inputId, describedBy, invalid }) => {
        const unitId = `${inputId}-unit`;
        const described =
          [unit ? unitId : null, describedBy].filter(Boolean).join(" ") || undefined;
        return (
          <div
            className={cn(
              "flex h-11 items-center rounded-lg border border-line bg-raised transition-colors",
              "focus-within:border-coral focus-within:shadow-focus",
              invalid && "border-err focus-within:border-err",
              disabled && "opacity-50",
            )}
          >
            <input
              {...props}
              id={inputId}
              type={type}
              inputMode={type === "number" ? "decimal" : undefined}
              value={value}
              onChange={onChange}
              disabled={disabled}
              aria-describedby={described}
              aria-invalid={invalid || undefined}
              className="w-full min-w-0 bg-transparent px-3 py-2.5 text-sm text-text placeholder:text-subtle focus:outline-none text-[16px] sm:text-sm [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            {unit && (
              <span id={unitId} className="shrink-0 pe-3 text-sm text-subtle">
                {unit}
              </span>
            )}
          </div>
        );
      }}
    </Field>
  );
}

UnitInput.propTypes = {
  label: PropTypes.node,
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  onChange: PropTypes.func,
  type: PropTypes.string,
  unit: PropTypes.node,
  error: PropTypes.node,
  hint: PropTypes.node,
  disabled: PropTypes.bool,
  required: PropTypes.bool,
  className: PropTypes.string,
  id: PropTypes.string,
};
