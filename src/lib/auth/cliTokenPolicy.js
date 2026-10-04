// CLI bearer acceptance (YAN-363 extraction; single authority).
// The machine-bound CLI token acts as the owner while single-user; with >1
// active user only from a proven loopback peer with no proxy hop. The durable
// hashed-storage marker pins that stricter posture: a migrated install never
// relaxes peer enforcement, even when the rollout switch later reads off.
// Pristine off (no marker, switch off) keeps today's behavior exactly.
// No session/DB-barrel imports: this stays below both, so the gateway
// resolver can use it without a cycle.
import { hasValidCliToken } from "./cliToken.js";
import { isLoopbackPeer } from "./trustedPeer.js";

/** Marker read with fail-closed semantics: unreadable ⇒ enforce, invalid ⇒ throw. */
async function hashedStorageActive() {
  const { getAdapter } = await import("../db/driver.js");
  const { readApiKeyStorageState } = await import("../db/apiKeyState.js");
  return readApiKeyStorageState(await getAdapter()).storage === "hashed";
}

/**
 * @param {{ headers: Headers }} request
 * @param {{ multiUserOn: () => Promise<boolean>|boolean, activeUserCount: () => Promise<number>|number, hashedStorage?: () => Promise<boolean> }} deps
 *   `hashedStorage` defaults to the durable `_meta` marker read above.
 */
export async function cliTokenAcceptedWith(
  request,
  { multiUserOn, activeUserCount, hashedStorage = hashedStorageActive },
) {
  if (!(await hasValidCliToken(request))) return false;
  if (!(await multiUserOn())) {
    try {
      if (!(await hashedStorage())) return true; // pristine off: today's behavior
    } catch (err) {
      if (err?.code === "API_KEY_STATE_INVALID") throw err;
      // Unreadable marker: cannot prove pristine; fall through to enforcement,
      // which itself fails closed on a broken DB.
    }
  }
  try {
    if ((await activeUserCount()) <= 1) return true;
  } catch {
    return false;
  }
  return !request.headers.get("x-9r-via-proxy") && isLoopbackPeer(request);
}
