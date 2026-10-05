import { NextResponse } from "next/server";
import { validateComboStrategySettings } from "open-sse/services/comboStrategy.js";

const VALID_COMBO_NAME = /^[a-zA-Z0-9_.-]+$/;
const BLOCKED_COMBO_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const PATCH_KEYS = new Set(["fallbackStrategy", "weights", "judgeModel", "fusionTuning"]);

/**
 * Validate and apply a `{ comboStrategyPatch: { name, patch } }` body.
 * Shared by /api/settings (instance blob) and the workspace settings route.
 * @param {object} body Request body.
 * @param {(transform: Function, name: string) => Promise<object>} update
 *   Store writer: `updateComboStrategies` or a workspace-bound wrapper.
 * @returns {Promise<{ response: Response } | { settings: object }>}
 *   `response` is an error to return as-is; `settings` is the stored result.
 */
export async function applyComboStrategyPatch(body, update) {
  const fail = (error, status) => ({ response: NextResponse.json({ error }, { status }) });
  const { name, patch } = body.comboStrategyPatch || {};
  if (typeof name !== "string" || !VALID_COMBO_NAME.test(name) || BLOCKED_COMBO_NAMES.has(name)) {
    return fail("Invalid combo name", 400);
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return fail("Invalid combo strategy patch", 400);
  }
  // Preserve fusion settings edits; reject unknown keys instead of silently storing them.
  if (Object.keys(patch).some((key) => !PATCH_KEYS.has(key))) {
    return fail("Invalid combo strategy patch", 400);
  }
  const error = validateComboStrategySettings({ comboStrategies: { [name]: patch } });
  if (error) return fail(error, 400);

  // Validation against the merged entry happens inside the transaction too (weight-count cap).
  let mergedError;
  let missingWeightedEntry = false;
  let settings;
  try {
    settings = await update((strategies) => {
      const base = Object.hasOwn(strategies, name) ? strategies[name] : {};
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
      mergedError = validateComboStrategySettings({ comboStrategies: { [name]: next } });
      if (mergedError) return strategies;
      const updated = { ...strategies };
      // An explicit "fallback" is stored: deleting the entry would make the combo
      // silently inherit the global comboStrategy instead (YAN-679).
      if (!next.fallbackStrategy) {
        delete updated[name];
      } else {
        updated[name] = next;
      }
      return updated;
    }, name);
  } catch (err) {
    if (err.code === "COMBO_NOT_FOUND") return fail("Combo not found", 409);
    throw err;
  }
  if (missingWeightedEntry) return fail("Combo not found", 409);
  if (mergedError) return fail(mergedError, 400);
  return { settings };
}
