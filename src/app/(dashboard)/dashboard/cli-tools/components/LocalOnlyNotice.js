"use client";

import PropTypes from "prop-types";
import Callout from "@/shared/components/Callout";

/**
 * Shown when the dashboard is not on the host. `manualBelow` adds the pointer
 * to the "Set up manually" flow; only pages that actually render its button
 * should set it.
 */
export default function LocalOnlyNotice({ manualBelow = false }) {
  return (
    <Callout variant="warn" icon="lock" title="CLI tools require local access">
      <p>Open the dashboard on the host (localhost) to manage them.</p>
      {manualBelow && (
        <p>Each tool has a button to copy its configuration and set it up by hand.</p>
      )}
    </Callout>
  );
}

LocalOnlyNotice.propTypes = {
  manualBelow: PropTypes.bool,
};
