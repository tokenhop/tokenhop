// Shared management-route helpers (YAN-360 task 3.1). Extracted from the
// admin user routes so every management route shares one no-store JSON
// shape, one byte-bounded body reader, and one managed-session guard.
// The body reader counts real Uint8Array bytes — a missing or forged
// content-length cannot bypass it — and cancels the reader without
// awaiting so a stalled client can never hang the handler.
import { NextResponse } from "next/server";
import { requireMultiUser } from "@/lib/users/featureSwitch.js";
import { can } from "@/lib/users/principal.js";
import { authorize, getPrincipal } from "@/lib/users/session";
import { isCrossSite, isJson } from "@/lib/auth/sameOrigin.js";

export const NO_STORE = { "Cache-Control": "no-store" };
export const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

/** Stable 413 for oversized request bodies. */
export const payloadTooLarge = () =>
  json({ error: "Payload too large", code: "payload_too_large" }, 413);

export class PayloadTooLarge extends Error {
  constructor() {
    super("Payload too large");
    this.name = "PayloadTooLarge";
    this.status = 413;
    this.code = "payload_too_large";
  }
}

/**
 * Byte-limited body read: counts Uint8Array chunk lengths, cancels the
 * reader once past `max` (fire-and-forget — awaiting a stalled cancel
 * would hang), and never buffers past the cap.
 * @param {ReadableStream|null} stream
 * @param {number} max
 * @returns {Promise<string>}
 * @throws {PayloadTooLarge}
 */
export async function readBoundedBody(stream, max) {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      reader.cancel().catch(() => {});
      throw new PayloadTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read and parse a JSON request body within `max` real bytes. The declared
 * content-length is only an early exit — the stream itself is the limit.
 * Returns the parsed value (any JSON type) or null when malformed.
 * @param {Request} request
 * @param {{ max?: number }} [opts]
 * @returns {Promise<unknown>}
 * @throws {PayloadTooLarge}
 */
export async function readJsonBody(request, { max = 1024 } = {}) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new PayloadTooLarge();
  const raw = await readBoundedBody(request.body, max);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Shared prelude for management routes: multi-user switch, same-origin
 * (all methods) and JSON (mutators only), full browser session, scoped
 * capability. Returns `{ res }` when denied, else `{ principal }`.
 * `allowInstanceUsersManage` (YAN-360): the member-management routes also
 * admit an active instance admin/owner holding `instance.users.manage` —
 * they may manage any shared workspace without a membership row. No other
 * capability or route opts in; the repo still re-checks authority live.
 * @param {Request} request
 * @param {{ capability: string, workspaceId?: string|null, body?: boolean, allowInstanceUsersManage?: boolean }} [opts]
 */
export async function requireManagedSession(
  request,
  { capability, workspaceId = null, body = false, allowInstanceUsersManage = false } = {},
) {
  const hidden = await requireMultiUser();
  if (hidden) return { res: hidden };
  if (isCrossSite(request)) {
    return { res: json({ error: "Forbidden", code: "forbidden_origin" }, 403) };
  }
  if (body && !isJson(request)) {
    return { res: json({ error: "Unsupported media type", code: "invalid_request" }, 415) };
  }
  const principal = await getPrincipal();
  if (principal?.via !== "session") return { res: json({ error: "Unauthorized" }, 401) };
  if (allowInstanceUsersManage && can(principal, "instance.users.manage")) return { principal };
  const denied = await authorize(capability, workspaceId ? { workspaceId } : {});
  if (denied) return { res: denied };
  return { principal };
}
