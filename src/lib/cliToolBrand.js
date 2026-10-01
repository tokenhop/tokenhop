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
export const LEGACY_JCODE_API_KEY_ENVS = Object.freeze(
  JCODE_API_KEY_ENV === BRAND.jcodeApiKeyEnv ? [LEGACY.jcodeApiKeyEnv] : [],
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
