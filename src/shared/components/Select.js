"use client";

import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";
import Field from "./Field";

/**
 * Group an options array by each option's `group` in first-seen order.
 * Options without `group` share the ungrouped run. Pure, so callers can unit
 * test grouping without rendering.
 * @param {Array<{ group?: string }>} options
 * @returns {Array<{ label: string|null, options: Array }>}
 */
export function groupSelectOptions(options) {
  const groups = [];
  const groupByKey = new Map();
  for (const option of options) {
    const key = option.group || null;
    if (!groupByKey.has(key)) {
      const group = { label: key, options: [] };
      groupByKey.set(key, group);
      groups.push(group);
    }
    groupByKey.get(key).options.push(option);
  }
  return groups;
}

/**
 * Signal styled native select wired to a Field. By default renders a disabled
 * empty placeholder option first (existing contract: callers rely on it when
 * the value isn't in `options`). Pass `placeholder={null}` to omit that
 * option, so a real option with `value: ""` (e.g. "All providers") stays
 * selectable.
 *
 * Options may carry an optional `group` string; options sharing a group render
 * inside one `<optgroup label={group}>` in first-seen order. Grouping is
 * additive — options without `group` render exactly as before.
 *
 * @param {object} props
 * @param {string|null} [props.placeholder="Select an option"] `null` omits the
 *   disabled placeholder option.
 * @param {Array<{ value: string|number, label: React.ReactNode, group?: string }>} [props.options]
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
            {placeholder !== null && (
              <option value="" disabled>
                {placeholder}
              </option>
            )}
            {groupSelectOptions(options).map((group, index) =>
              group.label === null ? (
                group.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))
              ) : (
                <optgroup key={group.label || index} label={group.label}>
                  {group.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ),
            )}
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
      group: PropTypes.string,
    }),
  ),
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  onChange: PropTypes.func,
  // null omits the disabled placeholder option (see JSDoc).
  placeholder: PropTypes.oneOfType([PropTypes.string, PropTypes.oneOf([null])]),
  error: PropTypes.node,
  hint: PropTypes.node,
  disabled: PropTypes.bool,
  required: PropTypes.bool,
  className: PropTypes.string,
  selectClassName: PropTypes.string,
  id: PropTypes.string,
};
