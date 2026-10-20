import { getGatewayDisabled } from "@/lib/auth/gatewayResources.js";
import { getDisabledModelsUnscoped } from "@/lib/db/index.js";
import { PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { getProviderAlias } from "@/shared/constants/providers";

// Same keys /v1/models checks: the provider's alias and its static alias.
// YAN-364: with a principal only that workspace's disabled map is read (never
// the global one). A plain DB read error is still fail-open, exactly as before;
// credential/key-state errors (rotation, poison, bad marker) are NOT "enabled":
// they mean the instance state is uncertain, so they propagate.
// `live: true` skips the per-request memo and reads storage.
// Shared by the chat path and the native Gemini forward (YAN-1062).
const STATE_ERROR_CODES = new Set([
  "KEY_MISMATCH",
  "CREDENTIAL_STATE_INVALID",
  "CREDENTIAL_MAINTENANCE_POISONED",
  "API_KEY_STATE_INVALID",
]);
export async function isModelDisabled(provider, model, principal = null, { live = false } = {}) {
  let disabled;
  try {
    disabled = principal
      ? await getGatewayDisabled(principal, { live })
      : await getDisabledModelsUnscoped();
  } catch (error) {
    if (STATE_ERROR_CODES.has(error?.code)) throw error;
    return false; // fail open: a DB read error must not block traffic
  }
  const aliases = new Set([getProviderAlias(provider), PROVIDER_ID_TO_ALIAS[provider], provider]);
  for (const alias of aliases) {
    if (alias && Array.isArray(disabled?.[alias]) && disabled[alias].includes(model)) return true;
  }
  return false;
}

// Bypasses the per-request memo: the dispatch-time check on every hop and the post-reserve recheck.
export const isModelDisabledLive = (provider, model, principal = null) =>
  isModelDisabled(provider, model, principal, { live: true });
