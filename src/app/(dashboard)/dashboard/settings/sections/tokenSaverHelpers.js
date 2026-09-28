/**
 * Pure token-saver helpers shared by the Settings section. Locale-aware
 * caveman levels mirror the Token saver page behavior (same constants, no
 * duplicated source of truth).
 */
import { CAVEMAN_LEVELS, PONYTAIL_LEVELS, WENYAN_LOCALES } from "../../endpoint/endpointConstants";

/** Defaults verified against src/lib/db/repos/settingsRepo.js DEFAULT_SETTINGS. */
export const TOKEN_SAVER_DEFAULTS = Object.freeze({
  rtkEnabled: true,
  headroomEnabled: false,
  headroomUrl: "http://localhost:8787",
  headroomTimeoutMs: 3000,
  headroomCompressUserMessages: false,
  cavemanEnabled: false,
  cavemanLevel: "full",
  ponytailEnabled: false,
  ponytailLevel: "full",
  pxpipeEnabled: false,
  pxpipeMinChars: 25000,
  pxpipeTimeoutMs: 15000,
  pxpipeAutoInstall: true,
});

/** Server-side flag on GET /api/settings when HEADROOM_URL env wins. */
export const HEADROOM_ENV_FLAG = "headroomUrlFromEnv";

/**
 * @param {string} locale Current UI locale.
 * @returns {boolean} True when the locale supports 文 (wenyan) levels.
 */
export function isWenyanLocale(locale) {
  return WENYAN_LOCALES.includes(locale);
}

/**
 * Caveman levels selectable in a locale: 文 variants only where supported.
 * @param {string} locale
 * @returns {typeof CAVEMAN_LEVELS}
 */
export function visibleCavemanLevels(locale) {
  return isWenyanLocale(locale) ? CAVEMAN_LEVELS : CAVEMAN_LEVELS.filter((lvl) => !lvl.wenyan);
}

/**
 * A level valid for the locale. Wenyan levels fall back to "ultra" where the
 * locale does not support them (same coercion as the Token saver page);
 * unknown ids fall back to the default.
 * @param {string} locale
 * @param {string} level Stored cavemanLevel.
 * @returns {string} Level id safe to display/select.
 */
export function coerceCavemanLevel(locale, level) {
  const entry = CAVEMAN_LEVELS.find((lvl) => lvl.id === level);
  if (!entry) return TOKEN_SAVER_DEFAULTS.cavemanLevel;
  if (entry.wenyan && !isWenyanLocale(locale)) return "ultra";
  return level;
}

/**
 * @param {string} level Caveman level id.
 * @returns {string} Human description of the level, or "" when unknown.
 */
export function cavemanLevelDescription(level) {
  return CAVEMAN_LEVELS.find((lvl) => lvl.id === level)?.desc ?? "";
}

/**
 * @param {string} level Ponytail level id.
 * @returns {string} Human description of the level, or "" when unknown.
 */
export function ponytailLevelDescription(level) {
  return PONYTAIL_LEVELS.find((lvl) => lvl.id === level)?.desc ?? "";
}

/**
 * @param {string} level Ponytail level id.
 * @returns {string} The id when known, else the default.
 */
export function coercePonytailLevel(level) {
  return PONYTAIL_LEVELS.some((lvl) => lvl.id === level)
    ? level
    : TOKEN_SAVER_DEFAULTS.ponytailLevel;
}

/**
 * True when the server reported that HEADROOM_URL from .env overrides the
 * stored headroomUrl. Absent flag means "no override" — never guessed.
 * @param {object} settings Settings payload from GET /api/settings.
 * @returns {boolean}
 */
export function isHeadroomUrlFromEnv(settings) {
  return settings?.[HEADROOM_ENV_FLAG] === true;
}
