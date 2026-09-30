"use client";

import PropTypes from "prop-types";
import Link from "next/link";
import { useCallback } from "react";
import StatusPill from "@/shared/components/StatusPill";
import ToolTile from "./ToolTile";
import { deriveToolStatus } from "../lib/toolStatus";

/**
 * One tool tile in the CLI-tools grid: brand monogram, name and a status
 * pill from real detection. Behaves as a link to the tool's full page, but
 * on wide screens (where the setup panel sits beside the grid) a plain
 * left-click selects the tool in place instead of navigating — middle-click,
 * cmd-click and the context menu still open the full page.
 *
 * @param {object} props
 * @param {string} props.toolId CLI_TOOLS key.
 * @param {object} props.tool CLI_TOOLS entry.
 * @param {object} [props.status] Detection payload from /api/cli-tools/all-statuses.
 * @param {boolean} [props.selected] Coral selected ring.
 * @param {(toolId: string) => void} [props.onSelect] In-place selection (wide screens).
 */
export default function ToolGridCard({
  toolId,
  tool,
  status,
  remote = false,
  selected = false,
  onSelect,
}) {
  const derived = deriveToolStatus(tool, status, { remote });

  const handleClick = useCallback(
    (event) => {
      if (!onSelect) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return;
      if (window.matchMedia("(min-width: 1280px)").matches) {
        event.preventDefault();
        onSelect(toolId);
      }
    },
    [onSelect, toolId],
  );

  return (
    <Link
      href={`/dashboard/cli-tools/${toolId}`}
      onClick={handleClick}
      aria-current={selected ? "true" : undefined}
      aria-label={`${tool.name} — ${derived.label}`}
      className={`group flex min-h-11 items-center gap-3 rounded-2xl border bg-panel p-3 text-start shadow-card transition-colors duration-150 focus-visible:outline-none focus-visible:shadow-focus motion-reduce:transition-none ${
        selected
          ? "border-coral shadow-[0_0_0_3px_var(--signal-coral-bg)]"
          : "border-line hover:border-subtle"
      }`}
    >
      <ToolTile tool={tool} size="md" />
      <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <span className="w-full truncate text-sm font-semibold text-text">{tool.name}</span>
        <StatusPill variant={derived.variant} size="sm">
          {derived.label}
        </StatusPill>
      </span>
      <span
        className="material-symbols-outlined shrink-0 text-[18px] text-subtle transition-colors group-hover:text-text rtl:rotate-180"
        aria-hidden="true"
      >
        chevron_right
      </span>
    </Link>
  );
}

ToolGridCard.propTypes = {
  toolId: PropTypes.string.isRequired,
  tool: PropTypes.shape({
    name: PropTypes.string.isRequired,
    color: PropTypes.string,
    configType: PropTypes.string,
    image: PropTypes.string,
  }).isRequired,
  status: PropTypes.shape({
    installed: PropTypes.bool,
    has9Router: PropTypes.bool,
  }),
  remote: PropTypes.bool,
  selected: PropTypes.bool,
  onSelect: PropTypes.func,
};
