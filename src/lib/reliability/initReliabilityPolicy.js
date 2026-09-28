// YAN-311: bridge stored reliability settings (src/) into open-sse without
// open-sse importing src/. Fail-open: a missing store keeps previous policy.
import { setReliabilityOverrides } from "open-sse/config/reliabilityPolicy.js";

let bootPromise = null;

/** Read stored reliability slice and inject it into open-sse. */
export async function syncReliabilityPolicy(getSettings) {
  try {
    const settings = await getSettings();
    setReliabilityOverrides(extractReliabilitySlice(settings));
  } catch {
    /* keep previous policy (defaults on a cold start) */
  }
}

/** Pick the reliability slice out of merged settings. */
export function extractReliabilitySlice(settings) {
  const slice = {};
  for (const key of ["retryPolicy", "cooldowns", "backoff", "streamTimeouts"]) {
    if (settings?.[key] !== undefined) slice[key] = settings[key];
  }
  return slice;
}

/** Re-sync after a settings PATCH body was accepted. No-op unless a reliability key changed. */
export function syncReliabilityAfterPatch(body, mergedSettings) {
  if (!body || typeof body !== "object") return;
  if (
    !(
      Object.hasOwn(body, "retryPolicy") ||
      Object.hasOwn(body, "cooldowns") ||
      Object.hasOwn(body, "backoff") ||
      Object.hasOwn(body, "streamTimeouts")
    )
  )
    return;
  setReliabilityOverrides(extractReliabilitySlice(mergedSettings));
}

/** Bootstrap once; concurrent first /v1 requests await the same store read. */
export function ensureReliabilityPolicy(getSettings) {
  bootPromise ??= syncReliabilityPolicy(getSettings);
  return bootPromise;
}

/** Node.js instrumentation entrypoint; the /v1 guard reuses the same promise. */
export async function bootstrapReliabilityPolicy() {
  try {
    const { getSettings } = await import("@/lib/localDb");
    await ensureReliabilityPolicy(getSettings);
  } catch {
    /* keep defaults */
  }
}
