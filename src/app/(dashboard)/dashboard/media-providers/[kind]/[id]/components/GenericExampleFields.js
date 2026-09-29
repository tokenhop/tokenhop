"use client";

import PropTypes from "prop-types";
import { IconButton } from "@/shared/components";
import { Row, controlClass } from "./exampleShared";

/**
 * Field controls for `GenericExampleForm` (YAN-402): `ImageUrlField`
 * (image URL with clear button + preview, dedupes the Ref/Mask rows) and
 * `ExtraFieldControl` (dynamic select/text/number rows).
 */

/**
 * Single image URL field with clear button and preview (YAN-402). Dedupes
 * the near-identical Ref image / Mask blocks of the original card.
 */
export function ImageUrlField({
  label,
  value,
  onChange,
  placeholder,
  previewSrc,
  clearLabel,
  alt,
}) {
  return (
    <Row label={label}>
      <div className="flex flex-col gap-2">
        <div className="relative">
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            aria-label={label}
            className={`${controlClass} pe-11`}
            dir="ltr"
          />
          {value && (
            <IconButton
              icon="close"
              label={clearLabel}
              onClick={() => onChange("")}
              className="absolute end-1 top-1/2 size-9 -translate-y-1/2 border-0 bg-transparent"
            />
          )}
        </div>
        {previewSrc && (
          <img
            src={previewSrc}
            alt={alt}
            className="max-h-40 rounded-xl border border-line bg-raised object-contain"
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
            onLoad={(e) => {
              e.currentTarget.style.display = "block";
            }}
            loading="lazy"
            decoding="async"
          />
        )}
      </div>
    </Row>
  );
}

ImageUrlField.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.string,
  onChange: PropTypes.func.isRequired,
  placeholder: PropTypes.string,
  previewSrc: PropTypes.string,
  clearLabel: PropTypes.string.isRequired,
  alt: PropTypes.string.isRequired,
};

/** One dynamic extra field row (select / text / number). */
export function ExtraFieldControl({ field, value, onChange }) {
  const ariaLabel = field.label;
  if (field.type === "select") {
    return (
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        className={controlClass}
      >
        {(field.options || []).map((opt) => (
          <option key={opt} value={opt}>
            {opt === "" ? "(default)" : opt}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === "text") {
    return (
      <input
        type="text"
        value={value ?? ""}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        className={controlClass}
      />
    );
  }
  return (
    <input
      type="number"
      value={value ?? ""}
      min={field.min}
      max={field.max}
      onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
      aria-label={ariaLabel}
      className={controlClass}
    />
  );
}

ExtraFieldControl.propTypes = {
  field: PropTypes.object.isRequired,
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  onChange: PropTypes.func.isRequired,
};
