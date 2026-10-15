/** Parse a JSON body without throwing (empty/HTML error bodies → null). */
export const readJson = (res) => res.json().catch(() => null);

/**
 * Pristine/local fallback when `/api/keys/context` is unavailable (401): the
 * legacy single-admin key flow applies exactly as before. Capabilities are
 * not client-guessed in hashed mode — a 401 context means legacy, every
 * hashed-storage failure surfaces as an error instead of this fallback.
 */
export const LEGACY_CONTEXT = Object.freeze({
  storage: "legacy",
  workspaceId: null,
  canCreate: true,
  canManage: true,
  canCreateService: false,
});

// A failed context never unlocks legacy affordances. Only the pristine-off
// unauthenticated context401 may try the existing legacy API; hashed APIs
// still reject that request, so list errors never lead to provisioning.
export function isConfirmedLegacyStatus(status) {
  return (
    status?.authenticated === true &&
    typeof status.hasPassword === "boolean" &&
    status.userSecurityEnforced !== true &&
    !status.principal
  );
}

/** Auth failure/expired sessions must not be mistaken for pristine local mode. */
export function keyIdentityReady(status) {
  return Boolean(
    (status?.authenticated === true && status?.principal?.user?.id) ||
      (typeof status?.hasPassword === "boolean" &&
        status.userSecurityEnforced !== true &&
        (status.authenticated === true || status.requireLogin === false)),
  );
}

/** Nonsecret identity + permissions fingerprint; independent of rollout switch. */
export function keyIdentity(status) {
  return JSON.stringify([
    status?.authenticated,
    status?.requireLogin,
    status?.hasPassword,
    status?.userSecurityEnforced,
    status?.multiUserActive,
    status?.principal ?? null,
  ]);
}

export async function loadKeyContext(status) {
  if (
    isConfirmedLegacyStatus(status) ||
    (keyIdentityReady(status) && !status?.principal && status?.userSecurityEnforced !== true)
  ) {
    return LEGACY_CONTEXT;
  }
  const workspaceId = status?.principal?.activeWorkspaceId;
  const url = workspaceId
    ? `/api/keys/context?workspaceId=${encodeURIComponent(workspaceId)}`
    : "/api/keys/context";
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 401) return LEGACY_CONTEXT;
  const data = await readJson(res);
  if (!res.ok) throw new Error(data?.error || "Failed to load key permissions.");
  if (
    !data ||
    !["legacy", "hashed"].includes(data.storage) ||
    (data.storage === "hashed" && !data.workspaceId)
  ) {
    throw new Error("Invalid key context response.");
  }
  if (data.storage === "legacy") return LEGACY_CONTEXT;
  return {
    storage: data.storage,
    workspaceId: data.workspaceId,
    canCreate: data.canCreate === true,
    canManage: data.canManage === true,
    canCreateService: data.canCreateService === true,
    // Spec214 durable flag (hashed only): the single notice authority.
    // Absent means unacknowledged; never localStorage.
    migrationAcknowledged: data.migrationAcknowledged === true,
  };
}

/**
 * Manager-only durable dismissal: exact spec214 body, workspace-scoped URL,
 * nonsecret success only. Never optimistic — the caller hides the notice only
 * on success; failures keep it plus the (nonsecret) server error literal.
 * @param {object} context Current hashed key context.
 * @returns {Promise<void>} resolves only on confirmed success.
 */
export async function acknowledgeMigration(context) {
  if (context?.storage !== "hashed" || context.canManage !== true || !context.workspaceId) {
    throw new Error("Only workspace managers can dismiss this notice.");
  }
  const res = await fetch(`/api/keys?workspaceId=${encodeURIComponent(context.workspaceId)}`, {
    method: "PATCH",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ acknowledgeMigration: true }),
  });
  const data = await readJson(res);
  if (
    !res.ok ||
    data?.success !== true ||
    data?.migrationAcknowledged !== true ||
    data?.storage !== "hashed"
  ) {
    throw new Error("Could not dismiss the notice. Try again.");
  }
}

export async function loadKeyList(context) {
  // Viewers (no create, no manage) have nothing to list and the server 403s
  // them: skip the call entirely (no privilege probing). Members with create
  // access list their own user keys; managers list every workspace key.
  if (context.storage === "hashed" && !context.canManage && !context.canCreate) return [];
  const url =
    context.storage === "hashed"
      ? `/api/keys?workspaceId=${encodeURIComponent(context.workspaceId)}`
      : "/api/keys";
  const res = await fetch(url, { cache: "no-store" });
  const data = await readJson(res);
  // A stale context or a mid-flight role change answers 403: nothing this
  // principal may see — render the empty state instead of an error.
  if (context.storage === "hashed" && res.status === 403) return [];
  if (!res.ok) throw new Error(data?.error || "Failed to load API keys.");
  // Never accept hashed metadata through the unauthenticated legacy fallback.
  if (context.storage !== "hashed" && data?.storage === "hashed") {
    throw new Error("Key permissions changed. Reload this page.");
  }
  if (!Array.isArray(data?.keys)) throw new Error("Invalid key list response.");
  return data.keys;
}
