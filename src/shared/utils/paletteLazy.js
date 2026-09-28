// Once-only lazy loading for the command palette's heavy modules (YAN-395).
// commandSources.js pulls the nav/provider registries, the settings registry
// and provider health; paletteVerbs.js pulls endpoint remote-access logic.
// Both load on first palette open (with an idle prefetch after mount) instead
// of with the dashboard shell. Registration inside commandSources.js runs at
// module load, and ES modules execute once, so static sources register exactly
// once no matter how often ensurePaletteSources() is called.

/**
 * Memoize an async loader: concurrent callers share one in-flight promise.
 * A rejection resets the memo so the next call retries (a failed chunk must
 * not brick the palette forever).
 * @param {() => Promise<unknown>} load
 * @returns {() => Promise<unknown>}
 */
export function onceAsync(load) {
  let promise = null;
  return () => {
    if (!promise) {
      promise = Promise.resolve()
        .then(load)
        .catch((err) => {
          promise = null;
          throw err;
        });
    }
    return promise;
  };
}

/** Import commandSources.js once (module side effect registers the sources). */
export const ensurePaletteSources = onceAsync(() => import("./commandSources.js"));

/** Import paletteVerbs.js once. */
export const ensurePaletteVerbs = onceAsync(() => import("./paletteVerbs.js"));

/**
 * Run `task` when the browser is idle, else shortly after mount.
 * @param {() => void} task
 * @returns {() => void} cleanup (cancels a pending idle callback/timeout)
 */
export function prefetchOnIdle(task) {
  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(task, { timeout: 2000 });
    return () => window.cancelIdleCallback?.(id);
  }
  const timer = setTimeout(task, 1500);
  return () => clearTimeout(timer);
}
