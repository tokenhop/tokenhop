// YAN-369: connection-grant management on a provider connection. GET lists a
// connection's grants; POST creates one. Hidden (404) while the multi-user
// switch is off. Full browser session only. The connection URL id is
// authoritative; connectionGrantsRepo re-checks live manager authority in its
// transaction and writes the connectionGrant.create audit row — none here.
// ToS guardrails (personal sharing, instance toggle, instance owner/admin,
// acknowledgement echo) are @/lib/users/grants.js `assertGrantable`; a
// personal-connection denial carries the ADR-0006 warning copy for the UI.
import { json, PayloadTooLarge, readJsonBody } from "@/lib/users/userManagement.js";
import { requireMultiUser } from "@/lib/users/featureSwitch.js";
import { getPrincipal } from "@/lib/users/session.js";
import { can } from "@/lib/users/principal.js";
import { isCrossSite, isJson } from "@/lib/auth/sameOrigin.js";
import { getProviderConnectionMetadataByIdUnscoped } from "@/lib/db/repos/connectionsRepo.js";
import { createGrant, listGrantsForConnection } from "@/lib/db/repos/connectionGrantsRepo.js";
import { assertGrantable, getSharingWarning, resolveSharing } from "@/lib/users/grants.js";
import { getSettings } from "@/lib/db/index.js";
import { TenancyError } from "@/lib/users/errors.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MAX_BODY = 8192;
const CAPABILITY = "workspace.grants.manage";
// Strict allow-list: connectionId comes from the URL; actor hints, status and
// anything else are rejected, not ignored.
// repo re-verifies the echo before stamping tosAcknowledgedAt.
// budgetId is not client-settable yet (YAN-372 wires it): it is not in the
// whitelist, so a body carrying it is a 400, never silently ignored.
const KEYS = ["workspaceId", "userId", "allowedModels", "rpm", "tpm", "tosAcknowledged"];

// Fixed messages only: repo error text is never echoed.
const ERRORS = {
  NOT_FOUND: [404, "Connection not found"],
  FORBIDDEN: [403, "Forbidden"],
  INVALID: [400, "Invalid request"],
};

function fail(err) {
  if (err instanceof PayloadTooLarge)
    return json({ error: err.message, code: err.code }, err.status);
  const hit = ERRORS[err?.code];
  if (hit) return json({ error: hit[1], code: err.code.toLowerCase() }, hit[0]);
  return json({ error: "Internal error" }, 500);
}

// Switch, same-origin, JSON for mutators, full browser session. The workspace
// comes from the connection row, so the capability is checked next.
async function gate(request, { body = false } = {}) {
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
  return { principal };
}

// Metadata-only read (never decrypts). Members without the capability get 403,
// everyone outside the workspace 404 — no existence leak.
async function connectionToGrant(principal, id) {
  const conn =
    typeof id === "string" && id ? await getProviderConnectionMetadataByIdUnscoped(id) : null;
  if (!conn?.workspaceId) throw new TenancyError("NOT_FOUND", "Connection not found");
  if (can(principal, CAPABILITY, { workspaceId: conn.workspaceId })) return conn;
  if (principal.workspaceIds?.includes(conn.workspaceId))
    throw new TenancyError("FORBIDDEN", "Only owners and managers may manage grants");
  throw new TenancyError("NOT_FOUND", "Connection not found");
}

export async function GET(request, { params }) {
  const g = await gate(request);
  if (g.res) return g.res;
  try {
    const { id } = await params;
    return json({ grants: await listGrantsForConnection(g.principal, id) });
  } catch (err) {
    return fail(err);
  }
}

export async function POST(request, { params }) {
  const g = await gate(request, { body: true });
  if (g.res) return g.res;
  try {
    const { id } = await params;
    const connection = await connectionToGrant(g.principal, id);
    const body = await readJsonBody(request, { max: MAX_BODY });
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((k) => !KEYS.includes(k))
    ) {
      throw new TenancyError("INVALID");
    }
    const { tosAcknowledged, ...rest } = body;
    try {
      assertGrantable({
        principal: g.principal,
        connection,
        body,
        settings: await getSettings(),
      });
    } catch (err) {
      if (err?.code !== "FORBIDDEN") throw err;
      const out = { error: "Forbidden", code: "forbidden" };
      if (resolveSharing(connection.provider, connection.authType) === "personal") {
        out.sharing = "personal";
        out.warning = getSharingWarning(connection.provider);
      }
      return json(out, 403);
    }
    // The ack only means something on a personal connection; the repo
    // re-verifies the echo before stamping tosAcknowledgedAt.
    const personal = resolveSharing(connection.provider, connection.authType) === "personal";
    const grant = await createGrant(g.principal, {
      ...rest,
      connectionId: id,
      tosAcknowledged: personal ? tosAcknowledged : null,
    });
    return json({ grant }, 201);
  } catch (err) {
    return fail(err);
  }
}
