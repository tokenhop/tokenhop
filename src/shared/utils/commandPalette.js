// Command palette primitives (YAN-294). Dependency-free: fuzzy scorer,
// grouping/ordering, recent-items storage helpers, shortcut guard, and the
// registerCommandSource() registry Settings (YAN-309) will plug into.

export const COMMAND_GROUPS = ["Pages", "Providers", "Combos", "Models", "Actions", "Settings"];

export const RECENT_KEY = "signal.commandPalette.recents";
export const MAX_RECENTS = 8;

function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
}

function haystackOf(commandOrText) {
  if (typeof commandOrText === "string") return normalize(commandOrText);
  const command = commandOrText || {};
  return normalize(
    [command.label, command.hint, command.keywords, command.id].filter(Boolean).join(" "),
  );
}

/**
 * Dependency-free fuzzy score.
 * Prefix hit (100) > word-start hit (70 + tightness) > subsequence hit (40 - gaps).
 * Miss returns { matched: false, score: -1 }.
 * A legacy (target, query) order still works via the type sniff below;
 * new callers use (query, target).
 * @param {string} query raw user input
 * @param {string|object} target label text or command {label,hint,keywords,id}
 */
export function fuzzyScore(a, b) {
  let query = a;
  let target = b;
  if (typeof b === "string" && typeof a !== "string" && a && typeof a === "object") {
    query = b;
    target = a;
  } else if (typeof a === "object" && b === undefined) {
    target = a;
    query = "";
  }
  const needle = normalize(query).replace(/\s+/g, "");
  const hay = haystackOf(target);
  const label = normalize(typeof target === "string" ? target : target?.label);
  if (!needle) return { matched: true, score: 0 };
  if (!hay) return { matched: false, score: -1 };

  if (label.startsWith(needle)) return { matched: true, score: 100 - label.length * 0.01 };
  const wordHit = label.split(/[\s_/-]+/).find((word) => word.startsWith(needle));
  if (wordHit) return { matched: true, score: 70 - wordHit.length * 0.05 };

  let gap = 0;
  let pos = -1;
  for (const char of needle) {
    const next = hay.indexOf(char, pos + 1);
    if (next === -1) return { matched: false, score: -1 };
    gap += next - pos - 1;
    pos = next;
  }
  return { matched: true, score: Math.max(1, 40 - gap) };
}

/**
 * Filter commands by query and rank: score desc, then recency, then label.
 * @param {Array<object>} commands
 * @param {string} query
 * @param {string[]} [recentIds]
 */
export function filterAndRank(commands, query, recentIds = []) {
  const recency = new Map((recentIds || []).map((id, index) => [id, index]));
  const needle = normalize(query).trim();
  const scored = [];
  for (const command of commands || []) {
    const hit = fuzzyScore(needle, command);
    if (!hit.matched) continue;
    scored.push({ command, score: hit.score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ra = recency.has(a.command.id) ? recency.get(a.command.id) : Infinity;
    const rb = recency.has(b.command.id) ? recency.get(b.command.id) : Infinity;
    if (ra !== rb) return ra - rb;
    const groupOrder =
      COMMAND_GROUPS.indexOf(a.command.group) - COMMAND_GROUPS.indexOf(b.command.group);
    if (groupOrder !== 0) return groupOrder;
    return String(a.command.label).localeCompare(String(b.command.label));
  });
  return scored.map((entry) => entry.command);
}

/**
 * Group ranked commands in canonical COMMAND_GROUPS order.
 * @param {Array<object>} ranked
 * @returns {Array<{group: string, count: number, items: Array<object>}>}
 */
export function groupResults(ranked) {
  const byGroup = new Map();
  for (const command of ranked || []) {
    if (!byGroup.has(command.group)) byGroup.set(command.group, []);
    byGroup.get(command.group).push(command);
  }
  const ordered = [
    ...COMMAND_GROUPS.filter((g) => byGroup.has(g)),
    ...[...byGroup.keys()].filter((g) => !COMMAND_GROUPS.includes(g)),
  ];
  return ordered.map((group) => ({
    group,
    count: byGroup.get(group).length,
    items: byGroup.get(group),
  }));
}

/** Unshift id to the front, deduped, capped at `max`. Pure. */
export function pushRecent(recentIds, id, max = MAX_RECENTS) {
  return [id, ...(recentIds || []).filter((entry) => entry !== id)].slice(0, max);
}

/** Read persisted recent ids. Never throws: broken storage yields []. */
export function loadRecents(storage = defaultStorage()) {
  try {
    const raw = storage?.getItem?.(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/** Persist recent ids. Never throws (private-mode storage may deny writes). */
export function saveRecents(storage, recentIds) {
  try {
    storage?.setItem?.(RECENT_KEY, JSON.stringify(recentIds || []));
  } catch {
    // Private mode / denied storage: recents simply do not persist.
  }
}

function defaultStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Screen-reader announcement for result counts.
 * @param {number} total
 */
export function formatResultAnnouncement(total) {
  if (!total || total <= 0) return "No matches";
  return `${total} result${total === 1 ? "" : "s"}`;
}

/**
 * Decide whether a keydown should open the palette. Pure and DOM-free:
 * the caller passes normalized flags so React/SSR stays testable.
 * Never opens from handled, composing, editable, or code-editor contexts.
 */
export function shouldOpenCommandPalette({
  key,
  metaKey = false,
  ctrlKey = false,
  defaultPrevented = false,
  isComposing = false,
  inEditable = false,
  inCodeEditor = false,
} = {}) {
  if (defaultPrevented || isComposing || inEditable || inCodeEditor) return false;
  if (typeof key !== "string" || key.toLowerCase() !== "k") return false;
  return Boolean(metaKey || ctrlKey);
}

/** Snapshot a real KeyboardEvent into the flags shouldOpenCommandPalette needs. */
export function eventShortcutFlags(event, { inCodeEditor = false } = {}) {
  const target = event?.target;
  const editable =
    target?.isContentEditable === true ||
    /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || "") ||
    target?.getAttribute?.("role") === "combobox";
  return {
    key: event?.key,
    metaKey: Boolean(event?.metaKey),
    ctrlKey: Boolean(event?.ctrlKey),
    defaultPrevented: Boolean(event?.defaultPrevented),
    isComposing: event?.keyCode === 229 || Boolean(event?.isComposing),
    inEditable: editable,
    inCodeEditor: Boolean(inCodeEditor),
  };
}

const staticSources = [];
const dynamicSources = new Map();

/**
 * Register a command source (Settings rows in YAN-309 plug in here).
 * @param {string} id unique source id
 * @param {(ctx: object) => Array<object>|Promise<Array<object>>} load returns commands
 * @returns {() => void} unregister function
 */
export function registerCommandSource(id, load) {
  if (!id || typeof load !== "function")
    throw new Error("registerCommandSource: id and load required");
  dynamicSources.set(id, load);
  return () => {
    dynamicSources.delete(id);
  };
}

/** Test seam: reset dynamic sources. */
export function clearCommandSources() {
  dynamicSources.clear();
}

/** Built-in sources call this once at module load. Guards double registration under HMR. */
export function registerStaticSource(source) {
  if (!staticSources.includes(source)) staticSources.push(source);
}

export function getStaticSources() {
  return [...staticSources];
}

export async function collectCommands(context = {}) {
  const settled = await Promise.allSettled(
    [...staticSources, ...dynamicSources.values()].map((load) => load(context)),
  );
  return settled.flatMap((entry) => (entry.status === "fulfilled" ? entry.value || [] : []));
}

/**
 * Idle-prefetch guard for the lazy models source: fetch from /api/models at
 * most once per `ttlMs` and share the in-flight request.
 */
export function createCachedLoader(ttlMs = 5 * 60 * 1000) {
  let cachedAt = 0;
  let inflight = null;
  return async function cached(load) {
    const fresh = Date.now() - cachedAt < ttlMs;
    if (fresh && !inflight) return "fresh";
    if (!inflight) {
      inflight = Promise.resolve()
        .then(load)
        .then(
          (value) => {
            cachedAt = Date.now();
            inflight = null;
            return value;
          },
          (error) => {
            inflight = null;
            throw error;
          },
        );
    }
    return inflight;
  };
}
