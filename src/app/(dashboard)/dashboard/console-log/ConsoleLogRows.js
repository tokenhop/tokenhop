"use client";

import { memo, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { terminalLevelClass } from "@/shared/components/displayPrimitives";
import { copyTextToClipboard } from "@/shared/components/formPrimitives";
import { MAX_DETAIL_OCCURRENCES, prettyConsoleMessage } from "@/shared/utils/consoleLog";

/** Copy button for an expanded row, with a polite "Copied" / "Copy failed" announcement. */
function CopyLineButton({ value, label }) {
  const [status, setStatus] = useState(null); // "copied" | "error"
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const onCopy = async () => {
    try {
      await copyTextToClipboard(value);
      setStatus("copied");
    } catch {
      setStatus("error");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(null), 2000);
  };

  return (
    <>
      <button
        type="button"
        aria-label={label}
        onClick={onCopy}
        className="inline-flex size-10 shrink-0 items-center justify-center rounded-md text-[var(--signal-terminal-time)] transition-colors hover:text-[var(--signal-terminal-text)] focus-visible:shadow-focus"
      >
        <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
          {status === "copied" ? "check" : status === "error" ? "error" : "content_copy"}
        </span>
      </button>
      <span aria-live="polite" className="sr-only">
        {status === "copied" ? "Copied" : status === "error" ? "Copy failed" : ""}
      </span>
    </>
  );
}

CopyLineButton.propTypes = {
  value: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
};

/**
 * One console row. The message is a disclosure button (Enter/Space toggle,
 * Up/Down move between rows); the expanded panel shows the full message with
 * pretty-printed JSON (or every raw occurrence) and a copy button.
 */
const ConsoleLogRow = memo(function ConsoleLogRow({
  row,
  index,
  raw,
  expanded,
  selected,
  onToggle,
  onSelect,
  onBlur,
}) {
  // The row key is a unique group key or a monotonic raw id. Hex-encoding the
  // full key is injective; replacing punctuation with '-' could collide.
  const detailId = `console-row-${Array.from(row.key, (char) => char.codePointAt(0).toString(16)).join("-")}`;
  const formatOccurrence = (item) =>
    raw ? item.raw || item.message : prettyConsoleMessage(item.message);
  const allDetailText = row.occurrences.map(formatOccurrence).join("\n\n");
  const omitted = Math.max(0, row.count - MAX_DETAIL_OCCURRENCES * 2);
  const visibleOccurrences = omitted
    ? [
        ...row.occurrences.slice(0, MAX_DETAIL_OCCURRENCES),
        ...row.occurrences.slice(-MAX_DETAIL_OCCURRENCES),
      ]
    : row.occurrences;
  const detailText = omitted
    ? `${visibleOccurrences.slice(0, MAX_DETAIL_OCCURRENCES).map(formatOccurrence).join("\n\n")}\n\n… ${omitted} more occurrences (copy includes all) …\n\n${visibleOccurrences.slice(-MAX_DETAIL_OCCURRENCES).map(formatOccurrence).join("\n\n")}`
    : allDetailText;
  const seen =
    row.count > 1
      ? `Seen ${row.count} times, first at ${row.firstTime || "unknown"}, last at ${row.time || "unknown"}`
      : "";

  const onKeyDown = (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = [
      ...(event.currentTarget.closest("ol")?.querySelectorAll("[data-console-row]") || []),
    ];
    const next = buttons[index + (event.key === "ArrowDown" ? 1 : -1)];
    next?.focus();
  };

  return (
    // content-visibility skips paint/layout for off-screen rows (native, no
    // virtualization dependency); `auto` remembers each row's real height.
    <li
      onBlur={onBlur}
      className="flex gap-4 [content-visibility:auto] [contain-intrinsic-size:auto_23px]"
    >
      <span className="signal-terminal-time shrink-0" title={seen || undefined}>
        {row.time || "--:--:--"}
      </span>
      <span className={`w-[52px] shrink-0 font-semibold ${terminalLevelClass(row.level)}`}>
        {row.level}
      </span>
      <div className="min-w-0 flex-1">
        <button
          data-console-row
          type="button"
          aria-expanded={expanded}
          aria-controls={expanded ? detailId : undefined}
          tabIndex={selected ? 0 : -1}
          onClick={() => onToggle(row.key)}
          onKeyDown={onKeyDown}
          onFocus={() => onSelect(index, row.key)}
          className="flex w-full min-w-0 cursor-pointer items-baseline gap-2 rounded-sm bg-transparent p-0 text-start text-inherit hover:underline focus-visible:shadow-focus"
        >
          {row.source === "browser" && (
            <span className="shrink-0 rounded border border-[var(--signal-terminal-time)] px-1 text-[11px] text-[var(--signal-terminal-time)]">
              browser
            </span>
          )}
          <span className="min-w-0 flex-1 truncate">{row.message}</span>
          {row.count > 1 && (
            <span className="shrink-0 text-[12px] text-[var(--signal-terminal-time)]">
              ×{row.count}
              <span className="sr-only">. {seen}</span>
            </span>
          )}
          <span
            aria-hidden="true"
            className="material-symbols-outlined shrink-0 text-[16px] text-[var(--signal-terminal-time)]"
          >
            {expanded ? "expand_less" : "expand_more"}
          </span>
        </button>
        {expanded && (
          <div
            id={detailId}
            className="mt-1 mb-2 flex items-start gap-2 rounded-lg bg-[var(--signal-terminal-panel)] p-3"
          >
            <pre className="m-0 min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.6]">
              {detailText}
            </pre>
            <CopyLineButton value={allDetailText} label="Copy full line" />
          </div>
        )}
      </div>
    </li>
  );
});

ConsoleLogRow.propTypes = {
  row: PropTypes.shape({
    key: PropTypes.string.isRequired,
    time: PropTypes.string,
    firstTime: PropTypes.string,
    level: PropTypes.string.isRequired,
    source: PropTypes.string,
    message: PropTypes.string.isRequired,
    raw: PropTypes.string,
    count: PropTypes.number.isRequired,
    occurrences: PropTypes.array.isRequired,
  }).isRequired,
  index: PropTypes.number.isRequired,
  raw: PropTypes.bool.isRequired,
  expanded: PropTypes.bool.isRequired,
  selected: PropTypes.bool.isRequired,
  onToggle: PropTypes.func.isRequired,
  onSelect: PropTypes.func.isRequired,
  onBlur: PropTypes.func.isRequired,
};

export default ConsoleLogRow;
