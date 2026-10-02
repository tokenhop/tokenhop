const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function overlay(target, source, { skipUndefined }) {
  for (const [key, value] of Object.entries(source || {})) {
    if (skipUndefined && value === undefined) continue;
    if (BLOCKED_KEYS.has(key)) continue;
    // ponytail: merges one level deep only; deeper nesting is replaced whole.
    if (isPlain(value) && isPlain(target[key])) {
      const next = { ...target[key] };
      for (const [k, v] of Object.entries(value)) {
        if (v !== undefined) next[k] = v;
      }
      target[key] = next;
    } else {
      target[key] = value;
    }
  }
}

/**
 * Settings precedence: defaults < on-disk (defined fields) < saved.
 * Plain-object fields (e.g. `models`) merge one level deep.
 */
export function mergeToolSettings(defaults, disk, saved) {
  const out = {};
  overlay(out, defaults, { skipUndefined: false });
  overlay(out, disk, { skipUndefined: true });
  overlay(out, saved, { skipUndefined: false });
  return out;
}

/** Top-level keys where the saved value differs from a defined on-disk value. */
export function diffFromDisk(saved, disk) {
  if (!disk || !saved) return [];
  return Object.keys(saved).filter(
    (key) =>
      Object.hasOwn(disk, key) &&
      disk[key] !== undefined &&
      JSON.stringify(saved[key]) !== JSON.stringify(disk[key]),
  );
}

const MAX_KEYS = 64;
const MAX_STRING = 2048;

const isScalar = (v) =>
  (typeof v === "string" && v.length <= MAX_STRING) ||
  typeof v === "boolean" ||
  (typeof v === "number" && Number.isFinite(v));

const validKeys = (obj) =>
  Object.keys(obj).length <= MAX_KEYS &&
  Object.keys(obj).every((k) => k.length <= 128 && !BLOCKED_KEYS.has(k));

/**
 * Saved settings shape: a plain object of scalars, or of one nested plain
 * object of scalars (e.g. `models`). Signed-in remote users can write it and
 * Apply later reads it on the host, so anything else is rejected.
 */
export function isValidToolSettings(value) {
  if (!isPlain(value) || !validKeys(value)) return false;
  return Object.values(value).every(
    (v) => isScalar(v) || (isPlain(v) && validKeys(v) && Object.values(v).every(isScalar)),
  );
}
