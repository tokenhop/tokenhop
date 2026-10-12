// YAN-373: fetch helpers for the policy PATCH and the SSO draft preview.
// Errors carry `.status` and `.code` like the adminApi helpers. Nothing here
// stores or logs preview data.

export const PREVIEW_BODY_LIMIT = 8192;

/** Shown when the IdP round trip fails (callback redirects with ?ssoPreview=failed). */
export const PREVIEW_FAILED_MESSAGE =
  "Your provider did not confirm a fresh sign-in, so there is no preview. Try another preview; starting a new check cancels any earlier one.";

function toError(res, data, fallback) {
  const raw = data?.error;
  const message = typeof raw === "string" ? raw : raw?.message;
  const err = new Error(message || `${fallback} (${res.status})`);
  err.status = res.status;
  err.code = data?.code || (typeof raw === "object" ? raw?.code : undefined);
  return err;
}

/** PATCH the six policy keys. */
export async function patchSsoPolicy(payload) {
  const res = await fetch("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw toError(res, data, "Request failed");
  return data;
}

/** Accept only an absolute http(s) URL; anything else is a server bug or attack. */
export function safeAuthorizeUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error("The server returned an invalid sign-in URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("The server returned an invalid sign-in URL.");
  }
  return url.toString();
}

/**
 * POST the unsaved draft policy for the chosen provider. The server pairs it
 * with the SAVED protocol config and answers with the IdP authorize URL.
 * @returns {Promise<string>} validated authorize URL
 */
export async function startSsoPreview(provider, policy) {
  const body = JSON.stringify({ provider, policy });
  if (new TextEncoder().encode(body).length > PREVIEW_BODY_LIMIT) {
    throw new Error(`This draft is too large to preview (limit ${PREVIEW_BODY_LIMIT} bytes).`);
  }
  const res = await fetch("/api/auth/sso/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw toError(res, data, "Preview failed");
  return safeAuthorizeUrl(data.authorizeUrl);
}

/** Read the one-shot preview result after the IdP callback. */
export async function fetchSsoPreviewResult() {
  const res = await fetch("/api/auth/sso/preview", { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw toError(res, data, "Request failed");
  return {
    provider: data.provider,
    groupsSource: data.groupsSource,
    groups: Array.isArray(data.groups) ? data.groups : [],
    totalGroups: Number.isFinite(data.totalGroups) ? data.totalGroups : 0,
    admit: data.admit === true,
    adminMatch: data.adminMatch === true,
    wouldProvisionRole: data.wouldProvisionRole ?? null,
    memberships: Array.isArray(data.memberships) ? data.memberships : [],
    evaluatedAt: data.evaluatedAt,
    // The exact draft the server evaluated; null when absent (older server).
    policy: data.policy && typeof data.policy === "object" ? data.policy : null,
  };
}

/**
 * Message for a failed "start preview" POST. Codes match proofFailure and the
 * route: 400 invalid_request, 403 forbidden, 409 sso_not_linked/sso_unavailable,
 * 429 rate_limited. A 404 only means the feature is off or the page is stale,
 * so it never claims anything about the provider.
 */
export function previewStartMessage(err) {
  if (err?.code === "sso_not_linked") {
    return "Your account is not linked to an SSO identity, so there is nothing to re-authenticate. Sign in once through SSO to link it, then preview again.";
  }
  if (err?.code === "sso_unavailable") {
    return "This sign-in method is not set up or not enabled. Save the provider settings, then try again.";
  }
  if (err?.code === "invalid_request") {
    return "The draft policy was rejected. Check the groups claim, group lists and mappings, then try again.";
  }
  if (err?.code === "rate_limited" || err?.status === 429) {
    return "Too many attempts. Wait a moment, then try again.";
  }
  if (err?.status === 403) return "Only instance owners and admins can preview SSO policy.";
  return err?.message || "Could not start the SSO preview.";
}

/** Message for a failed result GET. 404 means no result, not a switch-off. */
export function previewResultMessage(err) {
  if (err?.status === 404) {
    return "No preview result found. It may have expired or already been read. Run another preview.";
  }
  if (err?.status === 403) return "Only instance owners and admins can read SSO preview results.";
  return err?.message || "Could not load the SSO preview result.";
}
