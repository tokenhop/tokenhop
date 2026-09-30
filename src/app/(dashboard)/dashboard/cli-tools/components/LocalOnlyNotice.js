"use client";

import PropTypes from "prop-types";
import Callout from "@/shared/components/Callout";

/**
 * Shown when the dashboard is not on the host. `manualBelow` adds the pointer
 * to inline manual steps; only pages that actually render them should set it.
 */
export default function LocalOnlyNotice({ manualBelow = false }) {
  return (
    <Callout variant="warn" icon="lock" title="CLI tools require local access">
      <p>Open the dashboard on the host (localhost) to manage them.</p>
      {manualBelow && <p>Manual configuration for each tool is below.</p>}
    </Callout>
  );
}

LocalOnlyNotice.propTypes = {
  manualBelow: PropTypes.bool,
};
