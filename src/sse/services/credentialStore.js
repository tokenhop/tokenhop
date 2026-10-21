// YAN-1037/1038: src-side implementation of the open-sse CredentialStore hook
// (open-sse/services/credentialStore.js). Installed once at startup from
// src/instrumentation.js; never as an import side effect, so tests that mock
// "@/lib/localDb" do not get a real store.
//
// Every write is a conditional read-decide-write on the LIVE decrypted row inside
// one SQLite transaction (mutateProviderConnectionUnscoped): a slow request can
// never overwrite a newer re-auth, nor flag a re-authed row.
import { getProviderConnectionByIdUnscoped, mutateProviderConnectionUnscoped } from "@/lib/localDb";
import { setCredentialStore } from "open-sse/services/credentialStore.js";
import { buildReauthPatch, getReauthRequired } from "open-sse/services/reauthState.js";
import { buildCredentialUpdates } from "./tokenRefresh.js";

// Only these are ever persisted by a refresh. providerSpecificData is excluded on
// purpose: the in-request snapshot carries resolved proxy fields (YAN-365 delta).
const REFRESH_FIELDS = [
  "accessToken",
  "refreshToken",
  "idToken",
  "expiresAt",
  "expiresIn",
  "lastRefreshAt",
];

function pick(source) {
  const out = {};
  for (const key of REFRESH_FIELDS) {
    if (source?.[key] !== undefined && source[key] !== null) out[key] = source[key];
  }
  return out;
}

// Only what open-sse reads from the stored row for the lifetime cap
// (getObservedLifetimeMs / getCredentialLastRefreshMs). Nothing else leaves the repo:
// providerSpecificData also carries proxy and account settings.
const LIFETIME_PSD_KEYS = ["observedLifetimeMs", "observedLifetimeAt", "lastRefreshAt"];

function pickLifetimeData(psd) {
  const out = {};
  for (const key of LIFETIME_PSD_KEYS) {
    if (psd?.[key] !== undefined && psd[key] !== null) out[key] = psd[key];
  }
  return out;
}

async function load(connectionId) {
  const live = await getProviderConnectionByIdUnscoped(connectionId);
  if (!live) return null;
  return {
    ...pick(live),
    providerSpecificData: pickLifetimeData(live.providerSpecificData),
    reauthRequired: live.reauthRequired ?? null,
  };
}

async function persistRefresh(connectionId, { expectedRefreshToken, credentials } = {}) {
  const incoming = pick(credentials);
  if (!incoming.accessToken && !incoming.refreshToken) return { applied: false };
  const { applied } = await mutateProviderConnectionUnscoped(connectionId, (live) => {
    // Apply only while the live RT is still the redeemed one, or already the new one.
    const liveRt = live.refreshToken;
    if (liveRt !== expectedRefreshToken && liveRt !== credentials?.refreshToken) return null;
    return buildCredentialUpdates(incoming);
  });
  return { applied };
}

async function markReauthRequired(
  connectionId,
  { expectedRefreshToken, expectedAccessToken, reauthRequired } = {},
) {
  // Without an expected token there is nothing to guard the write with.
  if (!reauthRequired || (!expectedRefreshToken && !expectedAccessToken)) {
    return { applied: false };
  }
  const { applied } = await mutateProviderConnectionUnscoped(connectionId, (live) => {
    if (getReauthRequired(live)) return null;
    if (expectedRefreshToken && live.refreshToken !== expectedRefreshToken) return null;
    if (expectedAccessToken && live.accessToken !== expectedAccessToken) return null;
    return buildReauthPatch(reauthRequired);
  });
  return { applied };
}

export function installCredentialStore() {
  setCredentialStore({ load, persistRefresh, markReauthRequired });
}
