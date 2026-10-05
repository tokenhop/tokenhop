import { NextResponse } from "next/server";
import { validateComboStrategySettings } from "open-sse/services/comboStrategy.js";

const VALID_COMBO_NAME = /^[a-zA-Z0-9_.-]+$/;
const BLOCKED_COMBO_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const PATCH_KEYS = new Set(["fallbackStrategy", "weights", "judgeModel", "fusionTuning"]);
const MAX_ID_LENGTH = 128;

/** Whether `name` is a well-formed combo name (same rule the combos routes enforce). */
export function isValidComboName(name) {
  return typeof name === "string" && VALID_COMBO_NAME.test(name) && !BLOCKED_COMBO_NAMES.has(name);
}

/**
 * Validate and apply a `{ comboStrategyPatch: { name | id, patch } }` body.
 * Shared by /api/settings (instance blob, name-keyed) and the workspace
 * settings route (id-keyed, YAN-364). Default: `name` selects the entry. With
 * `options.allowId`: `id` selects it and a `name` is rejected (the caller
 * resolves names to ids inside its workspace first).
 * @param {object} body Request body.
 * @param {(transform: Function, key: string) => Promise<object>} update
 *   Store writer: `updateComboStrategies` or a workspace-bound wrapper. `key`
 *   is the map key (combo name, or combo id with `allowId`).
 * @param {{ allowId?: boolean }} [options]
 * @returns {Promise<{ response: Response } | { settings: object }>}
 *   `response` is an error to return as-is; `settings` is the stored result.
 */
export async function applyComboStrategyPatch(body, update, { allowId = false } = {}) {
  const fail = (error, status) => ({ response: NextResponse.json({ error }, { status }) });
  const { name, id, patch } = body.comboStrategyPatch || {};
  // allowId = id-keyed store: the key MUST be a combo id; a bare name would
  // write a name-keyed entry into an id-keyed map, so callers resolve first.
  if (allowId && name !== undefined) return fail("Invalid combo name", 400);
  const key = allowId ? id : name;
  const validKey = allowId
    ? typeof id === "string" && id.length <= MAX_ID_LENGTH && isValidComboName(id)
    : isValidComboName(name);
  if (!validKey) {
    return fail("Invalid combo name", 400);
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return fail("Invalid combo strategy patch", 400);
  }
  // Preserve fusion settings edits; reject unknown keys instead of silently storing them.
  if (Object.keys(patch).some((k) => !PATCH_KEYS.has(k))) {
    return fail("Invalid combo strategy patch", 400);
  }
  const error = validateComboStrategySettings({ comboStrategies: { [key]: patch } });
  if (error) return fail(error, 400);

  // Validation against the merged entry happens inside the transaction too (weight-count cap).
  let mergedError;
  let missingWeightedEntry = false;
  let settings;
  try {
    settings = await update((strategies) => {
      const base = Object.hasOwn(strategies, key) ? strategies[key] : {};
      if (
        Object.hasOwn(patch, "weights") &&
        !Object.hasOwn(patch, "fallbackStrategy") &&
        base?.fallbackStrategy !== "weighted"
      ) {
        missingWeightedEntry = true;
        return strategies;
      }
      const next = { ...base, ...patch };
      if (patch.weights) next.weights = { ...base?.weights, ...patch.weights };
      mergedError = validateComboStrategySettings({ comboStrategies: { [key]: next } });
      if (mergedError) return strategies;
      const updated = { ...strategies };
      // An explicit "fallback" is stored: deleting the entry would make the combo
      // silently inherit the global comboStrategy instead (YAN-679).
      if (!next.fallbackStrategy) {
        delete updated[key];
      } else {
        updated[key] = next;
      }
      return updated;
    }, key);
  } catch (err) {
    if (err.code === "COMBO_NOT_FOUND") return fail("Combo not found", 409);
    throw err;
  }
  if (missingWeightedEntry) return fail("Combo not found", 409);
  if (mergedError) return fail(mergedError, 400);
  return { settings };
}
