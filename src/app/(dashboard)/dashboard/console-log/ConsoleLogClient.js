"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import Link from "next/link";
import {
  Button,
  Callout,
  EmptyState,
  SegmentedControl,
  SkeletonText,
  StatusPill,
  Terminal,
  Toggle,
  ToolbarSearch,
} from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config";
import {
  autoScrollReducer,
  connectionBadge,
  countConsoleLevels,
  filterConsoleLines,
  groupConsoleLines,
  initialAutoScrollState,
  pruneExpandedKeys,
} from "@/shared/utils/consoleLog";
import ConsoleLogRow from "./ConsoleLogRows";
import useConsoleStream from "./useConsoleStream";

const MAX_LINES = CONSOLE_LOG_CONFIG.maxLines;
const LEVEL_OPTIONS = ["ALL", "INFO", "WARN", "ERROR", "DEBUG"];
const SCROLL_THRESHOLD_PX = 48;

/**
 * Signal Console log page: an honest SSE connection badge, repeat-grouped
 * keyboard-expandable rows, browser-noise filter, text + level filters with
 * counts, pause/resume buffering and auto-scroll.
 */
export default function ConsoleLogClient() {
  const notify = useNotificationStore((state) => state.error);
  const {
    buffer,
    connection,
    dispatchBuffer,
    loadError,
    connectionFailed,
    loading,
    hasSnapshot,
    reconnect,
  } = useConsoleStream();
  const [autoScroll, dispatchAutoScroll] = useReducer(autoScrollReducer, initialAutoScrollState);
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState("ALL");
  const [raw, setRaw] = useState(false);
  const [hideBrowser, setHideBrowser] = useState(false);
  const [expandedKeys, setExpandedKeys] = useState(() => new Set());
  const [activeKey, setActiveKey] = useState(null);
  const scrollRef = useRef(null);
  // Key of the row button that held focus, set only while it is focused.
  const focusedRowKey = useRef(null);

  const paused = buffer.paused;
  const lines = buffer.visible;
  const grouped = useMemo(() => groupConsoleLines(lines), [lines]);
  // Raw rows keep independent disclosure keys (their line id); grouped rows use
  // the group key. Both survive filters and mode switches via pruneExpandedKeys.
  const rawRows = useMemo(
    () => lines.map((line) => ({ ...line, key: String(line.id), count: 1, occurrences: [line] })),
    [lines],
  );
  const rows = useMemo(
    () => filterConsoleLines(raw ? rawRows : grouped, { query, level, hideBrowser }),
    [raw, rawRows, grouped, query, level, hideBrowser],
  );
  const counts = useMemo(() => countConsoleLevels(lines), [lines]);
  const warnCount = counts.WARN;
  const errorCount = counts.ERROR;
  const browserCount = useMemo(
    () => lines.filter((line) => line.source === "browser").length,
    [lines],
  );
  const badge = connectionBadge(connection, { paused, newCount: buffer.newCount });
  const connected = connection.status === "open";
  // Only surface the disconnected callout after a real error/close, never on
  // first load: badge says Connecting until the stream has failed at least once.
  const streamError =
    !connected && lines.length === 0 && connectionFailed && (loadError || !loading);

  // Roving tabindex follows a row key, not an index, so a group reordered by
  // a repeat keeps its tab stop.
  const activeIndex = Math.max(
    0,
    rows.findIndex((row) => row.key === activeKey),
  );

  useEffect(() => {
    if (rows.length > 0 && !rows.some((row) => row.key === activeKey)) {
      setActiveKey(rows[rows.length - 1].key);
    }
  }, [rows, activeKey]);

  // Keep disclosures expanded through filtering and Raw toggles; prune only
  // keys whose lines left the 200-line buffer. Grouped and raw keys are
  // independent, so each mode restores its own expansion when revisited.
  useEffect(() => {
    setExpandedKeys((keys) => pruneExpandedKeys(keys, grouped));
  }, [grouped]);

  // Restore focus to the same group key after reorder: when a repeat moves the
  // focused row to the bottom, React moves its DOM node and focus can fall to
  // body; put it back on that row so keyboard users keep their place. If the
  // row is gone (filtered out or rotated), focus the filter instead. Group
  // keys contain \u0000 separators, which CSS.escape maps to U+FFFD and would
  // break the selector, so compare attributes directly.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `rows` is the trigger; the effect reads the DOM.
  useEffect(() => {
    if (
      focusedRowKey.current &&
      (document.activeElement === document.body || !document.activeElement)
    ) {
      const target = [...(scrollRef.current?.querySelectorAll("[data-console-key]") ?? [])].find(
        (element) => element.getAttribute("data-console-key") === focusedRowKey.current,
      );
      if (target) target.focus();
      else {
        focusedRowKey.current = null;
        document.getElementById("console-log-filter")?.focus();
      }
    }
  }, [rows]);

  const handleScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= SCROLL_THRESHOLD_PX;
    dispatchAutoScroll({ type: "scroll", atBottom });
  }, []);

  // Stick to the bottom on new rows when auto-scroll is on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `rows` is the trigger; its length stalls at the 200-line cap.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !autoScroll.enabled) return;
    node.scrollTop = node.scrollHeight;
  }, [rows, autoScroll.enabled]);

  const handleClear = useCallback(async () => {
    try {
      const res = await fetch("/api/translator/console-logs", { method: "DELETE" });
      if (!res.ok) {
        notify("Could not clear the console log. Try again.", "Clear failed");
        return;
      }
      // Clearing is optimistic: the SSE "clear" broadcast confirms it, and
      // this keeps the UI correct if the stream is momentarily down.
      dispatchBuffer({ type: "clear" });
    } catch {
      notify("Could not clear the console log. Try again.", "Clear failed");
    }
  }, [notify, dispatchBuffer]);

  const toggleExpanded = useCallback((key) => {
    setExpandedKeys((keys) => {
      const next = new Set(keys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectRow = useCallback((key) => {
    focusedRowKey.current = key;
    setActiveKey(key);
  }, []);

  const clearRowFocus = useCallback((event) => {
    // Keep the key while focus moves inside the row (e.g. to its copy button).
    if (!event.currentTarget.contains(event.relatedTarget)) focusedRowKey.current = null;
  }, []);

  const options = useMemo(
    () =>
      LEVEL_OPTIONS.map((value) => ({
        value,
        label: value === "ALL" ? "All" : value.charAt(0) + value.slice(1).toLowerCase(),
        count: value === "ALL" ? lines.length : counts[value],
      })),
    [lines.length, counts],
  );

  const body = (() => {
    if (loading && !hasSnapshot) {
      return (
        <div className="signal-terminal rounded-2xl p-[18px_22px]">
          <span className="sr-only" role="status">
            Loading console history
          </span>
          <SkeletonText lines={8} />
        </div>
      );
    }
    if (streamError) {
      return (
        <Callout variant="err" title="Log stream disconnected">
          <p>{loadError || "Could not connect to the log stream."}</p>
          <Button size="sm" variant="secondary" icon="refresh" onClick={reconnect} className="mt-3">
            Reconnect
          </Button>
        </Callout>
      );
    }
    if (rows.length === 0) {
      return (
        <div className="signal-terminal flex min-h-[320px] items-center justify-center rounded-2xl">
          <EmptyState
            icon="terminal"
            title={lines.length === 0 ? "No console logs yet" : "No lines match the filters"}
            body={
              lines.length === 0
                ? "Server output will appear here once the gateway starts logging."
                : "Try a different search term or log level."
            }
            className="[&_h3]:text-[var(--signal-terminal-text)] [&_p]:text-[var(--signal-terminal-time)]"
          />
        </div>
      );
    }
    return (
      <Terminal
        lines={rows}
        scrollRef={scrollRef}
        onScroll={handleScroll}
        live={paused ? "polite" : "off"}
        label="Console output"
        cursor={connected && !paused}
        className="h-[min(60vh,720px)] min-h-[320px]"
        row={(row, index) => (
          <ConsoleLogRow
            row={row}
            index={index}
            raw={raw}
            expanded={expandedKeys.has(row.key)}
            selected={index === activeIndex}
            onSelect={selectRow}
            onBlur={clearRowFocus}
            onToggle={toggleExpanded}
          />
        )}
      />
    );
  })();

  return (
    <div className="flex flex-col gap-5">
      {/* Header row: subtitle is in the shell Header; actions live here */}
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill variant={badge.variant} dot>
          {badge.label}
        </StatusPill>
        <span className="sr-only" role="status">
          {badge.announcement}
        </span>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon={paused ? "play_arrow" : "pause"}
            onClick={() =>
              dispatchBuffer(paused ? { type: "resume", maxLines: MAX_LINES } : { type: "pause" })
            }
          >
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button size="sm" variant="ghost" icon="delete" onClick={handleClear}>
            Clear
          </Button>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-[200px] flex-1 sm:max-w-[440px]">
          <ToolbarSearch
            id="console-log-filter"
            ariaLabel="Filter lines"
            placeholder="Filter by model, provider or status"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <span className="sr-only">Counts show lines, not grouped rows</span>
        <SegmentedControl
          aria-label="Log level"
          options={options}
          value={level}
          onChange={setLevel}
        />
        <Toggle
          label={`Hide browser lines${browserCount > 0 ? ` (${browserCount})` : ""}`}
          checked={hideBrowser}
          onChange={setHideBrowser}
        />
        <Toggle
          label="Raw lines"
          description="Show every line; no ×N grouping"
          checked={raw}
          onChange={setRaw}
        />
        <div className="ms-auto">
          <Toggle
            label="Auto-scroll"
            checked={autoScroll.enabled}
            onChange={() => dispatchAutoScroll({ type: "toggle" })}
          />
        </div>
      </div>

      {/* Terminal surface */}
      {body}

      {/* Footer */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-muted">
        <span>
          {rows.length} {raw ? "rows" : "groups"} · {lines.length} of {MAX_LINES} lines
        </span>
        <span className="text-warn">{warnCount} warnings</span>
        <button
          type="button"
          onClick={() => setLevel(errorCount > 0 && level !== "ERROR" ? "ERROR" : "ALL")}
          aria-pressed={level === "ERROR"}
          className="rounded-sm text-err underline-offset-2 hover:underline focus-visible:shadow-focus"
        >
          {errorCount} {errorCount === 1 ? "error" : "errors"}
        </button>
        <span className="ms-auto">
          Tip: turn on request details in{" "}
          <Link href="/dashboard/settings#logs" className="font-semibold text-coral-ink">
            Settings → Observability
          </Link>{" "}
          to see full payloads in Usage.
        </span>
      </div>
    </div>
  );
}
