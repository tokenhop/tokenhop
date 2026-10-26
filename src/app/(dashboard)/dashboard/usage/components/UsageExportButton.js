"use client";

import PropTypes from "prop-types";
import { Button, Menu, MenuItem } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import { appendUsageFilters } from "../lib/filterParams";
import { periodQuery } from "../lib/periodRequest";

/**
 * Export control for the Usage Overview (YAN-425): downloads the current
 * period (including a custom range) and the active usage filters as CSV or
 * JSON, at daily or per-request granularity.
 *
 * Download approach — the page must never be replaced by a raw error body,
 * and a large export must not be buffered whole in the browser: first a
 * lightweight `fetch` preflight reads only the response headers. On
 * 4xx/5xx it shows an accessible toast via the notification store and never
 * navigates (the JSON error body is read for the message). On success the
 * preflight body is cancelled and the real download goes through
 * `<a download href>`: the server's `Content-Disposition: attachment` plus
 * the `download` attribute save it to disk (streamed by the browser), and
 * even a late server error on that second request downloads as a file
 * rather than replacing the page. Filename is server-chosen.
 */
export default function UsageExportButton({ period, range, filters }) {
  const notifyError = useNotificationStore((s) => s.error);
  if (!period) return null;
  const url = (format, granularity) =>
    appendUsageFilters(
      `/api/usage/export?${periodQuery(period, range)}&format=${format}&granularity=${granularity}`,
      filters,
    );

  const download = async (format, granularity) => {
    const target = url(format, granularity);
    let res;
    try {
      res = await fetch(target, { cache: "no-store" });
    } catch {
      notifyError("Export failed. Check your connection and try again.", {
        title: "Usage export",
      });
      return;
    }
    if (!res.ok) {
      let message = `Export failed (${res.status}).`;
      try {
        const body = await res.json();
        if (typeof body?.error === "string" && body.error) message = body.error;
      } catch {
        // Non-JSON error body: keep the status message.
      }
      notifyError(message, { title: "Usage export" });
      return;
    }
    // Success: discard the preflight body — the anchor download re-requests
    // and streams to disk without holding the export in memory.
    try {
      await res.body?.cancel();
    } catch {}
    const a = document.createElement("a");
    a.href = target;
    a.download = "";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <Menu
      trigger={
        <Button variant="secondary" size="sm" icon="download" iconRight="expand_more">
          Export
        </Button>
      }
    >
      <MenuItem
        icon="table_rows"
        label="CSV, daily totals"
        onSelect={() => void download("csv", "day")}
      >
        CSV, daily totals
      </MenuItem>
      <MenuItem
        icon="data_object"
        label="JSON, daily totals"
        onSelect={() => void download("json", "day")}
      >
        JSON, daily totals
      </MenuItem>
      <MenuItem
        icon="table_rows"
        label="CSV, per request"
        onSelect={() => void download("csv", "request")}
      >
        CSV, per request
      </MenuItem>
      <MenuItem
        icon="data_object"
        label="JSON, per request"
        onSelect={() => void download("json", "request")}
      >
        JSON, per request
      </MenuItem>
    </Menu>
  );
}

UsageExportButton.propTypes = {
  period: PropTypes.string,
  range: PropTypes.shape({ from: PropTypes.string, to: PropTypes.string }),
  filters: PropTypes.shape({
    workspaceId: PropTypes.string,
    view: PropTypes.string,
    userId: PropTypes.string,
    apiKeyId: PropTypes.string,
  }),
};
