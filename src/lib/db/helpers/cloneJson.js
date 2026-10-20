// Fresh deep copy of JSON-shaped data (settings blobs, defaults). Roughly 3x
// cheaper than structuredClone for plain objects/arrays, which matters on the
// per-request settings path. Anything that is not plain JSON (Date, Map, Buffer,
// class instances) is delegated to structuredClone so the result stays identical
// to the old clone for unusual stored values.

const isPlainObject = (v) => {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

export function cloneJson(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = cloneJson(value[i]);
    return out;
  }
  if (!isPlainObject(value)) return structuredClone(value);
  const out = {};
  for (const key of Object.keys(value)) {
    // A stored own "__proto__" key must stay an own data property, never a prototype set.
    if (key === "__proto__") {
      Object.defineProperty(out, key, {
        value: cloneJson(value[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else {
      out[key] = cloneJson(value[key]);
    }
  }
  return out;
}

/**
 * Object.assign without the prototype hazard: a source own "__proto__" key would
 * run the __proto__ setter and swap the target's prototype. Every own enumerable
 * key becomes an own data property instead. Mutates and returns `target`.
 */
export function assignOwnData(target, source) {
  for (const key of Object.keys(source)) {
    Object.defineProperty(target, key, {
      value: source[key],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return target;
}
