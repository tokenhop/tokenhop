const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function overlay(target, source, { skipUndefined }) {
  for (const [key, value] of Object.entries(source || {})) {
    if (skipUndefined && value === undefined) continue;
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
