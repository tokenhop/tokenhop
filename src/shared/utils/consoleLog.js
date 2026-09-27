/**
 * Pure logic for the Console log page (YAN-302, YAN-394): line parsing,
 * prefix stripping, repeat grouping, filtering, level counts, the
 * pause-buffer and connection reducers and the auto-scroll state machine.
 * No React/DOM. Fail fast on unsupported input.
 */

/** Levels shown by the level SegmentedControl, in display order. */
export const CONSOLE_LEVELS = ["LOG", "INFO", "WARN", "ERROR", "DEBUG"];

const KNOWN_LEVELS = new Set(CONSOLE_LEVELS);

const LINE_RE = /^(?:\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*)?(?:\[([A-Za-z]+)\]\s*)?(.*)$/s;
// Leading pictographs (with optional variation selector) duplicate the level column.
const STATUS_PREFIX = /^(?:\p{Extended_Pictographic}\uFE0F?\s*)+/u;
const EMOJI_LEVELS = {
  "⚠️": "WARN",
  "⚠": "WARN",
  "❌": "ERROR",
  "🔍": "DEBUG",
  ℹ️: "INFO",
  ℹ: "INFO",
};
const BROWSER_PREFIX = /^\[browser\]\s*/;
const ISO_TIME_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const CLOCK_RE = /\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Only explicit identifiers are masked. Arbitrary hex values and fields such as
// `grid` can carry diagnostic meaning and must not collapse distinct events.
const KEYED_ID_RE = /\b(id|requestId|connectionId|traceId|sessionId)("?\s*[:=]\s*"?)[\w.-]+/gi;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30000;

/**
 * Strip leading emoji/status glyphs at render time; the level column already
 * carries that meaning. Glyphs later in the message are kept.
 * @param {string} message
 * @returns {string}
 */
export function stripConsolePrefix(message) {
  if (typeof message !== "string") throw new Error("stripConsolePrefix: expected a string");
  return message.replace(STATUS_PREFIX, "");
}

/**
 * Normalise a message for repeat detection: timestamps and ids are masked so
 * the same event logged at different times (or for different request ids)
 * shares one key.
 * @param {string} message
 * @returns {string}
 */
export function normalizeConsoleMessage(message) {
  return message
    .replace(ISO_TIME_RE, "<time>")
    .replace(CLOCK_RE, "<time>")
    .replace(UUID_RE, "<id>")
    .replace(KEYED_ID_RE, "$1$2<id>");
}

/**
 * Collapse recurring identical lines (same level, source and normalised text)
 * into one row with a count. Rows sit at their most recent occurrence, so a
 * repeat moves its row to the bottom and `time` is the last-seen time.
 * @param {{ id: number, time: string, level: string, source?: string, message: string }[]} lines
 * @returns {{ key: string, count: number, firstTime: string, occurrences: object[] }[]}
 */
export function groupConsoleLines(lines) {
  if (!Array.isArray(lines)) throw new Error("groupConsoleLines: expected an array of lines");
  const groups = new Map();
  for (const line of lines) {
    const key = `${line.level}\u0000${line.source || "server"}\u0000${normalizeConsoleMessage(line.message)}`;
    const group = groups.get(key);
    // Delete + set moves the group to the end (Map keeps insertion order).
    if (group) groups.delete(key);
    const occurrences = group ? [...group.occurrences, line] : [line];
    groups.set(key, {
      ...line,
      key,
      count: occurrences.length,
      firstTime: occurrences[0].time,
      occurrences,
    });
  }
  return [...groups.values()];
}

/**
 * Pretty-print the first JSON object/array that runs to the end of the
 * message, keeping the text before it. Non-JSON messages are returned as is.
 * @param {string} message
 * @returns {string}
 */
export function prettyConsoleMessage(message) {
  for (let index = 0; index < message.length; index += 1) {
    if (message[index] !== "{" && message[index] !== "[") continue;
    let parsed;
    try {
      parsed = JSON.parse(message.slice(index));
    } catch {
      // Earlier brackets are often source tags like [TOKEN_REFRESH]; try the next one.
      continue;
    }
    if (typeof parsed === "object" && parsed !== null) {
      const head = message.slice(0, index).trimEnd();
      const body = JSON.stringify(parsed, null, 2);
      return head ? `${head}\n${body}` : body;
    }
  }
  return message;
}

/**
 * Repeat detail: cap huge ×N expansions. Copy uses every occurrence; the view
 * shows the first/last 8 so the panel stays usable on hot repeats.
 */
export const MAX_DETAIL_OCCURRENCES = 8;

/** Search text is prepared at ingest, never pretty-printed on each keystroke. */
export function prepareConsoleLine(line) {
  return {
    ...line,
    searchText: `${line.message}\n${prettyConsoleMessage(line.message)}`.toLowerCase(),
  };
}

/**
 * Exponential reconnect backoff: 1s, 2s, 4s … capped at 30s.
 * @param {number} attempt 1-based failed attempt count.
 * @returns {number} milliseconds
 */
export function retryDelayMs(attempt) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`retryDelayMs: expected a positive attempt, got ${attempt}`);
  }
  return Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (attempt - 1));
}

export const initialConnectionState = { status: "connecting", attempt: 0, retryInMs: 0 };

/**
 * Stream connection state machine.
 * - connecting: first connect, or a retry after `attempt` failures
 * - open: EventSource opened
 * - reconnecting: dropped; the next try runs in `retryInMs`
 * - idle: closed on purpose because the tab is hidden
 * @param {{ status: string, attempt: number, retryInMs: number }} state
 * @param {{ type: "connect"|"open"|"error"|"hidden" }} action
 */
export function connectionReducer(state, action) {
  switch (action.type) {
    case "connect":
      return { ...state, status: "connecting", retryInMs: 0 };
    case "open":
      return { status: "open", attempt: 0, retryInMs: 0 };
    case "error": {
      const attempt = state.attempt + 1;
      return { status: "reconnecting", attempt, retryInMs: retryDelayMs(attempt) };
    }
    case "hidden":
      return { status: "idle", attempt: 0, retryInMs: 0 };
    default:
      throw new Error(`connectionReducer: unknown action "${action?.type}"`);
  }
}

/**
 * Badge for the header: never claims Live unless the stream is open.
 * @param {{ status: string, attempt: number }} connection
 * @param {{ paused: boolean, newCount: number }} buffer
 * @returns {{ variant: string, label: string, announcement: string }}
 */
export function connectionBadge(connection, buffer) {
  const down =
    connection.status === "reconnecting" ||
    (connection.status === "connecting" && connection.attempt > 0);
  if (down) {
    return {
      variant: "err",
      label: "Disconnected · reconnecting",
      announcement: "Log stream disconnected, reconnecting",
    };
  }
  if (connection.status === "connecting") {
    return {
      variant: "neutral",
      label: "Connecting",
      announcement: "Connecting to the log stream",
    };
  }
  if (connection.status === "idle") {
    return { variant: "neutral", label: "Stopped", announcement: "Log stream stopped" };
  }
  if (buffer.paused) {
    return {
      variant: "warn",
      label: `Paused · ${buffer.newCount} new`,
      announcement: "Stream paused",
    };
  }
  return { variant: "live", label: "Live", announcement: "Streaming live" };
}

/**
 * Parse a raw server log line into a structured row. Server lines look like
 * `[14:07:19] [TOKEN_REFRESH] message` or plain text; request-logger emoji
 * prefixes (`⚠️`, `❌`, `🔍`, `ℹ️`) identify the original level and are
 * stripped after level detection so the column carries the meaning.
 * Leading status glyphs are stripped and a `[browser]` prefix (Next.js dev
 * browser-log forwarding) becomes `source: "browser"`.
 * @param {string} rawLine
 * @returns {{ time: string, level: string, source: "server"|"browser", message: string, raw: string }}
 */
export function parseConsoleLine(rawLine) {
  if (typeof rawLine !== "string") {
    throw new Error(`parseConsoleLine: expected a string, got ${typeof rawLine}`);
  }
  const match = rawLine.match(LINE_RE);
  const bracketLevel = (match[2] || "").toUpperCase();
  const glyph = Object.keys(EMOJI_LEVELS).find((mark) => match[3].startsWith(mark));
  const level = KNOWN_LEVELS.has(bracketLevel) ? bracketLevel : glyph ? EMOJI_LEVELS[glyph] : "LOG";
  const rawMessage = KNOWN_LEVELS.has(bracketLevel)
    ? match[3]
    : `${match[2] ? `[${match[2]}] ` : ""}${match[3]}`;
  const cleaned = stripConsolePrefix(rawMessage);
  const browser = BROWSER_PREFIX.test(cleaned);
  return {
    time: match[1] || "",
    level,
    source: browser ? "browser" : "server",
    message: browser ? cleaned.replace(BROWSER_PREFIX, "") : cleaned,
    raw: rawLine,
  };
}

/**
 * Filter parsed lines by level, source, and case-insensitive text query.
 * The text filter also checks all messages collapsed under one row.
 * @param {{ level: string, message: string, source: string, occurrences: object[] }[]} lines
 * @param {{ query?: string, level?: string, hideBrowser?: boolean }} [filters]
 * @returns {{ level: string, message: string }[]}
 */
export function filterConsoleLines(lines, filters = {}) {
  if (!Array.isArray(lines)) throw new Error("filterConsoleLines: expected an array of lines");
  const { query = "", level = "ALL", hideBrowser = false } = filters;
  if (level !== "ALL" && !KNOWN_LEVELS.has(level)) {
    throw new Error(`filterConsoleLines: unknown level "${level}"`);
  }
  const needle = query.trim().toLowerCase();
  return lines.filter(
    (line) =>
      (level === "ALL" || line.level === level) &&
      (!hideBrowser || line.source !== "browser") &&
      (needle === "" ||
        (line.occurrences || [line]).some((item) =>
          (item.searchText ?? prepareConsoleLine(item).searchText).includes(needle),
        )),
  );
}

/**
 * Keep expanded disclosures across filter and Raw toggles: a key is dropped
 * only when no buffered line can render it any more. Grouped keys and raw
 * line ids are both kept so switching modes restores the same expansion.
 * @param {Set<string>} keys
 * @param {{ key: string, occurrences: { id: number }[] }[]} groups
 * @returns {Set<string>} the same Set when nothing changed
 */
export function pruneExpandedKeys(keys, groups) {
  const live = new Set();
  for (const group of groups) {
    live.add(group.key);
    for (const line of group.occurrences) live.add(String(line.id));
  }
  if ([...keys].every((key) => live.has(key))) return keys;
  return new Set([...keys].filter((key) => live.has(key)));
}

/**
 * Count parsed lines per level.
 * @param {{ level: string }[]} lines
 * @returns {Record<string, number>}
 */
export function countConsoleLevels(lines) {
  if (!Array.isArray(lines)) throw new Error("countConsoleLevels: expected an array of lines");
  const counts = { LOG: 0, INFO: 0, WARN: 0, ERROR: 0, DEBUG: 0 };
  for (const line of lines) {
    if (counts[line.level] !== undefined) counts[line.level] += 1;
  }
  return counts;
}

/**
 * Assign stable, monotonically increasing ids to freshly ingested lines.
 * Ids identify exact rows (including duplicates) and never change after head
 * drops at the buffer cap.
 * @param {object[]} lines
 * @param {number} startId
 * @returns {{ lines: object[], nextId: number }}
 */
export function tagConsoleLines(lines, startId) {
  if (!Array.isArray(lines)) throw new Error("tagConsoleLines: expected an array of lines");
  if (!Number.isInteger(startId) || startId < 0) {
    throw new Error(`tagConsoleLines: expected a non-negative startId, got ${startId}`);
  }
  return {
    lines: lines.map((line, index) => {
      const numbered = { ...line, id: startId + index };
      return prepareConsoleLine(numbered);
    }),
    nextId: startId + lines.length,
  };
}

/**
 * Cap a visible-lines array at maxLines, keeping the newest.
 * Existing row objects are preserved by reference so memoized rows do not
 * re-render merely because the buffer head dropped.
 * @param {object[]} visible
 * @param {object[]} lines
 * @param {number} maxLines
 * @returns {object[]}
 */
export function appendConsoleLines(visible, lines, maxLines) {
  if (!Array.isArray(visible) || !Array.isArray(lines)) {
    throw new Error("appendConsoleLines: expected arrays");
  }
  if (!Number.isInteger(maxLines) || maxLines <= 0) {
    throw new Error(`appendConsoleLines: expected a positive maxLines, got ${maxLines}`);
  }
  const next = [...visible, ...lines];
  return next.length > maxLines ? next.slice(-maxLines) : next;
}

/**
 * Length of the longest tail of `current` that equals the head of `incoming`
 * (compared by raw line), i.e. how many snapshot lines are already shown.
 * @param {{ raw?: string }[]} current
 * @param {{ raw?: string }[]} incoming
 * @returns {number}
 */
export function snapshotOverlap(current, incoming) {
  for (let size = Math.min(current.length, incoming.length); size > 0; size -= 1) {
    const offset = current.length - size;
    let same = true;
    for (let i = 0; i < size && same; i += 1) same = current[offset + i].raw === incoming[i].raw;
    if (same) return size;
  }
  return 0;
}

export const initialConsoleBufferState = {
  paused: false,
  visible: [],
  pending: [],
  newCount: 0,
  /** Next stable row id for ingested lines. Monotonic per page lifetime. */
  nextId: 0,
};

/**
 * Pause-buffer reducer: appends while live; buffers while paused; resume
 * flushes (capped); snapshot merges a catch-up fetch without duplicating
 * lines already shown; clear empties both lists.
 * @param {{ paused: boolean, visible: object[], pending: object[], newCount: number, nextId: number }} state
 * @param {{ type: string, lines?: object[], maxLines?: number }} action
 */
function reducerMaxLines(action) {
  if (!Number.isInteger(action.maxLines) || action.maxLines <= 0) {
    throw new Error("pauseBufferReducer: resume/append needs a positive maxLines");
  }
  return action.maxLines;
}

export function pauseBufferReducer(state, action) {
  switch (action.type) {
    case "pause":
      return { ...state, paused: true };
    case "resume": {
      const maxLines = reducerMaxLines(action);
      const tagged = tagConsoleLines(state.pending, state.nextId);
      return {
        ...state,
        paused: false,
        visible: appendConsoleLines(state.visible, tagged.lines, maxLines),
        pending: [],
        newCount: 0,
        nextId: tagged.nextId,
      };
    }
    case "append": {
      if (!Array.isArray(action.lines)) throw new Error("pauseBufferReducer: append needs lines");
      const maxLines = reducerMaxLines(action);
      const tagged = tagConsoleLines(action.lines, state.nextId);
      if (state.paused) {
        // Pending only needs the newest maxLines; the flush caps visible too.
        const pending = [...state.pending, ...tagged.lines].slice(-maxLines);
        return { ...state, pending, newCount: pending.length, nextId: tagged.nextId };
      }
      return {
        ...state,
        visible: appendConsoleLines(state.visible, tagged.lines, maxLines),
        nextId: tagged.nextId,
      };
    }
    case "snapshot": {
      if (!Array.isArray(action.lines)) throw new Error("pauseBufferReducer: snapshot needs lines");
      const maxLines = reducerMaxLines(action);
      const incoming = action.lines.slice(-maxLines);
      const overlap = snapshotOverlap([...state.visible, ...state.pending], incoming);
      if (overlap === 0) {
        // Nothing in common: the server buffer rotated or was cleared while we were away.
        // Keep pending lines received before the tab was hidden.
        const tagged = tagConsoleLines(incoming, state.nextId);
        if (state.paused) {
          const pending = appendConsoleLines(state.pending, tagged.lines, maxLines);
          return { ...state, pending, newCount: pending.length, nextId: tagged.nextId };
        }
        return { ...state, visible: tagged.lines, nextId: tagged.nextId };
      }
      return pauseBufferReducer(state, {
        type: "append",
        lines: incoming.slice(overlap),
        maxLines,
      });
    }
    case "clear":
      return { ...state, visible: [], pending: [], newCount: 0 };
    default:
      throw new Error(`pauseBufferReducer: unknown action "${action?.type}"`);
  }
}

export const initialAutoScrollState = { enabled: true };

/**
 * Auto-scroll state machine: user scroll-up disables, near-bottom scroll
 * re-enables, toggle flips.
 * @param {{ enabled: boolean }} state
 * @param {{ type: string, atBottom?: boolean }} action
 */
export function autoScrollReducer(state, action) {
  switch (action.type) {
    case "scroll": {
      // Scroll fires per frame: keep identity when nothing changed so the
      // page (and 200 memoized rows) does not re-render while scrolling.
      const enabled = action.atBottom !== false;
      return enabled === state.enabled ? state : { enabled };
    }
    case "toggle":
      return { enabled: !state.enabled };
    default:
      throw new Error(`autoScrollReducer: unknown action "${action?.type}"`);
  }
}
