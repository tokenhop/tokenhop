"use client";

import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";
import Field from "./Field";

/** Signal multi-line text input: same Field wiring and chrome as Input. */
export default function Textarea({
  label,
  placeholder,
  value,
  onChange,
  error,
  hint,
  disabled = false,
  required = false,
  rows = 3,
  className,
  textareaClassName,
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
        <textarea
          {...props}
          id={inputId}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          disabled={disabled}
          rows={rows}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className={cn(
            "w-full px-3 py-2.5 text-sm text-text bg-raised rounded-lg",
            "border border-line placeholder:text-subtle resize-y",
            "focus:outline-none focus:border-coral focus:shadow-focus",
            "transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed",
            "text-[16px] sm:text-sm",
            invalid && "border-err focus:border-err",
            textareaClassName,
          )}
        />
      )}
    </Field>
  );
}

Textarea.propTypes = {
  label: PropTypes.node,
  placeholder: PropTypes.string,
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  onChange: PropTypes.func,
  error: PropTypes.node,
  hint: PropTypes.node,
  disabled: PropTypes.bool,
  required: PropTypes.bool,
  rows: PropTypes.number,
  className: PropTypes.string,
  textareaClassName: PropTypes.string,
  id: PropTypes.string,
  "aria-label": PropTypes.string,
};
