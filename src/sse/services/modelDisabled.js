import { getGatewayDisabled } from "@/lib/auth/gatewayResources.js";
import { getDisabledModelsUnscoped } from "@/lib/db/index.js";
import { errorResponse } from "open-sse/utils/error.js";
import { PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { getProviderAlias } from "@/shared/constants/providers";

// Credential/key-state errors mean the instance state is uncertain (rotation,
// poison, bad marker): never read them as "enabled".
const STATE_ERROR_CODES = new Set([
  "KEY_MISMATCH",
  "CREDENTIAL_STATE_INVALID",
  "CREDENTIAL_MAINTENANCE_POISONED",
  "API_KEY_STATE_INVALID",
]);

// Same keys /v1/models checks: the provider's alias and its static alias.
// YAN-364: with a principal only that workspace's disabled map is read (never
// the global one). A plain DB read error is still fail-open, exactly as before;
// credential/key-state errors propagate (fail closed, see STATE_ERROR_CODES).
// This is a kill switch, so it reads storage LIVE by default; `cached: true`
// opts into the per-request memo and is only for a pass that tolerates a
// request-old answer (a listing), never a dispatch or re-entry check.
// Shared by the chat path and the native Gemini forward (YAN-1062).
export async function isModelDisabled(provider, model, principal = null, { cached = false } = {}) {
  let disabled;
  try {
    disabled = principal
      ? await getGatewayDisabled(principal, { live: !cached })
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

// Explicit per-request-memoized variant (see isModelDisabled).
export const isModelDisabledCached = (provider, model, principal = null) =>
  isModelDisabled(provider, model, principal, { cached: true });

// Dispatch gate for a handler: null to proceed, else the Response to return.
// A disabled model is `onDisabled()` (404); a credential/key-state error fails
// CLOSED with a 503 and no upstream call (never a silent "enabled").
export async function disabledGate(provider, model, principal, onDisabled) {
  try {
    return (await isModelDisabled(provider, model, principal)) ? onDisabled() : null;
  } catch (error) {
    if (!STATE_ERROR_CODES.has(error?.code)) throw error;
    return errorResponse(503, "Credential state unavailable; retry shortly");
  }
}
