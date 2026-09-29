/**
 * Module-level GET store for the Home widgets. One entry per URL, so hooks
 * that read the same URL in one render share a single request, and one
 * visibility listener (in HomePageClient) refreshes only stale entries.
 */

/** Entries younger than this are fresh; a tab focus leaves them alone. */
export const STALE_MS = 30_000;
/** Minimum gap between two accepted tab-focus refreshes. */
export const FOCUS_THROTTLE_MS = 15_000;

const entries = new Map();
let lastFocusAt = 0;

function entryFor(url) {
  let entry = entries.get(url);
  if (!entry) {
    entry = { data: null, error: null, at: 0, inflight: null, inflightKey: null, subs: new Set() };
    entries.set(url, entry);
  }
  return entry;
}

function notify(entry) {
  const snapshot = snapshotOf(entry);
  for (const listener of entry.subs) listener(snapshot);
}

function snapshotOf(entry) {
  return { data: entry.data, error: entry.error, loading: Boolean(entry.inflight) };
}

/**
 * Current state for a URL.
 * @param {string} url
 * @returns {{ data: unknown, error: string|null, loading: boolean }}
 */
export function getSnapshot(url) {
  const entry = entries.get(url);
  return entry ? snapshotOf(entry) : { data: null, error: null, loading: false };
}

/**
 * Listen to a URL. The entry is dropped when its last listener leaves, so a
 * later visit to Home starts from a fresh GET.
 * @param {string} url
 * @param {(snapshot: object) => void} listener
 * @returns {() => void} unsubscribe
 */
export function subscribe(url, listener) {
  const entry = entryFor(url);
  entry.subs.add(listener);
  return () => {
    entry.subs.delete(listener);
    // Deferred: a refreshKey bump unsubscribes and re-subscribes in the same
    // commit, and the last good data must survive that.
    queueMicrotask(() => {
      if (entry.subs.size === 0 && !entry.inflight && entries.get(url) === entry) {
        entries.delete(url);
      }
    });
  };
}

/**
 * GET a URL. A request already in flight for the same `key` is joined (this
 * de-duplicates hooks that mount together); a different key starts a new one,
 * so bumping a refresh key after a mutation always re-reads.
 * Non-2xx responses keep the last good data and set `error`.
 * @param {string} url
 * @param {{ key?: unknown }} [options]
 * @returns {Promise<void>}
 */
export function loadResource(url, { key = 0 } = {}) {
  const entry = entryFor(url);
  if (entry.inflight && entry.inflightKey === key) return entry.inflight;

  const request = (async () => {
    // Yield once so `request` is assigned before any synchronous fetch throw
    // reaches the finally block below.
    await null;
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || `Request failed (${response.status})`);
      }
      entry.data = await response.json();
      entry.error = null;
    } catch (error) {
      entry.error = error?.message || "Unable to load data";
    } finally {
      entry.at = Date.now();
      if (entry.inflight === request) {
        entry.inflight = null;
        entry.inflightKey = null;
      }
      if (entry.subs.size === 0 && !entry.inflight && entries.get(url) === entry) {
        entries.delete(url);
      }
      notify(entry);
    }
  })();

  entry.inflight = request;
  entry.inflightKey = key;
  notify(entry);
  return request;
}

/**
 * Re-read every watched URL whose data is older than STALE_MS.
 * @param {number} [now]
 * @returns {number} how many requests started
 */
export function refreshStaleResources(now = Date.now()) {
  let started = 0;
  for (const [url, entry] of entries) {
    if (entry.subs.size === 0 || entry.inflight || now - entry.at < STALE_MS) continue;
    loadResource(url, { key: `stale:${now}` });
    started += 1;
  }
  return started;
}

/**
 * Tab-focus handler: at most one batched stale refresh per FOCUS_THROTTLE_MS.
 * @param {number} [now]
 * @returns {number} how many requests started
 */
export function onHomeFocus(now = Date.now()) {
  if (typeof document !== "undefined" && document.hidden) return 0;
  if (now - lastFocusAt < FOCUS_THROTTLE_MS) return 0;
  lastFocusAt = now;
  return refreshStaleResources(now);
}

/** Test helper: forget every entry and the focus throttle. */
export function resetHomeResourceStore() {
  entries.clear();
  lastFocusAt = 0;
}
