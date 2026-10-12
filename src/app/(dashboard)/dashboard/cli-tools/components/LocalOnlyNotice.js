"use client";

import PropTypes from "prop-types";
import Callout from "@/shared/components/Callout";
import { useCliAccessStore } from "@/store/cliAccessStore";

/**
 * Shown when the dashboard is not on the host. `manualBelow` adds the pointer
 * to the "Set up manually" flow; only pages that actually render its button
 * should set it.
 */
export default function LocalOnlyNotice({ manualBelow = false }) {
  // YAN-374: a member (no host access) exports config; it is not a remote admin.
  const member = useCliAccessStore((s) => s.noHost);
  if (member) {
    // YAN-374: members export config; applying it needs the host owner/admin.
    return (
      <Callout variant="info" icon="content_copy" title="Copy config for your machine">
        <p>Pick a tool, choose a model, then copy the config and paste it on your own machine.</p>
        {manualBelow && <p>Only an owner or admin can apply settings directly on the host.</p>}
      </Callout>
    );
  }
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
