// Which in-memory routing state a settings write must drop (YAN-1221).
// Pure: no imports from the routing engine, so it is cheap to unit-test.
//
// With the pre-write settings (`previous`) a save resets only what it changed:
// a change to `cacheAffinity` alone (the flag lives next to each combo/provider
// strategy) clears nothing, and a provider strategy edit resets only the providers
// whose other fields changed. Without `previous` the plan is the historical one:
// the whole combo/account state in scope is reset (fail-safe).
import { isDeepStrictEqual } from "node:util";

const COMBO_KEYS = [
  "comboStrategy",
  "comboStickyRoundRobinLimit",
  "comboStrategies",
  "comboStrategyPatch",
];
const ACCOUNT_KEYS = ["fallbackStrategy", "stickyRoundRobinLimit", "providerStrategies"];

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** One strategy entry without its `cacheAffinity` flag. */
function stripAffinity(entry) {
  if (!isPlain(entry)) return entry;
  const { cacheAffinity: _flag, ...rest } = entry;
  return rest;
}

/** A strategy map ({ [comboOrProvider]: entry }) with every entry stripped. */
function stripMap(map) {
  if (!isPlain(map)) return {};
  return Object.fromEntries(
    Object.entries(map)
      .map(([key, entry]) => [key, stripAffinity(entry)])
      .filter(([, entry]) => !isPlain(entry) || Object.keys(entry).length > 0),
  );
}

/** True when a `comboStrategyPatch` body only touches the cacheAffinity flag. */
function isAffinityOnlyPatch(patchBody) {
  const keys = isPlain(patchBody?.patch) ? Object.keys(patchBody.patch) : [];
  return keys.length > 0 && keys.every((key) => key === "cacheAffinity");
}

function comboStateChanged(body, next, previous) {
  const patch = Object.hasOwn(body, "comboStrategyPatch");
  if (patch) {
    if (!previous) return !isAffinityOnlyPatch(body.comboStrategyPatch);
    const selector = body.comboStrategyPatch;
    const key = selector?.id ?? selector?.name;
    return !isDeepStrictEqual(
      stripAffinity(previous.comboStrategies?.[key]),
      stripAffinity(next?.comboStrategies?.[key]),
    );
  }
  if (!previous) {
    return COMBO_KEYS.some((key) => key !== "comboStrategyPatch" && Object.hasOwn(body, key));
  }
  for (const key of ["comboStrategy", "comboStickyRoundRobinLimit"]) {
    if (Object.hasOwn(body, key) && previous[key] !== next?.[key]) return true;
  }
  return (
    Object.hasOwn(body, "comboStrategies") &&
    !isDeepStrictEqual(stripMap(previous.comboStrategies), stripMap(next?.comboStrategies))
  );
}

function accountScope(body, next, previous) {
  if (!ACCOUNT_KEYS.some((key) => Object.hasOwn(body, key))) return null;
  if (!previous) return "all";
  for (const key of ["fallbackStrategy", "stickyRoundRobinLimit"]) {
    if (Object.hasOwn(body, key) && previous[key] !== next?.[key]) return "all";
  }
  if (!Object.hasOwn(body, "providerStrategies")) return null;
  const before = stripMap(previous.providerStrategies);
  const after = stripMap(next?.providerStrategies);
  const changed = new Set(
    [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
      (id) => !isDeepStrictEqual(before[id], after[id]),
    ),
  );
  return changed.size > 0 ? changed : null;
}

/** Whether `body` can affect rotation/pin state (so a caller should fetch `previous`). */
export function touchesRoutingState(body) {
  return [...COMBO_KEYS, ...ACCOUNT_KEYS].some((key) => Object.hasOwn(body, key));
}

/**
 * @param {object} body - The patched keys.
 * @param {object} next - Settings after the write (same namespace as `previous`).
 * @param {object} [previous] - Settings before the write; absent = reset everything in scope.
 * @returns {{ combos: boolean, accounts: "all" | Set<string> | null }}
 *   `accounts` is "all" providers, the listed provider ids, or nothing.
 */
export function planRoutingResets(body, next, previous) {
  return {
    combos: comboStateChanged(body, next, previous),
    accounts: accountScope(body, next, previous),
  };
}
