/**
 * Ref-tracked object-URL registry for media playgrounds (YAN-305).
 * A ref object holds the live blob URLs so unmount cleanup revokes the
 * active URLs even though React state is stale inside cleanup closures.
 * Pure and unit-testable: pass any { current } holder plus a revoke function.
 * Lives in shared constants (not route-local) so detail, combo and playground
 * routes can all import it without fragile relative paths.
 */
/**
 * Ref-tracked object-URL registry for the playground (YAN-305 merge-gate #4).
 * A ref object holds the live blob URLs so unmount/kind-switch cleanup revokes
 * the active URLs even though React state is stale inside cleanup closures.
 * Pure and unit-testable: pass any { current } holder plus a revoke function.
 */
export function createObjectUrlRegistry(ref, revoke = (url) => URL.revokeObjectURL(url)) {
  const current = () => ref.current || { image: "", audio: "" };
  const set = (key, next) => {
    const prev = current()[key];
    if (prev && prev !== next) {
      try {
        revoke(prev);
      } catch {}
    }
    ref.current = { ...current(), [key]: next };
  };
  return {
    setImage: (next) => set("image", next),
    setAudio: (next) => set("audio", next),
    clear: () => {
      set("image", "");
      set("audio", "");
    },
    revokeAll: () => {
      for (const url of Object.values(current())) {
        if (url) {
          try {
            revoke(url);
          } catch {}
        }
      }
      ref.current = { image: "", audio: "" };
    },
  };
}
