// YAN-1012: fresh SSO re-auth for data transfers (instance/workspace
// export/import) by SSO-only users. POST starts a forced, fresh IdP login
// bound to ONE action (+ workspace for workspace actions); GET consumes the
// completed result once and returns a one-time `ssoProof` that the transfer
// request presents instead of a password. Never mints a session. Hidden (404)
// while the switch is off; browser session only (no CLI token).
import { isCrossSite, isJson } from "@/lib/auth/sameOrigin.js";
import { requireMultiUser } from "@/lib/users/featureSwitch.js";
import { can } from "@/lib/users/principal.js";
import { getPrincipal } from "@/lib/users/session";
import { json, PayloadTooLarge, readJsonBody } from "@/lib/users/userManagement.js";
import {
  beginSsoProof,
  consumeSsoResult,
  proofFailure,
  proofLock,
} from "@/lib/users/ssoPreview.js";
import { DATA_TRANSFER_PURPOSES } from "@/lib/users/ssoProofState.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WS_CAP = "workspace.preferences.manage";
const invalid = () => json({ error: "Invalid request", code: "invalid_request" }, 400);
const notFound = () =>
  json({ error: "No completed SSO re-authentication", code: "not_found" }, 404);

/** Principal-level gate (switch, cross-site, content type, session): runs before any body read. */
async function gatePrincipal(request, { body = false } = {}) {
  const hidden = await requireMultiUser();
  if (hidden) return { res: hidden };
  if (isCrossSite(request))
    return { res: json({ error: "Forbidden", code: "forbidden_origin" }, 403) };
  if (body && !isJson(request)) {
    return { res: json({ error: "Unsupported media type", code: "invalid_request" }, 415) };
  }
  const principal = await getPrincipal();
  if (principal?.via !== "session") return { res: json({ error: "Unauthorized" }, 401) };
  return { principal };
}

/** Per-action authority. Returns { purpose, workspaceId } | { res }. */
function gateAction(principal, action, workspaceId) {
  if (!Object.hasOwn(DATA_TRANSFER_PURPOSES, action ?? "")) return { res: invalid() };
  const purpose = DATA_TRANSFER_PURPOSES[action];
  if (action.startsWith("instance.")) {
    if (workspaceId != null) return { res: invalid() };
    if (!can(principal, "instance.hostOps")) return { res: json({ error: "Forbidden" }, 403) };
    return { purpose, workspaceId: null };
  }
  if (typeof workspaceId !== "string" || !UUID_RE.test(workspaceId)) return { res: invalid() };
  const role = principal.workspaceRoles?.[workspaceId];
  if (!role) return { res: json({ error: "Workspace not found", code: "not_found" }, 404) };
  if (role !== "owner" || !can(principal, WS_CAP, { workspaceId })) {
    return { res: json({ error: "Forbidden" }, 403) };
  }
  return { purpose, workspaceId };
}

export async function POST(request) {
  try {
    const p = await gatePrincipal(request, { body: true });
    if (p.res) return p.res;
    let body;
    try {
      body = await readJsonBody(request, { max: 512 });
    } catch (err) {
      if (err instanceof PayloadTooLarge)
        return json({ error: "Payload too large", code: "payload_too_large" }, 413);
      throw err;
    }
    const isObj = body && typeof body === "object" && !Array.isArray(body);
    if (
      !isObj ||
      Object.keys(body).some((k) => !["provider", "action", "workspaceId"].includes(k)) ||
      !["oidc", "saml"].includes(body.provider) ||
      typeof body.action !== "string"
    ) {
      return invalid();
    }
    const g = gateAction(p.principal, body.action, body.workspaceId);
    if (g.res) return g.res;
    const lock = proofLock(request, p.principal.userId);
    if (lock) return lock;
    return await beginSsoProof(request, p.principal, {
      provider: body.provider,
      purpose: g.purpose,
      workspaceId: g.workspaceId,
    });
  } catch (err) {
    return proofFailure(err);
  }
}

export async function GET(request) {
  try {
    const q = new URL(request.url).searchParams;
    const p = await gatePrincipal(request);
    if (p.res) return p.res;
    const g = gateAction(p.principal, q.get("action"), q.get("workspaceId"));
    if (g.res) return g.res;
    try {
      const proof = await consumeSsoResult(p.principal, g.purpose, g.workspaceId);
      return proof ? json(proof) : notFound();
    } catch {
      return notFound();
    }
  } catch (err) {
    return proofFailure(err);
  }
}
