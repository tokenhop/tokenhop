/**
 * Pure helpers for the admin pages (YAN-373). No React or DOM: pill mappers,
 * invitation URL building and the server-error view
 * model, all unit-tested in tests/unit/admin-view.test.js.
 */

import { translate } from "@/i18n/runtime";

/** Instance role → StatusPill variant. Sky = info roles, per the design system. */
export const ROLE_VARIANTS = {
  owner: "info",
  admin: "info",
  user: "neutral",
  pending: "warn",
};

/** Instance status → variant; unknown falls back to neutral. */
export function statusVariant(status) {
  if (status === "active") return "ok";
  if (status === "disabled") return "neutral";
  return "neutral";
}

/** Invitation state → variant. */
export const INVITE_VARIANTS = {
  live: "ok",
  consumed: "neutral",
  revoked: "neutral",
  expired: "warn",
};

export const ROLE_LABELS = {
  owner: () => translate("Owner"),
  admin: () => translate("Admin"),
  user: () => translate("User"),
  pending: () => translate("Pending approval"),
};

export function roleLabel(role) {
  return ROLE_LABELS[role] ? ROLE_LABELS[role]() : String(role ?? "");
}

export function formatWhen(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

export function userSummary(user) {
  return user?.displayName || user?.username || user?.email || translate("User");
}

/**
 * Server response → page state. No client authorization logic: the text comes
 * from the HTTP status the server chose (404 hidden, 403 denied).
 * @param {number} status
 * @returns {"hidden"|"denied"|"error"|null}
 */
export function adminLoadState(status) {
  if (status === 404) return "hidden";
  if (status === 403) return "denied";
  return status ? "error" : null;
}

/**
 * Full-acceptance copy for the two terminal load states.
 * @param {"hidden"|"denied"} state
 * @returns {{ title: string, body: string }}
 */
export function adminLoadCopy(state) {
  if (state === "hidden") {
    return {
      title: "Not available",
      body: "Users & teams is switched off on this instance.",
    };
  }
  return {
    title: "No access",
    body: "Only instance owners and admins can manage users and workspaces.",
  };
}

/** Password inputs type a fresh temporary password; 16 readable base32 chars. */
const PW_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function suggestPassword() {
  let out = "";
  const random = new Uint32Array(16);
  crypto.getRandomValues(random);
  for (let i = 0; i < random.length; i += 1) out += PW_ALPHABET[random[i] % PW_ALPHABET.length];
  return out;
}
