// YAN-363: rollout may hide unfinished features, never undo established security.
// Read the durable marker every time: imports/restores can change it in-process.
// No DB barrel or migration activation; malformed/unreadable state throws.
import { getAdapter } from "../db/driver.js";
import { readApiKeyStorageState } from "../db/apiKeyState.js";

export async function isHashedSecurityEstablished() {
  return readApiKeyStorageState(await getAdapter()).storage === "hashed";
}

export async function isUserSecurityEnforced() {
  // Validate the marker even with rollout on; malformed state must never bypass.
  if (await isHashedSecurityEstablished()) return true;
  const { isMultiUserEnabled } = await import("./featureSwitch.js");
  return isMultiUserEnabled();
}
