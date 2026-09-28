"use client";

import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";
import Field from "./Field";

/**
 * Signal styled native select wired to a Field. Always renders a disabled
 * empty placeholder option first (existing contract: callers rely on it when
 * the value isn't in `options`).
 */
export default function Select({
  label,
  options = [],
  value,
  onChange,
  placeholder = "Select an option",
  error,
  hint,
  disabled = false,
  required = false,
  className,
  selectClassName,
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
      {({ inputId, describedBy, invalid }) => (
        <div className="relative">
          <select
            {...props}
            id={inputId}
            value={value}
            onChange={onChange}
            disabled={disabled}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            className={cn(
              "w-full h-11 ps-3 pe-10 text-sm text-text bg-raised rounded-lg appearance-none",
              "border border-line focus:outline-none focus:border-coral focus:shadow-focus",
              "transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed",
              "text-[16px] sm:text-sm",
              invalid && "border-err focus:border-err",
              selectClassName,
            )}
          >
            <option value="" disabled>
              {placeholder}
            </option>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <div
            className="absolute inset-y-0 end-0 flex items-center pe-3 pointer-events-none text-muted"
            aria-hidden="true"
          >
            <span className="material-symbols-outlined text-[20px]">expand_more</span>
          </div>
        </div>
      )}
    </Field>
  );
}

Select.propTypes = {
  label: PropTypes.node,
  options: PropTypes.arrayOf(
    PropTypes.shape({
      value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
      label: PropTypes.node.isRequired,
    }),
  ),
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  onChange: PropTypes.func,
  placeholder: PropTypes.string,
  error: PropTypes.node,
  hint: PropTypes.node,
  disabled: PropTypes.bool,
  required: PropTypes.bool,
  className: PropTypes.string,
  selectClassName: PropTypes.string,
  id: PropTypes.string,
};
