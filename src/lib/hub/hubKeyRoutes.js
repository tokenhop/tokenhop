// Shared prelude for the usage hub key management routes (YAN-2019).
// The edge row needs instance.settings.manage (owner/admin, or the single-user
// owner); here: hidden (404) while TOKENHOP_USAGE_HUB is off, gateway and hub
// credentials never manage keys, same-origin only, JSON for writes, and the
// capability is rechecked live. Fixed error text only.
import { json } from "@/lib/users/userManagement.js";
import { isCrossSite, isJson } from "@/lib/auth/sameOrigin.js";
import { authorize, getPrincipal } from "@/lib/users/session.js";
import { isUsageHubEnabled } from "./hubConfig.js";

const CREDENTIAL_HEADERS = ["authorization", "x-api-key", "x-goog-api-key"];
export const CAPABILITY = "instance.settings.manage";

/** @returns {Promise<{ res: Response } | { principal: object|null }>} */
export async function hubKeyGate(request, { body = false } = {}) {
  if (!isUsageHubEnabled()) return { res: json({ error: "Not found" }, 404) };
  if (CREDENTIAL_HEADERS.some((h) => request.headers.has(h))) {
    return { res: json({ error: "Unauthorized" }, 401) };
  }
  if (isCrossSite(request)) {
    return { res: json({ error: "Forbidden", code: "forbidden_origin" }, 403) };
  }
  if (body && !isJson(request)) {
    return { res: json({ error: "Unsupported media type", code: "invalid_request" }, 415) };
  }
  // authorize() is a no-op while user security is off; the edge already
  // required a login (or the single-user owner) for this row.
  const denied = await authorize(CAPABILITY);
  if (denied) return { res: denied };
  return { principal: await getPrincipal().catch(() => null) };
}

/** Re-evaluate the quota snapshot poller after the key set changed (YAN-2447). */
export function resyncPoller() {
  import("@/shared/services/quotaSnapshotPoller")
    .then(({ syncQuotaSnapshotPoller }) => syncQuotaSnapshotPoller())
    .catch((e) => console.log("[QuotaSnapshotPoller] sync failed:", e?.message));
}
