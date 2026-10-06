// YAN-360: token-authorized onboarding. No open registration: the stored
// invitation supplies workspace and role; generic failures prevent enumeration.
import { requireMultiUser } from "@/lib/users/featureSwitch.js";
import { getPrincipal } from "@/lib/users/session";
import { isCrossSite, isJson } from "@/lib/auth/sameOrigin.js";
import { json, readJsonBody, PayloadTooLarge } from "@/lib/users/userManagement.js";
import {
  acceptPasswordInvitation,
  acceptExistingInvitation,
} from "@/lib/users/invitationAccept.js";
import { hashInvitationToken } from "@/lib/db/repos/invitationsRepo.js";
import {
  checkLoginLocks,
  recordLoginFail,
  clearAccount,
  getClientIp,
} from "@/lib/auth/loginLimiter.js";
import { audit } from "@/lib/users/audit.js";

const FIELDS = new Set(["token", "email", "username", "displayName", "password"]);
const invalid = () => json({ error: "Invalid invitation", code: "invite_invalid" }, 400);

export async function POST(request) {
  let bucket;
  try {
    const hidden = await requireMultiUser();
    if (hidden) return hidden;
    if (isCrossSite(request)) return json({ error: "Forbidden", code: "forbidden_origin" }, 403);
    if (!isJson(request))
      return json({ error: "Unsupported media type", code: "invalid_request" }, 415);
    // IP bucket first: malformed requests are limited too (IP only, no token hash).
    bucket = { ip: getClientIp(request) };
    const limited = () => {
      const lock = checkLoginLocks(bucket);
      if (!lock.locked) return null;
      const response = json(
        { error: "Too many attempts", code: "rate_limited", retryAfter: lock.retryAfter },
        429,
      );
      response.headers.set("Retry-After", String(lock.retryAfter));
      return response;
    };
    const ipLocked = limited();
    if (ipLocked) return ipLocked;
    const malformed = () => {
      recordLoginFail(bucket);
      return invalid();
    };
    const body = await readJsonBody(request, { max: 4096 });
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((k) => !FIELDS.has(k))
    )
      return malformed();
    if (typeof body.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.token))
      return malformed();
    bucket.account = `invite:${hashInvitationToken(body.token)}`;
    const tokenLocked = limited();
    if (tokenLocked) return tokenLocked;
    const principal = await getPrincipal();
    if (principal && principal.via !== "session") return json({ error: "Unauthorized" }, 401);
    if (principal && Object.keys(body).some((k) => k !== "token")) return invalid();
    const result = principal
      ? await acceptExistingInvitation({ token: body.token, userId: principal.userId })
      : await acceptPasswordInvitation(body);
    clearAccount(bucket.account);
    // ponytail: IP budget never cleared on success (limiter design).
    audit(
      { principal, request, workspaceId: result.workspaceId },
      "invitation.accept",
      { type: "invitation", id: result.invitation.id },
      {
        after: {
          inviteId: result.invitation.id,
          workspaceId: result.workspaceId,
          role: result.role,
        },
      },
    );
    const response = json(result);
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch (err) {
    if (err instanceof PayloadTooLarge)
      return json({ error: "Payload too large", code: "payload_too_large" }, 413);
    if (err?.code === "PASSWORD_POLICY") return json({ error: err.message, code: err.policy }, 400);
    if (err?.code === "SINGLE_USER_MODE")
      return json({ error: "Turn on login before adding users", code: "single_user_mode" }, 409);
    if (
      ["INVALID", "NOT_FOUND", "EMAIL_TAKEN", "USERNAME_TAKEN", "MEMBERSHIP_EXISTS"].includes(
        err?.code,
      )
    ) {
      if (bucket) recordLoginFail(bucket);
      return invalid();
    }
    return json({ error: "Internal error" }, 500);
  }
}
