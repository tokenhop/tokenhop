// YAN-373: SSO fresh re-auth for workspace deletion. POST starts a forced,
// fresh IdP login (OIDC prompt=login + max_age=0, SAML ForceAuthn) bound to
// an encrypted proof cookie carrying only an opaque slot ref, purpose,
// actorId, sv and flow id — drafts/groups stay server-side. The SSO callback
// verifies the fresh authentication, linked identity and live admin actor,
// stores the result, and redirects back here. GET consumes the completed
// proof ONCE and returns an opaque one-time `ssoProof` for the DELETE body.
// Never mints a session, never admits via ssoAdmit. Hidden (404) while the
// multi-user switch is off; browser session of a live owner/admin only.
import {
  json,
  PayloadTooLarge,
  readJsonBody,
  requireManagedSession,
} from "@/lib/users/userManagement.js";
import {
  proofFailure,
  proofLock,
  beginSsoProof,
  consumeSsoResult,
} from "@/lib/users/ssoPreview.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) return json({ error: "Invalid request", code: "invalid_request" }, 400);
    const gate = await requireManagedSession(request, {
      capability: "instance.users.manage",
      body: true,
    });
    if (gate.res) return gate.res;
    const { principal } = gate;
    const lock = proofLock(request, principal.userId);
    if (lock) return lock;
    let body;
    try {
      body = await readJsonBody(request, { max: 512 });
    } catch (err) {
      if (err instanceof PayloadTooLarge)
        return json({ error: "Payload too large", code: "payload_too_large" }, 413);
      throw err;
    }
    const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
    if (keys.length !== 1 || !["oidc", "saml"].includes(body.provider)) {
      return json({ error: "Invalid request", code: "invalid_request" }, 400);
    }
    return await beginSsoProof(request, principal, { provider: body.provider, workspaceId: id });
  } catch (err) {
    return proofFailure(err);
  }
}

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) return json({ error: "Invalid request", code: "invalid_request" }, 400);
    const gate = await requireManagedSession(request, { capability: "instance.users.manage" });
    if (gate.res) return gate.res;
    const { principal } = gate;
    try {
      const proof = await consumeSsoResult(principal, "workspace_delete", id);
      return proof
        ? json(proof)
        : json({ error: "No completed SSO re-authentication", code: "not_found" }, 404);
    } catch {
      return json({ error: "No completed SSO re-authentication", code: "not_found" }, 404);
    }
  } catch (err) {
    return proofFailure(err);
  }
}
