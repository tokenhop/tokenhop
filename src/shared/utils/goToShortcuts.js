// Two-key navigation. A chord expires after 900ms; no key is consumed in an editor or dialog.
export const GO_TO = Object.freeze({
  h: ["Home", "/dashboard"],
  p: ["Providers", "/dashboard/providers"],
  c: ["Combos", "/dashboard/combos"],
  e: ["Endpoint & keys", "/dashboard/endpoint"],
  u: ["Usage", "/dashboard/usage"],
  q: ["Quota", "/dashboard/quota"],
  l: ["Console log", "/dashboard/console-log"],
  s: ["Settings", "/dashboard/settings"],
});

export function matchGoTo(previous, key, now, blocked = false) {
  if (blocked || typeof key !== "string") return { pending: null, href: null, help: false };
  if (key === "?") return { pending: null, href: null, help: true };
  const lower = key.toLowerCase();
  if (previous && now - previous.at < 900 && Object.hasOwn(GO_TO, lower)) {
    return { pending: null, href: GO_TO[lower][1], help: false };
  }
  return { pending: lower === "g" ? { at: now } : null, href: null, help: false };
}
