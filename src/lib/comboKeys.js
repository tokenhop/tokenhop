// YAN-364 lookup-key helpers for combo strategies and rotation state.
// open-sse services are pure (no DB), so this module stays request/DB-free
// and every handler/scheduler/repo follows one rule (plan decision 4/6).
import { resolveComboStrategy } from "open-sse/services/comboStrategy.js";

/**
 * Settings key for a combo's strategy entry. Workspace rows key by combo
 * **id** (renames are strategy-preserving); the pre-split instance blob keys
 * by name, so the no-principal path stays byte-identical.
 * @param {object | null | undefined} principal Gateway/management principal, if any.
 * @param {{ id: string, name: string }} combo
 * @returns {string} `combo.id` when a principal exists, else `combo.name`.
 */
export function comboStrategyKey(principal, combo) {
  return principal ? combo.id : combo.name;
}

/**
 * Non-enumerable marker getEffectivePreferences sets on a workspace-scoped
 * result (multi-user ON, workspace resolved): its `comboStrategies` is that
 * workspace's **id-keyed** map (or `{}`), never the instance blob. Symbol.for
 * so the repo and handlers share it without an import cycle; non-enumerable so
 * it never reaches a spread, JSON response or settings merge.
 */
export const COMBO_STRATEGIES_BY_ID = Symbol.for("tokenhop.comboStrategiesById");

/**
 * Effective strategy config for one combo, in the namespace `settings` holds.
 * Workspace-scoped preferences (marker set): id lookup only — a workspace
 * without its own entry gets the default, it never inherits another
 * workspace's or the instance blob's name-keyed strategy. Everything else
 * (switch off, no principal, legacy blob): the name lookup, byte-identical to
 * before. `principal` is accepted for call-site symmetry with
 * `comboStrategyKey` but the namespace is decided by the settings, so a
 * principal under switch off keeps today's name-keyed behaviour.
 * @param {object} settings Effective preferences (from getEffectivePreferences).
 * @param {object | null | undefined} _principal Gateway/management principal, if any.
 * @param {{ id: string, name: string }} combo
 */
export function comboStrategyFor(settings, _principal, combo) {
  const byId = settings?.[COMBO_STRATEGIES_BY_ID] === true;
  return resolveComboStrategy(settings, byId ? combo?.id : combo?.name);
}

/**
 * Rotation-state key (ADR-0001): two workspaces may share a combo name and
 * must keep independent rotation cursors; a null workspaceId (legacy path)
 * keeps the plain, byte-identical key.
 * @param {string | null | undefined} workspaceId
 * @param {string} name
 * @returns {string} `${workspaceId}:${name}` when workspaceId, else `name`.
 */
export function comboRotationKey(workspaceId, name) {
  return workspaceId ? `${workspaceId}:${name}` : name;
}
