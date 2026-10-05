// Map with LRU eviction. Per-workspace rotation keys would otherwise grow
// without bound; evicting a cold cursor only restarts its rotation.
class BoundedMap extends Map {
  constructor(cap) {
    super();
    this.cap = cap;
  }

  get(key) {
    if (!super.has(key)) return undefined;
    const value = super.get(key);
    super.delete(key);
    super.set(key, value);
    return value;
  }

  set(key, value) {
    super.delete(key);
    super.set(key, value);
    if (this.size > this.cap) super.delete(this.keys().next().value);
    return this;
  }
}

export function boundedMap(cap) {
  return new BoundedMap(cap);
}
