// YAN-365 (B6): owner-only instance KEK rotation over the existing rotation
// service. POST with an empty bounded JSON object body only — root, path, env
// or options overrides are refused before anything loads. Hidden (404) while
// the multi-user switch is off, even on established encryption. The handler
// re-checks `instance.keys.rotate` server-side (owner only); env-managed roots
// answer 409 KEK_ENV_MANAGED with the same-key conversion guidance, a poisoned
// adapter 409 LOCKED, and service-unavailability codes 503 typed. Audit and
// responses carry actor/operation/kids/counts only — never key material.
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

// Fixed typed responses only: service error text is never echoed.
const UNAVAILABLE = {
  ROTATION_NOT_ENCRYPTED: "Credential encryption is not active",
  ROTATION_NOT_READY: "Pending activation cleanup must finish first",
  ROTATION_IN_FLIGHT: "A key rotation is pending recovery; restart first",
  ROTATION_OPTIONS_INVALID: "Rotation is not possible in this state",
  KEY_MISSING: "The credential root key is unavailable",
  KEY_MISMATCH: "The credential root key does not match this instance",
  ROOT_INVALID: "The credential root key is unavailable",
};

export async function POST(request) {
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
  try {
    const db = await getAdapter();
    const { rotateKek } = await import("@/lib/security/keyRotation.js");
    const result = await rotateKek(db);
    // Audit kids/counts/result only; insert failures never fail the rotation.
    audit(
      { principal, request },
      "instance.keys.rotate",
      { type: "key", id: result.newKid },
      { after: { from: result.oldKid, to: result.newKid, count: result.deks } },
    );
    return json({
      status: result.status,
      oldKid: result.oldKid,
      newKid: result.newKid,
      dekCount: result.deks,
      reminder:
        "Back up the new master key now. Backups taken before this rotation stay restorable only with the previous key, which the operator must keep offline.",
    });
  } catch (err) {
    const code = err?.code ?? "";
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
