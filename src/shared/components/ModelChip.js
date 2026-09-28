"use client";

import PropTypes from "prop-types";

/** Mono chip for `prefix/model-id`. */
export default function ModelChip({ model, className }) {
  return (
    <code
      className={`inline-flex max-w-full items-center truncate rounded-md border border-line bg-raised px-2 py-0.5 font-mono text-xs text-muted${className ? ` ${className}` : ""}`}
    >
      {model}
    </code>
  );
}

ModelChip.propTypes = { model: PropTypes.string.isRequired, className: PropTypes.string };
