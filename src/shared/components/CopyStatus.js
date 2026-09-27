"use client";

import PropTypes from "prop-types";

/** Polite screen-reader announcement for useCopyToClipboard results. */
export default function CopyStatus({ copied, error, id }) {
  const matches = (value) => value != null && (id === undefined || value === id);
  return (
    <span aria-live="polite" className="sr-only">
      {matches(error) ? "Couldn't copy" : matches(copied) ? "Copied" : ""}
    </span>
  );
}

CopyStatus.propTypes = {
  copied: PropTypes.string,
  error: PropTypes.string,
  id: PropTypes.string,
};
