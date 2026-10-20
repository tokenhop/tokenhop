import { getGatewayDisabled } from "@/lib/auth/gatewayResources.js";
import { getDisabledModelsUnscoped } from "@/lib/db/index.js";
import { PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { getProviderAlias } from "@/shared/constants/providers";

// Same keys /v1/models checks: the provider's alias and its static alias.
// YAN-364: with a principal only that workspace's disabled map is read (never
// the global one); a read error is still fail-open, exactly as before.
// Shared by the chat path and the native Gemini forward (YAN-1062).
export async function isModelDisabled(provider, model, principal = null) {
  let disabled;
  try {
    disabled = principal ? await getGatewayDisabled(principal) : await getDisabledModelsUnscoped();
  } catch {
    return false; // fail open: a DB read error must not block traffic
  }
  const aliases = new Set([getProviderAlias(provider), PROVIDER_ID_TO_ALIAS[provider], provider]);
  for (const alias of aliases) {
    if (alias && Array.isArray(disabled?.[alias]) && disabled[alias].includes(model)) return true;
  }
  return false;
}
