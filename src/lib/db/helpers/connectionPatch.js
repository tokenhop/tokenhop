// Pure patch rules for connection create/update (no db access).
const MODEL_LOCK_PREFIX = "modelLock_";
// YAN-1049 quota-lock ownership metadata (`modelLockMeta_<key>`), cleared with its lock.
const MODEL_LOCK_META_PREFIX = "modelLockMeta_";
const REAUTH_HEALTH_KEYS = ["testStatus", "lastError", "lastErrorAt", "lastErrorType", "errorCode"];

export function resetHealthStateOnActivation(existing, patch) {
  if (patch?.testStatus !== "active") return patch;

  const normalized = {
    ...patch,
    testStatus: "active",
    lastError: Object.hasOwn(patch, "lastError") ? patch.lastError : null,
    lastErrorAt: Object.hasOwn(patch, "lastErrorAt") ? patch.lastErrorAt : null,
    errorCode: null,
    rateLimitedUntil: null,
    backoffLevel: 0,
  };

  for (const key of Object.keys(existing || {})) {
    if (key.startsWith(MODEL_LOCK_PREFIX) || key.startsWith(MODEL_LOCK_META_PREFIX)) {
      normalized[key] = null;
    }
  }

  return normalized;
}

/**
 * YAN-1038 (D9): `reauthRequired` clears only when the credential itself is
 * replaced (a patch carrying a refresh/access token that differs from the live
 * one: OAuth re-login upsert, bulk re-import, any refresh persist). Any other
 * patch (clearAccountError, a passing Test) keeps the flag AND the flagged health
 * fields, otherwise one success on a still-valid access token would restart the loop.
 */
export function clearReauthOnCredentialReplace(existing, patch) {
  if (!existing?.reauthRequired || !patch) return patch;
  const replaced = ["refreshToken", "accessToken"].some(
    (k) => typeof patch[k] === "string" && patch[k] && patch[k] !== existing[k],
  );
  if (!replaced) {
    // Not a credential replacement: a passing Test or a successful request must not
    // turn the flagged row healthy, so drop every health-state write from the patch.
    const kept = { ...patch };
    for (const key of REAUTH_HEALTH_KEYS) delete kept[key];
    return kept;
  }
  return {
    ...patch,
    reauthRequired: null,
    lastErrorType: null,
    errorCode: null,
    lastError: Object.hasOwn(patch, "lastError") ? patch.lastError : null,
    lastErrorAt: Object.hasOwn(patch, "lastErrorAt") ? patch.lastErrorAt : null,
    testStatus: patch.testStatus ?? "active",
  };
}

export function deriveConnectionName(data, fallbackName) {
  if (data.provider === "github") {
    return (
      data.providerSpecificData?.githubLogin ||
      data.providerSpecificData?.githubEmail ||
      data.email ||
      data.providerSpecificData?.githubName ||
      fallbackName
    );
  }
  return fallbackName;
}

// OAuth re-login: fresh token metadata wins, but omitted fields (proxy etc.) and
// user-set weighted overrides (weight, manual planTier) survive.
export function mergeReloginProviderData(previous, fresh, provider) {
  if (!previous && !fresh) return undefined;
  const merged = { ...(previous || {}), ...(fresh || {}) };
  if (previous && Object.hasOwn(previous, "weight")) merged.weight = previous.weight;
  // Cursor machineId is a device fingerprint: keep it stable across re-logins so
  // an IDE id captured at import survives a browser re-login (which mints a random
  // one). A fresh import carries the real IDE id, so it still wins.
  if (
    provider === "cursor" &&
    typeof previous?.machineId === "string" &&
    previous.machineId.trim() &&
    fresh?.authMethod !== "imported"
  ) {
    merged.machineId = previous.machineId;
  }
  if (previous?.planTierManual === true) {
    merged.planTier = previous.planTier;
    merged.planTierManual = true;
  } else if (previous && !Object.hasOwn(fresh || {}, "planTier")) {
    delete merged.planTier;
    delete merged.planTierCheckedAt;
  }
  return merged;
}

// YAN-365: patch.providerSpecificData is a DELTA. Siblings always come from
// the live decrypted row inside the same transaction — never from a caller's
// stale snapshot. An explicit null clears the whole object.
export function applyPsdDelta(merged, existing, normalized) {
  if (!Object.hasOwn(normalized || {}, "providerSpecificData")) return;
  const patchPsd = normalized.providerSpecificData;
  if (patchPsd === null || patchPsd === undefined) {
    merged.providerSpecificData = patchPsd;
    return;
  }
  const next = { ...(existing.providerSpecificData || {}), ...patchPsd };
  // A null leaf in the delta clears that live key (explicit-clear semantics).
  for (const [key, value] of Object.entries(patchPsd)) if (value === null) delete next[key];
  merged.providerSpecificData = next;
}
