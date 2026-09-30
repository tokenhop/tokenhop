"use strict";

/**
 * Brand switch: decides whether this build is 9router or tokenhop.
 *
 * Dependency-free CommonJS so the Next.js server and client bundles, open-sse/
 * and the CLI can all load it. `index.js` is the ESM entry.
 *
 * `NEXT_PUBLIC_BRAND` is a dev/CI-only override. Next.js inlines it into bundles
 * at build time, so keep the literal `process.env.NEXT_PUBLIC_BRAND` expression
 * (no destructuring) or the inlining stops working. Server code and the CLI read
 * it at runtime. The v1.0.0 release flips DEFAULT_BRAND_ID to "tokenhop".
 */

const BRAND_IDS = Object.freeze(["9router", "tokenhop"]);
const DEFAULT_BRAND_ID = "9router";

function assertBrandId(id, source) {
  if (BRAND_IDS.includes(id)) return id;
  const allowed = BRAND_IDS.map((b) => `"${b}"`).join(", ");
  throw new Error(`${source}: unknown brand ${JSON.stringify(id)}; allowed values: ${allowed}`);
}

function resolveActiveBrandId(value) {
  // Empty counts as unset, the way .env files and Compose pass "NAME=".
  if (value === undefined || value === "") return DEFAULT_BRAND_ID;
  return assertBrandId(value, "NEXT_PUBLIC_BRAND");
}

const ACTIVE_BRAND_ID = resolveActiveBrandId(process.env.NEXT_PUBLIC_BRAND);

function isActiveBrand(id) {
  return assertBrandId(id, "isActiveBrand") === ACTIVE_BRAND_ID;
}

module.exports = { BRAND_IDS, DEFAULT_BRAND_ID, ACTIVE_BRAND_ID, isActiveBrand };
