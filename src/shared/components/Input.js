"use client";

import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";
import Field from "./Field";

/** Signal text input wired to a Field (label/hint/error ids, aria-describedby, aria-invalid). */
export default function Input({
  label,
  type = "text",
  placeholder,
  value,
  onChange,
  error,
  hint,
  icon,
  disabled = false,
  required = false,
  className,
  inputClassName,
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
          {icon && (
            <div
              className="absolute inset-y-0 start-0 flex items-center ps-3 pointer-events-none text-muted"
              aria-hidden="true"
            >
              <span className="material-symbols-outlined text-[20px]">{icon}</span>
            </div>
          )}
          <input
            {...props}
            id={inputId}
            type={type}
            placeholder={placeholder}
            value={value}
            onChange={onChange}
            disabled={disabled}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            className={cn(
              "w-full py-2.5 px-3 text-sm text-text bg-raised rounded-lg",
              "border border-line placeholder:text-subtle",
              "focus:outline-none focus:border-coral focus:shadow-focus",
              "transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed",
              // iOS zoom fix
              "text-[16px] sm:text-sm",
              icon && "ps-10",
              invalid && "border-err focus:border-err",
              inputClassName,
            )}
          />
        </div>
      )}
    </Field>
  );
}

Input.propTypes = {
  label: PropTypes.node,
  type: PropTypes.string,
  placeholder: PropTypes.string,
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  onChange: PropTypes.func,
  error: PropTypes.node,
  hint: PropTypes.node,
  icon: PropTypes.string,
  disabled: PropTypes.bool,
  required: PropTypes.bool,
  className: PropTypes.string,
  inputClassName: PropTypes.string,
  id: PropTypes.string,
  "aria-label": PropTypes.string,
};
