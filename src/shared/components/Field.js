"use client";

import PropTypes from "prop-types";
import { useId } from "react";
import { cn } from "@/shared/utils/cn";
import { describedByFor } from "./formPrimitives";

/**
 * Form field shell: wires a label, hint and error message to a single control
 * via generated ids (`useId`), `aria-describedby` and `aria-invalid`.
 *
 * Renders children through a render prop receiving:
 * - `inputId`: id to put on the control (matches the label's `htmlFor`)
 * - `describedBy`: space-separated ids for `aria-describedby` (hint and/or error), or undefined
 * - `invalid`: true when `error` is set (use for `aria-invalid` and error styling)
 *
 * @param {object} props
 * @param {string} [props.id] Control id (put on the input). Defaults to a `useId` value.
 * @param {React.ReactNode} [props.label] Visible label, associated to the control.
 * @param {React.ReactNode} [props.hint] Helper text shown when there is no error.
 * @param {React.ReactNode} [props.error] Error message; replaces the hint and marks the control invalid.
 * @param {boolean} [props.required] Shows an asterisk next to the label (visual only).
 * @param {string} [props.className] Extra classes on the wrapper.
 * @param {(field: { inputId: string, describedBy: string | undefined, invalid: boolean }) => React.ReactNode} props.children
 */
export default function Field({ id, label, hint, error, required = false, className, children }) {
  const generatedId = useId();
  const inputId = id || `${generatedId}-input`;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy = describedByFor(inputId, { hint, error });

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-text">
          {label}
          {required && (
            <span className="text-err ms-1" aria-hidden="true">
              *
            </span>
          )}
        </label>
      )}
      {children({ inputId, describedBy, invalid: Boolean(error) })}
      {error ? (
        <p id={errorId} className="text-xs text-err flex items-center gap-1">
          <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
            error
          </span>
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

Field.propTypes = {
  id: PropTypes.string,
  label: PropTypes.node,
  hint: PropTypes.node,
  error: PropTypes.node,
  required: PropTypes.bool,
  className: PropTypes.string,
  children: PropTypes.func.isRequired,
};
