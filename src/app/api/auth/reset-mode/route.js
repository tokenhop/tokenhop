// YAN-377: local owner recovery from an SSO-only lockout (YAN-349). Hidden
// (404) while the multi-user switch is off. Owner CLI or local owner session.
// Never a settings mass-assignment:
// body is exactly { mode: "password", password? }.
import { requireMultiUser } from "@/lib/users/featureSwitch.js";
import { isLocalRequest } from "@/dashboardGuard";
import { authorize, getPrincipal } from "@/lib/users/session";
import { audit } from "@/lib/users/audit.js";
import { isCrossSite, isJson } from "@/lib/auth/sameOrigin.js";
import { json, PayloadTooLarge, readJsonBody } from "@/lib/users/userManagement.js";
import {
  hashPassword,
  isUsablePasswordHash,
  validateNewPassword,
} from "@/lib/auth/userPassword.js";
import {
  getOwnerUnscoped,
  getUserPasswordHashUnscoped,
  setUserPasswordUnscoped,
  updateSettings,
} from "@/lib/db/index.js";

const KEYS = ["mode", "password"];

export async function POST(request) {
  try {
    const hidden = await requireMultiUser();
    if (hidden) return hidden;
    if (isCrossSite(request)) return json({ error: "Forbidden", code: "forbidden_origin" }, 403);
    if (!isJson(request)) {
      return json({ error: "Unsupported media type", code: "invalid_request" }, 415);
    }
    const principal = await getPrincipal();
    if (!principal) return json({ error: "Unauthorized" }, 401);
    if (!["session", "cli"].includes(principal.via)) return json({ error: "Forbidden" }, 403);
    const denied = await authorize("instance.ownership.transfer");
    if (denied) return denied;
    // Direct loopback only, CLI token or session alike: a valid token never
    // lifts this (single-user cardinality otherwise admits it from anywhere).
    if (!isLocalRequest(request)) {
      return json({ error: "Local only", code: "LOCAL_ONLY" }, 403);
    }

    const body = await readJsonBody(request, { max: 2048 });
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      body.mode !== "password" ||
      Object.keys(body).some((k) => !KEYS.includes(k))
    ) {
      return json({ error: "Invalid request", code: "invalid_request" }, 400);
    }
    const hasNew = Object.hasOwn(body, "password");
    if (hasNew) {
      const invalid = validateNewPassword(body.password);
      if (invalid) return json(invalid, 400);
    }

    const owner = await getOwnerUnscoped();
    if (!owner || owner.id !== principal.userId || owner.status !== "active") {
      return json({ error: "Forbidden" }, 403);
    }
    const stored = await getUserPasswordHashUnscoped(owner.id);
    const needsPassword = !isUsablePasswordHash(stored);
    if (needsPassword && !hasNew) {
      return json({ error: "Owner password required", code: "OWNER_PASSWORD_REQUIRED" }, 409);
    }
    // Credential first: a failed write must never open password login.
    if (needsPassword) {
      await setUserPasswordUnscoped(owner.id, {
        passwordHash: await hashPassword(body.password),
        mustChangePassword: false,
        expectedSessionVersion: owner.sessionVersion,
      });
    }
    await updateSettings({ authMode: "password" });
    audit(
      { principal, request },
      "auth.resetMode",
      { type: "settings", id: "authMode" },
      { after: { method: "password" } },
    );
    return json({ success: true, authMode: "password", ownerPasswordSet: needsPassword });
  } catch (err) {
    if (err instanceof PayloadTooLarge)
      return json({ error: err.message, code: err.code }, err.status);
    if (err?.code === "STALE") return json({ error: "User changed, retry", code: "stale" }, 409);
    if (err?.code === "API_KEY_STATE_INVALID") return json({ error: "Service unavailable" }, 503);
    return json({ error: "Internal error" }, 500);
  }
}
