// Recursively freeze plain data in place and return it. Freezing is IN PLACE and
// permanent, so only call it on objects the caller owns (a fresh read, or a
// private clone): freezing a module-level or otherwise shared object would turn
// every other holder's writes into silent no-ops (TypeError in strict mode).
//
// Already-frozen values are skipped, which also terminates cycles. ArrayBuffer
// views (Buffer, typed arrays) are left alone: Object.freeze throws on non-empty
// ones, and they are not config data.
export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value) && !ArrayBuffer.isView(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
