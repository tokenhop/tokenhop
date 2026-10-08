/**
 * Combo strategy resolution and settings validation.
 *
 * Pure module: no imports from src/, no DB access. Both the SSE engine and the
 * settings API use it so strategy resolution stays DRY.
 */

/** Allowed combo strategies, in UI order. */
export const COMBO_STRATEGIES = Object.freeze([
  "fallback",
  "round-robin",
  "fusion",
  "weighted",
  "fastest",
]);

/** Max per-model weight accepted by the validator (protects WRR float precision). */
export const MAX_COMBO_WEIGHT = 1000;

const DEFAULT_STRATEGY = "fallback";
const MAX_COMBO_STRATEGY_ENTRIES = 500;
const MAX_WEIGHT_ENTRIES = 200;
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve the effective combo strategy config.
 * @param {object | null | undefined} settings Persisted settings blob.
 * @param {string} comboName Combo name to look up in settings.comboStrategies.
 * @returns {{ strategy: string, stickyLimit: unknown, weights: object, judgeModel: unknown, fusionTuning: unknown }}
 */
export function resolveComboStrategy(settings, comboName) {
  const combos = settings?.comboStrategies;
  const entry =
    isPlainObject(combos) && Object.hasOwn(combos, comboName) && isPlainObject(combos[comboName])
      ? combos[comboName]
      : {};
  const raw = entry.fallbackStrategy || settings?.comboStrategy || DEFAULT_STRATEGY;
  const strategy = COMBO_STRATEGIES.includes(raw) ? raw : DEFAULT_STRATEGY;
  return {
    strategy,
    stickyLimit: settings?.comboStickyRoundRobinLimit,
    weights: isPlainObject(entry.weights) ? entry.weights : {},
    judgeModel: entry.judgeModel,
    fusionTuning: entry.fusionTuning,
  };
}

/**
 * Validate combo-strategy keys in a settings PATCH body.
 * Only keys present (own property) are checked; absent keys pass.
 * @param {object | null | undefined} body JSON-parsed PATCH body.
 * @returns {string | null} Error message, or null when valid.
 */
export function validateComboStrategySettings(body) {
  if (!isPlainObject(body)) return null;

  if (Object.hasOwn(body, "comboStrategy") && !COMBO_STRATEGIES.includes(body.comboStrategy)) {
    return "Invalid comboStrategy";
  }

  if (!Object.hasOwn(body, "comboStrategies")) return null;

  const combos = body.comboStrategies;
  if (!isPlainObject(combos)) return "comboStrategies must be an object";

  const entries = Object.entries(combos);
  if (entries.length > MAX_COMBO_STRATEGY_ENTRIES) return "Too many comboStrategies entries";

  for (const [name, entry] of entries) {
    if (BLOCKED_KEYS.has(name)) return `Invalid combo name "${name}"`;
    if (!isPlainObject(entry)) return `Invalid strategy for combo "${name}"`;
    if (
      entry.fallbackStrategy !== undefined &&
      !COMBO_STRATEGIES.includes(entry.fallbackStrategy)
    ) {
      return `Invalid strategy for combo "${name}"`;
    }

    const weights = entry.weights;
    if (weights === undefined) continue;
    if (!isPlainObject(weights) || Object.keys(weights).length > MAX_WEIGHT_ENTRIES) {
      return `Invalid weights for combo "${name}"`;
    }
    for (const [model, value] of Object.entries(weights)) {
      if (
        BLOCKED_KEYS.has(model) ||
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > MAX_COMBO_WEIGHT
      ) {
        return `Invalid weight for combo "${name}" model "${model}"`;
      }
    }
  }

  return null;
}
