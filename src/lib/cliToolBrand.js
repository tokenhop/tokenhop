// Names the dashboard writes into users' CLI-tool configs, and the legacy ones
// it still recognises. Pure (no fs) so routes and setup cards share it.
import { ACTIVE, BRAND, LEGACY } from "@/shared/brand";

/** Provider/profile key Apply writes, e.g. `[model_providers.<key>]`. */
export const CLIENT_KEY = ACTIVE.clientConfigKey;
/** Display name written next to the key. */
export const CLIENT_NAME = ACTIVE.name;
export const JCODE_API_KEY_ENV = ACTIVE.jcodeApiKeyEnv;

// legacy(9router): remove in v2 — Apply migrates these only under the tokenhop
// brand; the default brand keeps writing exactly what it wrote before.
export const LEGACY_CLIENT_KEYS = Object.freeze(
  CLIENT_KEY === BRAND.clientConfigKey ? [...LEGACY.clientConfigKeys] : [],
);

/** Every key detect and Reset accept, active key first. */
export const ALL_CLIENT_KEYS = Object.freeze([
  ...new Set([CLIENT_KEY, BRAND.clientConfigKey, ...LEGACY.clientConfigKeys]),
]);
export const ALL_JCODE_API_KEY_ENVS = Object.freeze([
  ...new Set([JCODE_API_KEY_ENV, BRAND.jcodeApiKeyEnv, LEGACY.jcodeApiKeyEnv]),
]);

export const isClientKey = (value) => ALL_CLIENT_KEYS.includes(value);

/** Our entry in a key→entry map, preferring the active key. */
export const findClientEntry = (map) => {
  for (const key of ALL_CLIENT_KEYS) if (map?.[key] != null) return map[key];
  return undefined;
};

/** `<key>/<model>` reference Apply writes, e.g. OpenCode's `model`. */
export const modelRef = (model) => `${CLIENT_KEY}/${model}`;

/** `{ key, model }` when value is `<our key>/<model>` under any known key, else null. */
export const splitModelRef = (value) => {
  if (typeof value !== "string") return null;
  const slash = value.indexOf("/");
  if (slash <= 0) return null;
  const key = value.slice(0, slash);
  return isClientKey(key) ? { key, model: value.slice(slash + 1) } : null;
};

/** True when value is a model reference under a key Apply migrates (tokenhop brand only). */
export const isLegacyModelRef = (value) => LEGACY_CLIENT_KEYS.includes(splitModelRef(value)?.key);

/** The same model under our active key; anything else unchanged. */
export const repointModelRef = (value) =>
  isLegacyModelRef(value) ? modelRef(splitModelRef(value).model) : value;

/** True when a base URL names any known key (e.g. a reverse-proxy path). */
export const urlNamesClient = (url) =>
  typeof url === "string" && ALL_CLIENT_KEYS.some((key) => url.includes(key));

/** Droid-style custom model ids: `<prefix><index>`. */
export const CUSTOM_MODEL_ID_PREFIX = ACTIVE.customModelIdPrefix;
const ALL_CUSTOM_MODEL_ID_PREFIXES = [
  ...new Set([CUSTOM_MODEL_ID_PREFIX, BRAND.customModelIdPrefix, LEGACY.customModelIdPrefix]),
];
// legacy(9router): remove in v2 — migrated on Apply only under the tokenhop brand.
const LEGACY_CUSTOM_MODEL_ID_PREFIXES =
  CUSTOM_MODEL_ID_PREFIX === BRAND.customModelIdPrefix ? [LEGACY.customModelIdPrefix] : [];

/** Ours under any brand (detect and Reset). */
export const isCustomModelId = (id) =>
  typeof id === "string" && ALL_CUSTOM_MODEL_ID_PREFIXES.some((p) => id.startsWith(p));
/** Ours under the active brand, or a legacy id Apply replaces. */
export const isOwnedCustomModelId = (id) =>
  typeof id === "string" &&
  [CUSTOM_MODEL_ID_PREFIX, ...LEGACY_CUSTOM_MODEL_ID_PREFIXES].some((p) => id.startsWith(p));

/** Remove legacy entries from the key→entry object; returns the first one found. */
export const takeLegacyEntry = (map) => {
  let found;
  for (const key of LEGACY_CLIENT_KEYS) {
    if (map?.[key] == null) continue;
    found ??= map[key];
    delete map[key];
  }
  return found;
};
