"use client";

import PropTypes from "prop-types";
import { Fragment } from "react";
import { terminalLevelClass } from "./displayPrimitives";

/**
 * Terminal/console surface (dark in both themes) with level-colored lines.
 * Text colors are fixed-light (`.signal-terminal*` classes in globals.css) and
 * the log is always LTR, including in RTL locales. Pass `row` to render a
 * custom expandable row; otherwise plain lines are shown. `live` should be off
 * for a fast stream, polite while paused.
 * @param {{ lines: {time?: string, level: "LOG"|"INFO"|"WARN"|"ERROR"|"DEBUG", message: string}[], label?: string, className?: string, live?: "off"|"polite", onScroll?: (event: object) => void, scrollRef?: { current: object }, cursor?: boolean, row?: (line: object, index: number) => import("react").ReactNode }} props
 */
export default function Terminal({
  lines,
  label = "Console output",
  className,
  live = "off",
  onScroll,
  scrollRef,
  cursor = false,
  row,
}) {
  return (
    <div
      ref={scrollRef}
      role="log"
      aria-label={label}
      aria-live={live}
      dir="ltr"
      onScroll={onScroll}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable log region must be keyboard-focusable (WCAG 2.1.1).
      tabIndex={0}
      className={`signal-terminal custom-scrollbar m-0 overflow-auto rounded-2xl p-[18px_22px] text-start font-mono text-[13px] leading-[1.75] focus-visible:shadow-focus${className ? ` ${className}` : ""}`}
    >
      <ol className="m-0 list-none p-0">
        {row
          ? lines.map((line, index) => (
              <Fragment key={line.id ?? `${line.time}-${index}`}>{row(line, index)}</Fragment>
            ))
          : lines.map((line, index) => (
              <li key={line.id ?? `${line.time}-${index}`} className="flex gap-4 whitespace-nowrap">
                <span className="signal-terminal-time shrink-0">{line.time || "--:--:--"}</span>
                <span
                  className={`w-[52px] shrink-0 font-semibold ${terminalLevelClass(line.level)}`}
                >
                  {line.level}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre">{line.message}</span>
              </li>
            ))}
        {cursor && (
          <li className="mt-0.5 flex gap-4 whitespace-nowrap" aria-hidden="true">
            <span className="signal-terminal-time shrink-0">--:--:--</span>
            <span className="signal-terminal-cursor w-[52px] shrink-0 animate-pulse font-semibold">
              ▍
            </span>
          </li>
        )}
      </ol>
    </div>
  );
}

Terminal.propTypes = {
  lines: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
      time: PropTypes.string,
      level: PropTypes.oneOf(["LOG", "INFO", "WARN", "ERROR", "DEBUG"]).isRequired,
      message: PropTypes.string.isRequired,
    }),
  ).isRequired,
  label: PropTypes.string,
  className: PropTypes.string,
  live: PropTypes.oneOf(["off", "polite"]),
  onScroll: PropTypes.func,
  scrollRef: PropTypes.shape({ current: PropTypes.object }),
  cursor: PropTypes.bool,
  row: PropTypes.func,
};
