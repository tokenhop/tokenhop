// YAN-367: audit log read API. Owner/admin only (ADR-0002 instance.audit.read).
// Switch off: 404 (requireMultiUser). Rows hold no secrets by design (redacted at write).
import { NextResponse } from "next/server";
import { requireMultiUser } from "@/lib/users/featureSwitch.js";
import { can } from "@/lib/users/principal.js";
import { resolvePrincipal } from "@/lib/users/session";
import { auditRepo } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

const FILTERS = [
  ["workspaceId", "workspaceId"],
  ["actorUserId", "actorUserId"],
  ["action", "action"],
  ["targetType", "targetType"],
  ["targetId", "targetId"],
  ["from", "fromTs"],
  ["to", "toTs"],
];

/**
 * GET /api/audit
 * Query: page, pageSize (1-100), workspaceId, actorUserId, action (prefix),
 * targetType, targetId, from, to.
 */
export async function GET(request) {
  try {
    const hidden = await requireMultiUser();
    if (hidden) return hidden;

    // Bearers never authorize dashboard reads, including alongside a cookie.
    if (request.headers.get("authorization")) return json({ error: "Forbidden" }, 403);
    const principal = await resolvePrincipal(request);
    if (!principal) return json({ error: "Unauthorized" }, 401);
    if (!["session", "cli"].includes(principal.via) || principal.apiKeyId != null)
      return json({ error: "Forbidden" }, 403);
    if (!can(principal, "instance.audit.read")) return json({ error: "Forbidden" }, 403);

    const { searchParams } = new URL(request.url);
    const pageRaw = parseInt(searchParams.get("page"), 10);
    const page = Number.isNaN(pageRaw) ? 1 : pageRaw;
    const sizeRaw = parseInt(searchParams.get("pageSize"), 10);
    const pageSize = Number.isNaN(sizeRaw) ? 20 : sizeRaw;
    if (page < 1) return json({ error: "Page must be >= 1" }, 400);
    if (pageSize < 1 || pageSize > 100)
      return json({ error: "PageSize must be between 1 and 100" }, 400);

    const filter = { page, pageSize };
    for (const [param, key] of FILTERS) {
      const v = searchParams.get(param);
      if (v) filter[key] = v;
    }

    const { events, pagination } = await auditRepo.list(filter);
    return json({ events, pagination });
  } catch (error) {
    if (error?.code === "API_KEY_STATE_INVALID") return json({ error: "Service unavailable" }, 503);
    console.error("[API] Failed to read audit log:", error);
    return json({ error: "Failed to fetch audit log" }, 500);
  }
}
