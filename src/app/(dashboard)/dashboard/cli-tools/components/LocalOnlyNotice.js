"use client";

import Callout from "@/shared/components/Callout";

/** Shown instead of CLI-tool controls when the dashboard is not on the host. */
export default function LocalOnlyNotice() {
  return (
    <Callout variant="warn" icon="lock" title="CLI tools require local access">
      Open the dashboard on the host (localhost) to manage them. Manual configuration for each tool
      is below.
    </Callout>
  );
}
