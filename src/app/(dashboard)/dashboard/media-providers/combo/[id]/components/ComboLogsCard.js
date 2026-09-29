"use client";

import PropTypes from "prop-types";
import { Card, EmptyState } from "@/shared/components";

/** Request lines mentioning the combo name (newest 50, textual rendering). */
export default function ComboLogsCard({ logs }) {
  return (
    <Card>
      <h2 className="mb-3 text-lg font-semibold">Usage logs</h2>
      {logs.length === 0 ? (
        <EmptyState compact icon="receipt_long" title="No usage yet." as="p" />
      ) : (
        <pre className="max-h-[400px] overflow-auto whitespace-pre-wrap rounded-lg bg-raised p-3 font-mono text-[11px]">
          {logs.join("\n")}
        </pre>
      )}
    </Card>
  );
}

ComboLogsCard.propTypes = {
  logs: PropTypes.arrayOf(PropTypes.string).isRequired,
};
