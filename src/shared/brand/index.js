// ESM entry for the brand module; the values live in index.cjs.
import brand from "./index.cjs";

export const {
  BRAND_IDS,
  DEFAULT_BRAND_ID,
  ACTIVE_BRAND_ID,
  isActiveBrand,
  BRAND,
  LEGACY,
  ACTIVE,
  UPSTREAM_CLIENT_IDS,
  envName,
  readEnv,
  warnLegacyOnce,
  header,
  legacyHeaderNames,
} = brand;
