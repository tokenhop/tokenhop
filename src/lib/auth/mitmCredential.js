// YAN-363 MITM internal credential (auth-side verifier logic).
// Manager (CJS) owns spawn/restart timing + in-memory raw custody; this ESM
// module owns everything durable: verifier install/compare-clear in settings,
// loopback-vs-remote classification, and vetted remote-source selection.
// Raw bearer bytes never touch settings, logs, status, export, or argv here —
// only the SHA-256 verifierHash is persisted. Gateway verifier wiring
// (accepting this credential at the gateway) lands later with gatewayAuth.js.

import { timingSafeEqual } from "node:crypto";
import runtimeCredentials from "../../mitm/runtimeCredentials.js";
import { getAdapter } from "../db/driver.js";
import { readApiKeyStorageState } from "../db/apiKeyState.js";

/** Settings key holding only the local internal credential's verifier hash. */
export const MITM_VERIFIER_SETTING = "mitmInternalVerifier";

/**
 * Operator-managed remote credential sources, read at parent startup and held
 * in parent memory for child restarts. Mutually exclusive: setting both is a
 * configuration error. Never persisted, never browser-selectable.
 */
export const MITM_REMOTE_ENV_VAR = "TOKENHOP_MITM_REMOTE_API_KEY";
export const MITM_REMOTE_FILE_ENV_VAR = "TOKENHOP_MITM_REMOTE_API_KEY_FILE";

const VERIFIER_RE = /^[a-f0-9]{64}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** True for direct-loopback http(s) router URLs eligible for the local credential. */
export function isLocalRouterBaseUrl(raw) {
  try {
    const url = new URL(String(raw ?? "").trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    // URL.hostname keeps IPv6 brackets ("[::1]") — strip before the set lookup.
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return LOOPBACK_HOSTS.has(host);
  } catch {
    return false;
  }
}

/**
 * Vetted remote-source descriptor from trusted process env only.
 * @returns {{type:"env",name:string}|{type:"file",path:string}|null}
 * @throws when both sources are set (mutually exclusive).
 */
export function resolveRemoteSource(env = process.env) {
  const key = env?.[MITM_REMOTE_ENV_VAR];
  const file = env?.[MITM_REMOTE_FILE_ENV_VAR];
  const hasKey = typeof key === "string" && key.length > 0;
  const hasFile = typeof file === "string" && file.length > 0;
  if (hasKey && hasFile) {
    throw new Error(
      `${MITM_REMOTE_ENV_VAR} and ${MITM_REMOTE_FILE_ENV_VAR} are mutually exclusive`,
    );
  }
  if (hasKey) return { type: "env", name: MITM_REMOTE_ENV_VAR };
  if (hasFile) return { type: "file", path: file };
  return null;
}

/** Durable storage state for MITM mode selection (legacy vs hashed). */
export async function readStorageState() {
  return readApiKeyStorageState(await getAdapter());
}

function assertVerifierHash(verifierHash) {
  if (typeof verifierHash !== "string" || !VERIFIER_RE.test(verifierHash)) {
    throw new Error("Invalid MITM verifier");
  }
}

/** Persist only the verifier hash for a freshly spawned local child. */
export async function installLocalVerifier({ updateSettings }, verifierHash) {
  assertVerifierHash(verifierHash);
  await updateSettings({ [MITM_VERIFIER_SETTING]: verifierHash });
}

/**
 * Clear the persisted verifier only when it still matches the failed spawn's
 * hash. Never clears a newer spawn's verifier.
 * @returns {Promise<boolean>} true when a matching verifier was cleared.
 */
export async function clearLocalVerifierIfMatch({ getSettings, updateSettings }, verifierHash) {
  assertVerifierHash(verifierHash);
  const current = (await getSettings())?.[MITM_VERIFIER_SETTING];
  if (typeof current !== "string" || !VERIFIER_RE.test(current)) return false;
  const match = timingSafeEqual(Buffer.from(current, "hex"), Buffer.from(verifierHash, "hex"));
  if (!match) return false;
  await updateSettings({ [MITM_VERIFIER_SETTING]: null });
  return true;
}

/** Timing-safe verifier check (mirrors CJS runtimeCredentials for ESM callers). */
export function matchesLocalVerifier(apiKey, verifierHash) {
  return runtimeCredentials.matchesLocalCredential(apiKey, verifierHash);
}
