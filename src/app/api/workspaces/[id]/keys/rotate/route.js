// YAN-365 (B6): owner-only workspace DEK rotation over the existing rotation
// service. Same transport contract as /api/settings/keys/rotate: POST with an
// empty bounded JSON object body, hidden 404 while the switch is off, 401/403
// auth, explicit server-side owner recheck, env-managed KEK refusal guidance
// (workspace DEK rotation stays available under env-managed roots — D9), 409
// LOCKED while poisoned, 503 typed unavailability. Only kids/counts leave the
// server; the exact URL workspace id is authoritative.
import { NextResponse } from "next/server";
import { requireMultiUser } from "@/lib/users/featureSwitch.js";
import { authorize, getPrincipal } from "@/lib/users/session.js";
import { getAdapter } from "@/lib/db/driver.js";
import { isCrossSite, isJson } from "@/lib/auth/sameOrigin.js";
import { PayloadTooLarge, readJsonBody } from "@/lib/users/userManagement.js";
import { audit } from "@/lib/users/audit.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const CAPABILITY = "instance.keys.rotate";
const MAX_BODY = 1024;
const NO_STORE = { "Cache-Control": "no-store" };
const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

const UNAVAILABLE = {
  ROTATION_NOT_ENCRYPTED: "Credential encryption is not active",
  ROTATION_NOT_READY: "Pending activation cleanup must finish first",
  ROTATION_IN_FLIGHT: "A key rotation is pending recovery; restart first",
  ROTATION_OPTIONS_INVALID: "Rotation is not possible in this state",
  KEY_MISSING: "The credential root key is unavailable",
  KEY_MISMATCH: "The credential root key does not match this instance",
  ROOT_INVALID: "The credential root key is unavailable",
};

export async function POST(request, { params }) {
  const hidden = await requireMultiUser();
  if (hidden) return hidden;
  if (isCrossSite(request)) return json({ error: "Forbidden", code: "forbidden_origin" }, 403);
  if (!isJson(request))
    return json({ error: "Unsupported media type", code: "invalid_request" }, 415);
  let body;
  try {
    body = await readJsonBody(request, { max: MAX_BODY });
  } catch (err) {
    if (err instanceof PayloadTooLarge)
      return json({ error: "Payload too large", code: "payload_too_large" }, 413);
    return json({ error: "Internal error" }, 500);
  }
  // Malformed JSON parses to null: only a real `{}` passes.
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > 0) {
    return json({ error: "Invalid request", code: "invalid_request" }, 400);
  }
  const principal = await getPrincipal();
  const denied = await authorize(CAPABILITY);
  if (denied) return denied;
  const { id } = await params;
  try {
    const db = await getAdapter();
    const { rotateWorkspaceDek } = await import("@/lib/security/keyRotation.js");
    const result = await rotateWorkspaceDek(db, id);
    audit(
      { principal, request, workspaceId: id },
      "workspace.keys.rotate",
      { type: "workspace", id },
      { after: { from: result.oldDekKid, to: result.dekKid, count: result.rotated } },
    );
    return json({
      status: result.status,
      workspaceId: id,
      dekKid: result.dekKid,
      oldDekKid: result.oldDekKid,
      rotated: result.rotated,
    });
  } catch (err) {
    const code = err?.code ?? "";
    if (code === "ROTATION_WORKSPACE_MISSING") {
      return json({ error: "Workspace not found", code: "not_found" }, 404);
    }
    if (code === "KEK_ENV_MANAGED") {
      return json({ error: err.message, code }, 409);
    }
    if (code === "CREDENTIAL_MAINTENANCE_POISONED") {
      return json({ error: "Credential maintenance is locked until restart", code: "locked" }, 409);
    }
    if (Object.hasOwn(UNAVAILABLE, code)) {
      return json({ error: UNAVAILABLE[code], code: code.toLowerCase() }, 503);
    }
    return json({ error: "Internal error" }, 500);
  }
}
