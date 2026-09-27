import { describe, expect, it } from "vitest";
import {
  appendConsoleLines,
  autoScrollReducer,
  countConsoleLevels,
  filterConsoleLines,
  groupConsoleLines,
  stripConsolePrefix,
  prettyConsoleMessage,
  retryDelayMs,
  connectionBadge,
  connectionReducer,
  initialConnectionState,
  snapshotOverlap,
  initialAutoScrollState,
  initialConsoleBufferState,
  parseConsoleLine,
  pauseBufferReducer,
  tagConsoleLines,
} from "../../src/shared/utils/consoleLog.js";

const LINES = [
  { time: "14:07:10", level: "INFO", message: "POST /v1/chat/completions model=coder" },
  { time: "14:07:19", level: "WARN", message: "gc/gemini 429 rate_limited cooling down" },
  { time: "14:07:31", level: "ERROR", message: "kimi: token refresh failed 401" },
  { time: "14:07:41", level: "DEBUG", message: "caveman(full): output 1204 → 431 tokens" },
  { time: "14:08:20", level: "INFO", message: "← 200 cc/claude-sonnet in=9810 out=1022" },
];

describe("parseConsoleLine", () => {
  it("parses timestamp, level and message", () => {
    expect(parseConsoleLine("[14:07:19] [WARN] cooling down")).toEqual({
      time: "14:07:19",
      level: "WARN",
      message: "cooling down",
      raw: "[14:07:19] [WARN] cooling down",
      source: "server",
    });
  });

  it("maps request-logger emoji to levels", () => {
    expect(parseConsoleLine("[14:07:19] ⚠️ [gc] 429 cooling down")).toMatchObject({
      time: "14:07:19",
      level: "WARN",
      message: "[gc] 429 cooling down",
    });
    expect(parseConsoleLine("[14:07:31] ❌ [kimi] refresh failed")).toMatchObject({
      level: "ERROR",
    });
    expect(parseConsoleLine("[14:07:41] 🔍 [rtk] compressed")).toMatchObject({ level: "DEBUG" });
    expect(parseConsoleLine("[14:07:10] ℹ️ [api] POST /v1/chat")).toMatchObject({ level: "INFO" });
  });

  it("falls back to LOG for unknown levels and plain lines", () => {
    expect(parseConsoleLine("Server listening on :20128")).toEqual({
      time: "",
      level: "LOG",
      message: "Server listening on :20128",
      raw: "Server listening on :20128",
      source: "server",
    });
    expect(parseConsoleLine("[oops] something odd")).toMatchObject({
      time: "",
      level: "LOG",
      message: "[oops] something odd",
    });
    expect(parseConsoleLine("[DB] Driver: node:sqlite")).toMatchObject({
      level: "LOG",
      message: "[DB] Driver: node:sqlite",
    });
  });

  it("throws on non-string input", () => {
    expect(() => parseConsoleLine(null)).toThrow();
  });
});

describe("filterConsoleLines", () => {
  it("matches message text case-insensitively", () => {
    expect(filterConsoleLines(LINES, { query: "GEMINI", level: "ALL" })).toHaveLength(1);
    expect(filterConsoleLines(LINES, { query: "200", level: "ALL" })).toHaveLength(1);
  });

  it("filters by level", () => {
    expect(filterConsoleLines(LINES, { query: "", level: "INFO" })).toHaveLength(2);
    expect(filterConsoleLines(LINES, { query: "", level: "ERROR" })).toHaveLength(1);
  });

  it("combines text and level filters", () => {
    expect(filterConsoleLines(LINES, { query: "post", level: "INFO" })).toHaveLength(1);
    expect(filterConsoleLines(LINES, { query: "post", level: "WARN" })).toHaveLength(0);
  });

  it("returns everything for empty query and ALL", () => {
    expect(filterConsoleLines(LINES, { query: "  ", level: "ALL" })).toHaveLength(5);
  });
});

describe("countConsoleLevels", () => {
  it("counts per level", () => {
    expect(countConsoleLevels(LINES)).toEqual({ LOG: 0, INFO: 2, WARN: 1, ERROR: 1, DEBUG: 1 });
  });

  it("counts empty input as zeros", () => {
    expect(countConsoleLevels([])).toEqual({ LOG: 0, INFO: 0, WARN: 0, ERROR: 0, DEBUG: 0 });
  });
});

describe("pauseBufferReducer", () => {
  it("appends while live", () => {
    const state = pauseBufferReducer(initialConsoleBufferState, {
      type: "append",
      lines: [LINES[0]],
      maxLines: 200,
    });
    expect(state.visible).toHaveLength(1);
    expect(state.pending).toHaveLength(0);
    expect(state.newCount).toBe(0);
  });

  it("buffers while paused and shows new count", () => {
    let state = pauseBufferReducer(initialConsoleBufferState, { type: "pause" });
    state = pauseBufferReducer(state, {
      type: "append",
      lines: [LINES[0], LINES[1]],
      maxLines: 200,
    });
    expect(state.visible).toHaveLength(0);
    expect(state.pending).toHaveLength(2);
    expect(state.newCount).toBe(2);
    expect(state.paused).toBe(true);
  });

  it("flushes pending on resume with the 200-line cap", () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ ...LINES[0], message: `m${i}` }));
    let state = pauseBufferReducer(initialConsoleBufferState, { type: "pause" });
    state = pauseBufferReducer(state, { type: "append", lines: many, maxLines: 200 });
    state = pauseBufferReducer(state, { type: "resume", maxLines: 200 });
    expect(state.paused).toBe(false);
    expect(state.pending).toHaveLength(0);
    expect(state.newCount).toBe(0);
    expect(state.visible).toHaveLength(200);
    expect(state.visible[0].message).toBe("m50");
  });

  it("clears visible and pending", () => {
    let state = pauseBufferReducer(initialConsoleBufferState, { type: "pause" });
    state = pauseBufferReducer(state, {
      type: "append",
      lines: [LINES[0]],
      maxLines: 200,
    });
    state = pauseBufferReducer(state, { type: "clear" });
    expect(state.visible).toHaveLength(0);
    expect(state.pending).toHaveLength(0);
    expect(state.newCount).toBe(0);
  });

  it("keeps stable row ids for unchanged rows across a cap append", () => {
    const seed = Array.from({ length: 200 }, (_, i) => ({ ...LINES[0], message: `v${i}` }));
    let state = pauseBufferReducer(initialConsoleBufferState, {
      type: "append",
      lines: seed,
      maxLines: 200,
    });
    const before = state.visible;
    const kept = before.slice(10);
    const keptIds = kept.map((line) => line.id);
    expect(new Set(keptIds).size).toBe(190);

    state = pauseBufferReducer(state, {
      type: "append",
      lines: Array.from({ length: 10 }, (_, i) => ({ ...LINES[0], message: `n${i}` })),
      maxLines: 200,
    });
    expect(state.visible).toHaveLength(200);
    // Surviving rows keep both object identity and id; only the 10 head
    // rows dropped and 10 new rows took fresh ids.
    expect(state.visible.slice(0, 190)).toEqual(kept);
    expect(state.visible.slice(0, 190).map((line) => line.id)).toEqual(keptIds);
    expect(state.visible.slice(0, 190).every((line, i) => line === kept[i])).toBe(true);
  });

  it("throws on unknown actions", () => {
    expect(() => pauseBufferReducer(initialConsoleBufferState, { type: "nope" })).toThrow();
    expect(() =>
      pauseBufferReducer(initialConsoleBufferState, { type: "append", lines: [] }),
    ).toThrow();
  });
});

describe("tagConsoleLines", () => {
  it("assigns stable ids to duplicates and advances nextId", () => {
    const { lines, nextId } = tagConsoleLines([LINES[0], LINES[0]], 5);
    expect(lines.map((line) => line.id)).toEqual([5, 6]);
    expect(nextId).toBe(7);
    expect(lines[0]).not.toBe(LINES[0]);
  });

  it("throws on bad input", () => {
    expect(() => tagConsoleLines(null, 0)).toThrow();
    expect(() => tagConsoleLines([], -1)).toThrow();
  });
});

describe("appendConsoleLines", () => {
  it("caps at 200 lines keeping the newest", () => {
    const visible = Array.from({ length: 199 }, (_, i) => ({ ...LINES[0], message: `v${i}` }));
    const next = appendConsoleLines(visible, [{ ...LINES[0], message: "new" }], 200);
    expect(next).toHaveLength(200);
    expect(next[199].message).toBe("new");
  });
});

describe("autoScrollReducer", () => {
  it("starts enabled", () => {
    expect(initialAutoScrollState).toEqual({ enabled: true });
  });

  it("disables on user scroll-up, enables near bottom or toggle", () => {
    let state = autoScrollReducer(initialAutoScrollState, { type: "scroll", atBottom: false });
    expect(state.enabled).toBe(false);
    state = autoScrollReducer(state, { type: "scroll", atBottom: true });
    expect(state.enabled).toBe(true);
    state = autoScrollReducer(state, { type: "toggle" });
    expect(state.enabled).toBe(false);
    state = autoScrollReducer(state, { type: "toggle" });
    expect(state.enabled).toBe(true);
  });

  it("throws on unknown actions", () => {
    expect(() => autoScrollReducer(initialAutoScrollState, { type: "nope" })).toThrow();
  });
});

describe("console polish", () => {
  it("strips only leading status glyphs and separates browser source", () => {
    expect(stripConsolePrefix("ℹ️  [TOKEN_REFRESH] Ready ❌")).toBe("[TOKEN_REFRESH] Ready ❌");
    expect(stripConsolePrefix("❌ [browser] Failed")).toBe("[browser] Failed");
    expect(parseConsoleLine("[14:07:31] ❌ [TOKEN_REFRESH] Failed")).toMatchObject({
      level: "ERROR",
      message: "[TOKEN_REFRESH] Failed",
      source: "server",
    });
    expect(parseConsoleLine("[browser] React Flow warning")).toMatchObject({
      source: "browser",
      message: "React Flow warning",
    });
    expect(parseConsoleLine("[14:07:31] [ERROR] ❌ [browser] Failed")).toMatchObject({
      level: "ERROR",
      source: "browser",
      message: "Failed",
    });
  });

  it("groups recurring level + normalized text, preserving raw lines and last seen time", () => {
    const lines = [
      {
        id: 1,
        level: "ERROR",
        time: "14:01:00",
        message: '[TOKEN_REFRESH] id=abc123 time=2026-09-27T14:01:00Z failed {"status":400}',
      },
      { id: 2, level: "INFO", time: "14:02:00", message: "unrelated" },
      {
        id: 3,
        level: "ERROR",
        time: "14:06:00",
        message: '[TOKEN_REFRESH] id=def456 time=2026-09-27T14:06:00Z failed {"status":400}',
      },
      {
        id: 4,
        level: "WARN",
        time: "14:07:00",
        message: '[TOKEN_REFRESH] id=def456 time=2026-09-27T14:06:00Z failed {"status":400}',
      },
    ];
    const grouped = groupConsoleLines(lines);
    expect(grouped).toHaveLength(3);
    expect(grouped[1]).toMatchObject({ id: 3, count: 2, firstTime: "14:01:00", time: "14:06:00" });
    expect(grouped[1].occurrences).toEqual([lines[0], lines[2]]);
    expect(grouped[2].count).toBe(1);
    expect(filterConsoleLines(grouped, { query: "abc123" })).toEqual([grouped[1]]);
  });

  it("filters browser lines while keeping count and raw view available", () => {
    const lines = [parseConsoleLine("[browser] warning"), parseConsoleLine("[server] ready")];
    expect(filterConsoleLines(lines, { hideBrowser: true })).toEqual([lines[1]]);
    expect(filterConsoleLines(lines)).toEqual(lines);
  });

  it("pretty prints trailing JSON while preserving source tags, or falls back to raw text", () => {
    expect(
      prettyConsoleMessage('[TOKEN_REFRESH] failed {"status":400,"detail":{"retry":false}}'),
    ).toContain('\n  "detail": {');
    expect(prettyConsoleMessage("failed {broken")).toBe("failed {broken");
  });

  it("computes snapshot overlap and buffers only missed lines while paused", () => {
    const rows = ["a", "b", "c"].map((raw) => ({ ...LINES[0], raw, message: raw }));
    expect(snapshotOverlap(rows.slice(0, 2), rows.slice(1))).toBe(1);
    let state = pauseBufferReducer(initialConsoleBufferState, {
      type: "append",
      lines: rows.slice(0, 2),
      maxLines: 200,
    });
    state = pauseBufferReducer(state, { type: "pause" });
    state = pauseBufferReducer(state, { type: "snapshot", lines: rows, maxLines: 200 });
    expect(state.pending.map((row) => row.raw)).toEqual(["c"]);
    state = pauseBufferReducer(state, { type: "snapshot", lines: rows, maxLines: 200 });
    expect(state.visible).toHaveLength(2);
    expect(state.pending.map((row) => row.raw)).toEqual(["c"]);
    state = pauseBufferReducer(state, { type: "snapshot", lines: rows, maxLines: 200 });
    expect(state.pending).toHaveLength(1);
    state = pauseBufferReducer(state, { type: "resume", maxLines: 200 });
    expect(state.visible.map((row) => row.raw)).toEqual(["a", "b", "c"]);
  });

  it("reduces actual stream events to honest badge states with bounded retry", () => {
    let state = initialConnectionState;
    expect(connectionBadge(state, { paused: false }).label).toBe("Connecting");
    state = connectionReducer(state, { type: "open" });
    expect(connectionBadge(state, { paused: false }).label).toBe("Live");
    expect(connectionBadge(state, { paused: true, newCount: 3 })).toMatchObject({
      variant: "warn",
      label: "Paused · 3 new",
    });
    state = connectionReducer(state, { type: "error" });
    expect(state).toMatchObject({ status: "reconnecting", attempt: 1, retryInMs: 1000 });
    expect(connectionBadge(state, { paused: true }).variant).toBe("err");
    state = connectionReducer(state, { type: "connect" });
    expect(connectionBadge(state, { paused: false }).label).toBe("Disconnected · reconnecting");
    state = connectionReducer(state, { type: "error" });
    expect(state.retryInMs).toBe(2000);
    expect(retryDelayMs(100)).toBe(30000);
    expect(connectionReducer(state, { type: "hidden" }).status).toBe("idle");
    expect(connectionReducer(state, { type: "open" }).attempt).toBe(0);
    expect(() => connectionReducer(state, { type: "unknown" })).toThrow();
  });
});
