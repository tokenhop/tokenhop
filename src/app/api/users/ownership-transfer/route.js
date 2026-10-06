// YAN-360: instance ownership transfer. Hidden (404) while the multi-user
// switch is off. Full browser session only (the CLI token is an owner proof by
// itself, but transfer demands a password the terminal never holds). The live
// session is never enough: the owner re-proves the current password in the
// same request, rate-limited like login. Audit stays in the repo
// (instance.ownership.transfer) — this route never duplicates it.
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireMultiUser } from "@/lib/users/featureSwitch";
import { authorize, getPrincipal } from "@/lib/users/session";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";
import { isCrossSite, isJson } from "@/lib/auth/sameOrigin.js";
import {
  accountKey,
  checkLoginLocks,
  clearAccount,
  getClientIp,
  recordLoginFail,
} from "@/lib/auth/loginLimiter.js";
import { transferWithPasswordProof } from "@/lib/users/ownershipTransfer.js";

const NO_STORE = { "Cache-Control": "no-store" };
const json = (body, status = 200, headers = {}) =>
  NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });
const MAX_BODY = 2048;
const FIELDS = ["toUserId", "currentPassword"];
// Request-shape errors answer 400 directly in POST; repo INVALID = bad target.
const ERRORS = {
  NOT_FOUND: [409, "Invalid transfer target", "invalid_target"],
  FORBIDDEN: [403, "Only the instance owner can transfer ownership", "forbidden"],
  OWNER_IMMUTABLE: [403, "Only the instance owner can transfer ownership", "forbidden"],
  REAUTH_REQUIRED: [401, "Current password is required to transfer ownership", "reauth_required"],
  REAUTH_UNSUPPORTED: [
    403,
    "This owner signs in with single sign-on; password transfer is unavailable",
    "reauth_unsupported",
  ],
  INVALID: [409, "Invalid transfer target", "invalid_target"],
  STALE: [409, "Session is out of date", "stale_session"],
};

function fail(err) {
  const known = ERRORS[err?.code];
  if (known) return json({ error: known[1], code: known[2] }, known[0]);
  if (err?.code === "API_KEY_STATE_INVALID") return json({ error: "Service unavailable" }, 503);
  return json({ error: "Internal error" }, 500);
}

const OVERFLOW = Symbol("overflow");
const tooLarge = () => json({ error: "Payload too large", code: "payload_too_large" }, 413);

// Byte-limited body read: counts real streamed bytes (never a dishonest
// content-length), cancels the reader once past max, never buffers past it.
async function readBody(stream, max) {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw OVERFLOW;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request) {
  try {
    const hidden = await requireMultiUser();
    if (hidden) return hidden;
    if (isCrossSite(request)) return json({ error: "Forbidden", code: "forbidden_origin" }, 403);
    if (!isJson(request)) {
      return json({ error: "Unsupported media type", code: "invalid_request" }, 415);
    }
    const principal = await getPrincipal();
    if (principal?.via !== "session") return json({ error: "Unauthorized" }, 401);
    const denied = await authorize("instance.ownership.transfer");
    if (denied) return denied;

    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY) return tooLarge();
    let raw;
    try {
      raw = await readBody(request.body, MAX_BODY);
    } catch (err) {
      if (err === OVERFLOW) return tooLarge();
      throw err;
    }
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
    if (
      keys.length !== 2 ||
      !FIELDS.every((k) => Object.hasOwn(body, k)) ||
      typeof body.toUserId !== "string" ||
      !UUID_RE.test(body.toUserId) ||
      typeof body.currentPassword !== "string"
    ) {
      return json({ error: "Invalid request", code: "invalid_request" }, 400);
    }

    // Rate limit before any bcrypt work: same IP + account buckets as login.
    const ip = getClientIp(request);
    const account = accountKey({ userId: principal.userId });
    const lock = checkLoginLocks({ ip, account });
    if (lock.locked) {
      return json(
        {
          error: `Too many failed attempts. Try again in ${lock.retryAfter}s.`,
          code: "rate_limited",
          retryAfter: lock.retryAfter,
        },
        429,
        { "Retry-After": String(lock.retryAfter) },
      );
    }

    // Bind the proof to this session's sv; no matching sv claim fails closed
    // (STALE), and the repo re-checks it against the DB row in the swap tx.
    const cookieStore = await cookies();
    const claims = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);

    try {
      const user = await transferWithPasswordProof({
        actorUserId: principal.userId,
        toUserId: body.toUserId,
        currentPassword: body.currentPassword,
        expectedSessionVersion:
          claims?.sub === principal.userId && typeof claims.sv === "number" ? claims.sv : undefined,
      });
      clearAccount(account);
      const { sessionVersion: _sv, ...safe } = user;
      return json({ user: safe });
    } catch (err) {
      if (err?.code === "REAUTH_REQUIRED") recordLoginFail({ ip, account });
      throw err;
    }
  } catch (err) {
    return fail(err);
  }
}
