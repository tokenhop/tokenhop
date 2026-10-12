// YAN-373: SSO policy preview. POST validates a draft policy (the six SSO
// policy keys) against the SAVED protocol connection config only — no draft
// IdP secrets, issuers, or client settings — then starts a forced, fresh IdP
// round trip (OIDC prompt=login + max_age=0, SAML ForceAuthn). The cookie
// carries only an opaque slot ref, purpose, actorId, sv and flow binding;
// the draft and the verified groups stay server-side (a cookie cannot hold
// 100 group-map entries, and groups never ride the browser). The SSO
// callback verifies, extracts the verified groups, evaluates the DRAFT
// policy (never admission, never provisioning) and redirects to the fixed
// /dashboard/admin/sso?ssoPreview=1 page. GET consumes the result ONCE.
// Hidden (404) while the multi-user switch is off; session-only
// instance.settings.manage.
import { isCrossSite, isJson } from "@/lib/auth/sameOrigin.js";
import { json, PayloadTooLarge, readBoundedBody } from "@/lib/users/userManagement.js";
import {
  proofFailure,
  proofLock,
  beginSsoProof,
  consumeSsoResult,
} from "@/lib/users/ssoPreview.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MAX_BODY = 8192;

export async function POST(request) {
  try {
    const { requireMultiUser } = await import("@/lib/users/featureSwitch.js");
    const hidden = await requireMultiUser();
    if (hidden) return hidden;
    if (isCrossSite(request)) return json({ error: "Forbidden", code: "forbidden_origin" }, 403);
    if (!isJson(request)) {
      return json({ error: "Unsupported media type", code: "invalid_request" }, 415);
    }
    const { getPrincipal, authorize } = await import("@/lib/users/session");
    const principal = await getPrincipal();
    if (principal?.via !== "session") return json({ error: "Unauthorized" }, 401);
    const denied = await authorize("instance.settings.manage");
    if (denied) return denied;
    const locked = proofLock(request, principal.userId);
    if (locked) return locked;
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      return json({ error: "Payload too large", code: "payload_too_large" }, 413);
    }
    let raw;
    try {
      raw = await readBoundedBody(request.body, MAX_BODY);
    } catch (err) {
      if (err instanceof PayloadTooLarge) {
        return json({ error: "Payload too large", code: "payload_too_large" }, 413);
      }
      throw err;
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
    if (
      keys.length > 2 ||
      !keys.includes("provider") ||
      !["oidc", "saml"].includes(body.provider) ||
      (keys.includes("policy") &&
        (!body.policy || typeof body.policy !== "object" || Array.isArray(body.policy)))
    ) {
      return json({ error: "Invalid request", code: "invalid_request" }, 400);
    }
    return await beginSsoProof(request, principal, {
      provider: body.provider,
      policy: body.policy,
    });
  } catch (err) {
    return proofFailure(err);
  }
}

// The finished evaluation, consumed exactly once. Fixed shape only; the
// workspace membership decision is a preview of admit/admin/roles per
// workspace — nothing here is written, linked or logged in.
export async function GET(request) {
  try {
    const { requireMultiUser } = await import("@/lib/users/featureSwitch.js");
    const hidden = await requireMultiUser();
    if (hidden) return hidden;
    if (isCrossSite(request)) return json({ error: "Forbidden", code: "forbidden_origin" }, 403);
    const { getPrincipal, authorize } = await import("@/lib/users/session");
    const principal = await getPrincipal();
    if (principal?.via !== "session") return json({ error: "Unauthorized" }, 401);
    const denied = await authorize("instance.settings.manage");
    if (denied) return denied;
    try {
      const result = await consumeSsoResult(principal, "sso_preview");
      return result
        ? json(result)
        : json({ error: "No completed SSO preview", code: "not_found" }, 404);
    } catch {
      return json({ error: "No completed SSO preview", code: "not_found" }, 404);
    }
  } catch (err) {
    return proofFailure(err);
  }
}
