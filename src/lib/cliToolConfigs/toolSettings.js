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

// Map key order is irrelevant (saved vs disk maps are built in different orders).
const stable = (v) => JSON.stringify(isPlain(v) ? Object.fromEntries(Object.entries(v).sort()) : v);

/** Top-level keys where the saved value differs from a defined on-disk value. */
export function diffFromDisk(saved, disk) {
  if (!disk || !saved) return [];
  return Object.keys(saved).filter(
    (key) =>
      Object.hasOwn(disk, key) &&
      disk[key] !== undefined &&
      stable(saved[key]) !== stable(disk[key]),
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

const isFlatList = (v) => Array.isArray(v) && v.length <= MAX_KEYS && v.every(isScalar);

// One list item (e.g. a Cowork plugin): scalars and flat scalar lists only.
const isFlatObject = (v) =>
  isPlain(v) && validKeys(v) && Object.values(v).every((x) => isScalar(x) || isFlatList(x));

/**
 * Saved settings shape: a plain object of scalars, flat arrays of scalars
 * (e.g. model lists), arrays of flat objects (e.g. Cowork plugins), or one
 * nested plain object of scalars (e.g. `models`).
 * Signed-in remote users can write it and Apply later reads it on the host,
 * so anything else is rejected.
 */
export function isValidToolSettings(value) {
  if (!isPlain(value) || !validKeys(value)) return false;
  return Object.values(value).every(
    (v) =>
      isScalar(v) ||
      isFlatList(v) ||
      (Array.isArray(v) && v.length <= MAX_KEYS && v.every(isFlatObject)) ||
      (isPlain(v) && validKeys(v) && Object.values(v).every(isScalar)),
  );
}

// ─── YAN-363 hashed-mode credential containment (pure; repo passes context) ───
// Known credential slot names used by the actual card clients. Only these are
// treated as secrets; every other preference passes through untouched.
const SECRET_SLOTS = ["apiKey", "api_key"];

const reject = () => {
  throw Object.assign(new Error("Credential setting rejected; values withheld"), { status: 400 });
};

/**
 * Canonicalize one credential-slot value against hashed storage.
 * - raw string matching an HMAC'd row (any isActive/revoked state) → `{ apiKeyId }`
 * - `{ apiKeyId }` ref → live authorization re-checked via `context.ref`
 * - `{ external: true, externalRef }` round-trip marker → stored raw preserved
 *   byte-for-byte when the ref matches the stored value (same binding only)
 * - unknown raw on write → rejected before mutation (no raw stash)
 * - unknown raw on read (redact) → opaque external marker, raw never leaves
 */
function containSlot(value, prev, context, redact) {
  if (isPlain(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof value.apiKeyId === "string") {
      context.ref(value.apiKeyId); // throws 403 unless authorized in its workspace
      return value;
    }
    if (
      keys.length === 2 &&
      value.external === true &&
      typeof value.externalRef === "string" &&
      typeof prev === "string" &&
      context.hash(`cli-tool-setting:${prev}`) === value.externalRef
    ) {
      return prev; // same destination binding: keep stored external bytes
    }
    reject();
  }
  if (typeof value === "string") {
    const row = context.rawRow(value);
    if (row && context.authorized(row)) return { apiKeyId: row.id };
    if (redact) return { external: true, externalRef: context.hash(`cli-tool-setting:${value}`) };
    reject(); // unknown or foreign raw: no stash, no foreign ref leak
  }
  reject();
}

/**
 * Contain credential slots of a tool-settings object in hashed mode.
 * Omitted secret slots preserve the stored value (a redacted GET→PUT round
 * trip must not erase credentials); non-secret preferences pass through.
 * `context` is the repo-built credential context; null disables containment.
 */
export function containToolSettings(values, old, context, redact = false) {
  if (!isPlain(values) || !context) return values;
  const out = { ...values };
  for (const slot of SECRET_SLOTS) {
    const prev = isPlain(old) ? old[slot] : undefined;
    if (!Object.hasOwn(out, slot)) {
      if (prev !== undefined) out[slot] = prev; // caller cannot delete what it cannot see
      continue;
    }
    out[slot] = containSlot(out[slot], prev, context, redact);
  }
  return out;
}
