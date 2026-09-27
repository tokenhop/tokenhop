/**
 * Combos save/guard interleavings (YAN-400 release gate).
 * Pure: no React, no fetch. Orders the two server writes (PUT models, then
 * strategy PATCH) so a late PUT response commits only the models it wrote
 * into the list row, never the draft; a failed PATCH keeps saved combo +
 * strategy state truthful (models shown, strategy still dirty); a stale
 * save touched by a combo switch or newer edit cannot reseed the draft.
 * Also holds the link-click interception decision for the unsaved guard.
 */

/**
 * @param {{ id: string, models?: string[] }} commit Combo returned from PUT models.
 * @param {(updater: (prev: Array<{ id: string }>) => Array<{ id: string }>) => void} setCombos
 */
export function commitModelsIntoList(commit, setCombos) {
  if (!commit?.id) return;
  setCombos((prev) =>
    (prev || []).map((combo) =>
      combo.id === commit.id ? { ...combo, models: [...(commit.models || [])] } : combo,
    ),
  );
}

/**
 * Guard that reseeds only when save's combo is selected and no newer edits exist.
 */
export function shouldReseedDraft(savedComboId, saveGeneration, selectedComboId, editGeneration) {
  return savedComboId === selectedComboId && saveGeneration === editGeneration;
}

/**
 * Whether a link click must go through the unsaved-changes guard.
 * Pure decision extracted from useUnsavedComboGuard's capture listener so
 * the guard interleavings are unit-testable: left-click, no modifiers,
 * same-origin, and a URL that actually differs from the current one.
 * @param {{ button?: number, metaKey?: boolean, ctrlKey?: boolean, shiftKey?: boolean, altKey?: boolean, defaultPrevented?: boolean }} event
 * @param {{ href: string, target?: string, hasDownload?: boolean }} link
 * @param {string} currentHref `window.location.href`
 * @param {string} currentOrigin `window.location.origin`
 */
export function shouldGuardLinkClick(event, link, currentHref, currentOrigin) {
  if (!event || !link?.href) return false;
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return false;
  if (link.target === "_blank" || link.hasDownload) return false;
  let next;
  try {
    next = new URL(link.href, currentHref);
  } catch {
    return false;
  }
  if (next.href === currentHref || next.origin !== currentOrigin) return false;
  // Same-page hash jump discards nothing.
  if (
    next.pathname === new URL(currentHref).pathname &&
    next.search === new URL(currentHref).search
  ) {
    if (next.hash !== new URL(currentHref).hash) return false;
  }
  return true;
}

/**
 * Run ordered save: PUT models commits to list immediately; strategy PATCH
 * may fail afterwards with models shown and strategy still dirty via onSaved.
 */
export async function saveComboRoute({ putModels, patchStrategy, onModelsCommitted, onSaved }) {
  const commit = await putModels();
  onModelsCommitted?.(commit);
  await patchStrategy();
  onSaved?.(commit);
  return commit;
}
