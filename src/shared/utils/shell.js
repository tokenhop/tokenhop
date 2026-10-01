/**
 * YAN-396 shell helpers (Signal redesign, M7 Polish): nav badge tint, version
 * chip, user row and language button labels. Pure: no React or DOM.
 */

import { LOCALE_NAMES } from "@/i18n/config";

/**
 * Tint for a nav badge. Missing (not yet loaded) or zero counts return null so
 * the badge stays hidden instead of flashing a fake 0. Low quota is warn;
 * providers that need attention take the worst provider status.
 * @param {string} badgeKey
 * @param {number|null|undefined} count
 * @param {"warn"|"err"|null} [attention] Worst needs-attention status for the item.
 * @returns {"neutral"|"warn"|"err"|null}
 */
export function badgeTint(badgeKey, count, attention = null) {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return null;
  if (badgeKey === "quota") return "warn";
  if (attention === "warn" || attention === "err") return attention;
  return "neutral";
}

const SHORT_SHA_LENGTH = 7;

/**
 * One-line version chip: "0.4.0-beta.7" → "v0.4.0 β7". The full version goes
 * in the tooltip and the Change log menu entry.
 *
 * An unreleased build (the rolling `:dev` image) carries a build channel and
 * commit, so the chip shows those rather than a package version the build was
 * never released as: "dev 27bed71", full "v0.6.0+dev.27bed71".
 * @param {string} version
 * @param {{ channel?: string, sha?: string }} [build] From the image build args.
 * @returns {{ label: string, full: string }}
 */
export function resolveVersionChip(version, build = {}) {
  const raw = typeof version === "string" ? version.trim() : "";
  const channel = typeof build.channel === "string" ? build.channel.trim() : "";
  const sha = typeof build.sha === "string" ? build.sha.trim().slice(0, SHORT_SHA_LENGTH) : "";
  if (channel) {
    const label = sha ? `${channel} ${sha}` : channel;
    const metadata = sha ? `${channel}.${sha}` : channel;
    return { label, full: raw ? `v${raw}+${metadata}` : label };
  }
  const match = raw.match(/^(\d+\.\d+\.\d+)-beta\.(\d+)$/);
  if (!raw) return { label: "", full: "" };
  return { label: match ? `v${match[1]} β${match[2]}` : `v${raw}`, full: `v${raw}` };
}

// Placeholders /api/auth/status returns when there is no real name.
const GENERIC_NAMES = new Set(["password user", "oidc user", "saml user"]);

/**
 * Sidebar user row from an /api/auth/status payload: the real SSO or display
 * name, else "Admin", with the auth method as the subtitle.
 * @param {object} [status]
 * @returns {{ name: string, sub: string }}
 */
export function resolveUserRow(status = {}) {
  const candidates = [
    status.samlName,
    status.samlEmail,
    status.oidcName,
    status.oidcEmail,
    status.displayName,
  ];
  const name =
    candidates
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .find((value) => value && !GENERIC_NAMES.has(value.toLowerCase())) || "Admin";
  const sso = status.loginMethod === "OIDC" || status.loginMethod === "SAML";
  const sub = sso ? "SSO" : status.requireLogin === false ? "No login required" : "Password";
  return { name, sub };
}

/**
 * Header language button: short locale code chip and the accessible name,
 * e.g. "EN" and "Language: English".
 * @param {string} locale
 * @returns {{ code: string, label: string }}
 */
export function languageButtonLabel(locale) {
  const id = typeof locale === "string" && locale ? locale : "en";
  return {
    code: id.split("-")[0].toUpperCase(),
    label: `Language: ${LOCALE_NAMES[id] || id}`,
  };
}
