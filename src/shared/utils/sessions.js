/**
 * Pure helpers for the My account → Sessions card (YAN-751). Kept out of the
 * component so the node-environment unit tests can cover them.
 */

const METHOD_LABELS = { pwd: "Password", password: "Password", oidc: "OIDC", saml: "SAML" };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const time = (iso) => {
  const t = Date.parse(iso ?? "");
  return Number.isNaN(t) ? 0 : t;
};

/** When the session was last used; `lastSeenAt` is null until the first touch. */
export const lastActiveAt = (session) => session?.lastSeenAt || session?.createdAt || null;

/**
 * Current device first, then most recently active, then newest sign-in, then
 * id, so the order never depends on the API's order. Returns a new array.
 * @param {object[]} sessions
 */
export function sortSessions(sessions) {
  return [...(sessions || [])].sort(
    (a, b) =>
      Number(Boolean(b.current)) - Number(Boolean(a.current)) ||
      time(lastActiveAt(b)) - time(lastActiveAt(a)) ||
      time(b.createdAt) - time(a.createdAt) ||
      String(a.id).localeCompare(String(b.id)),
  );
}

/**
 * Coarse "last active" text. Activity is recorded at most every 5 minutes,
 * so anything under that reads "Active now" and nothing claims seconds.
 * @param {string|null} iso
 * @param {number} [now]
 */
export function formatLastActive(iso, now = Date.now()) {
  const t = time(iso);
  if (!t) return "Active recently";
  const diff = Math.max(0, now - t);
  if (diff < 5 * MINUTE) return "Active now";
  if (diff < HOUR) return `Active ${Math.floor(diff / MINUTE)} min ago`;
  if (diff < 24 * HOUR) return `Active ${Math.floor(diff / HOUR)} h ago`;
  return `Active ${new Date(t).toLocaleDateString()}`;
}

/** Absolute local date/time for titles and "Signed in …". */
export function formatSessionDate(iso) {
  const t = time(iso);
  return t ? new Date(t).toLocaleString() : "";
}

/** Badge label for the sign-in method (`amr`), or null when unknown. */
export const methodLabel = (method) => (method ? METHOD_LABELS[method] || null : null);

/** Material Symbols icon for a server-built label like "Safari on iOS". */
export const deviceIcon = (device) =>
  / on (iOS|Android)$/.test(device || "") ? "smartphone" : "computer";
