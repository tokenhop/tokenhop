import { NextResponse } from "next/server";
import { getApiKeys, createApiKey, getApiKeyUsage } from "@/lib/localDb";
import { validateKeyName } from "@/app/(dashboard)/dashboard/endpoint/endpointLogic";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { readApiKeyStorageState } from "@/lib/db/apiKeyState";
import { getAdapter } from "@/lib/db/driver";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

async function managementScope(request) {
  // Bearers never authorize dashboard management, including alongside a cookie.
  if (request.headers.get("authorization")) return { status: 403, error: "Forbidden" };
  const { resolvePrincipal } = await import("@/lib/users/session");
  const ctx = await resolvePrincipal(request);
  if (!ctx) return { status: 401, error: "Unauthorized" };
  if (!["session", "cli"].includes(ctx.via) || ctx.apiKeyId != null)
    return { status: 403, error: "Forbidden" };
  const workspaceId = new URL(request.url).searchParams.get("workspaceId");
  if (!workspaceId || !workspaceId.trim()) return { status: 400, error: "workspaceId is required" };
  return { ctx, workspaceId };
}

function fail(error, legacyMessage, hashed) {
  const status = { NOT_FOUND: 404, FORBIDDEN: 403, INVALID: 400, API_KEY_STATE_INVALID: 503 }[
    error?.code
  ];
  if (status || hashed) {
    return NextResponse.json(
      {
        error: status
          ? {
              404: "Not found",
              403: "Forbidden",
              400: "Bad request",
              503: "Key storage unavailable",
            }[status]
          : "Failed to process request",
      },
      { status: status ?? 500, headers: NO_STORE },
    );
  }
  console.log(legacyMessage);
  return NextResponse.json({ error: legacyMessage }, { status: 500 });
}

/**
 * Augment keys with lastUsed + requestsToday.
 * Usage failure must never break key listing → defaults to null / 0.
 */
async function withUsage(keys, scope = null) {
  let usage = { lastUsed: {}, today: {} };
  try {
    // YAN-370: usage rows hold the key id in both storage modes.
    usage = await getApiKeyUsage(scope);
  } catch (err) {
    console.error("Failed to read apiKey usage:", err);
  }
  return keys.map((k) => ({
    ...k,
    lastUsed: usage.lastUsed?.[k.id] ?? null,
    requestsToday: usage.today?.[k.id] ?? 0,
  }));
}

// GET /api/keys - List API keys
export async function GET(request) {
  let hashed = false;
  try {
    hashed = readApiKeyStorageState(await getAdapter()).storage === "hashed";
    if (hashed) {
      const scope = await managementScope(request);
      if (scope.error)
        return NextResponse.json(
          { error: scope.error },
          { status: scope.status, headers: NO_STORE },
        );
      const { listApiKeys } = await import("@/lib/users/apiKeyManagement");
      const keys = await listApiKeys(scope.ctx, scope.workspaceId);
      return NextResponse.json(
        { keys: await withUsage(keys, { workspaceId: scope.workspaceId }), storage: "hashed" },
        { headers: NO_STORE },
      );
    }
    const keys = await getApiKeys();
    return NextResponse.json({ keys: await withUsage(keys) });
  } catch (error) {
    return fail(error, "Failed to fetch keys", hashed);
  }
}

// PATCH /api/keys — manage-only durable migration acknowledgement (spec214).
// Hashed storage only: a per-workspace nonsecret _meta flag, idempotent and
// persisted across sessions. The pristine legacy path keeps the router's 405
// for an unimplemented method — no legacy response shape changes.
export async function PATCH(request) {
  let hashed = false;
  try {
    hashed = readApiKeyStorageState(await getAdapter()).storage === "hashed";
    if (!hashed)
      return NextResponse.json({ error: "Method Not Allowed" }, { status: 405, headers: NO_STORE });
    const scope = await managementScope(request);
    if (scope.error)
      return NextResponse.json({ error: scope.error }, { status: scope.status, headers: NO_STORE });
    // Body contract is exact: { acknowledgeMigration: true } and nothing else.
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Bad request" }, { status: 400, headers: NO_STORE });
    }
    const exact =
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      Object.keys(body).length === 1 &&
      body.acknowledgeMigration === true;
    if (!exact)
      return NextResponse.json({ error: "Bad request" }, { status: 400, headers: NO_STORE });

    // Live role recheck (cookie roles are advisory): a manager of THIS
    // workspace only. Missing workspace and non-membership stay 404 — no leak.
    const db = await getAdapter();
    const { can } = await import("@/lib/users/principal");
    const { membershipRole } = await import("@/lib/db/repos/membershipsRepo");
    const user = db.get(`SELECT instanceRole, status FROM users WHERE id = ?`, [scope.ctx.userId]);
    if (user?.status !== "active")
      return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
    const role = membershipRole(db, scope.workspaceId, scope.ctx.userId);
    if (!role) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
    const live = { instanceRole: user.instanceRole, workspaceRoles: { [scope.workspaceId]: role } };
    if (!can(live, "workspace.keys.manage", { workspaceId: scope.workspaceId }))
      return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });

    const flag = `migrationAcknowledgedWorkspace:${scope.workspaceId}`;
    db.run(
      `INSERT INTO _meta(key, value) VALUES (?, '1')
       ON CONFLICT(key) DO UPDATE SET value = '1'`,
      [flag],
    );
    return NextResponse.json(
      { success: true, migrationAcknowledged: true, storage: "hashed" },
      { headers: NO_STORE },
    );
  } catch (error) {
    return fail(error, "Failed to acknowledge migration", hashed);
  }
}

// POST /api/keys - Create new API key
export async function POST(request) {
  let hashed = false;
  try {
    hashed = readApiKeyStorageState(await getAdapter()).storage === "hashed";
    if (hashed) {
      const scope = await managementScope(request);
      if (scope.error)
        return NextResponse.json(
          { error: scope.error },
          { status: scope.status, headers: NO_STORE },
        );
      let body;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ error: "Bad request" }, { status: 400, headers: NO_STORE });
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        return NextResponse.json({ error: "Bad request" }, { status: 400, headers: NO_STORE });
      const nameError = validateKeyName(body.name);
      if (nameError)
        return NextResponse.json({ error: nameError }, { status: 400, headers: NO_STORE });
      const { createApiKey: create } = await import("@/lib/users/apiKeyManagement");
      // Preserve unknown fields so the service rejects them, never silently drop.
      const { key, metadata } = await create(scope.ctx, scope.workspaceId, {
        ...body,
        type: body.type === undefined ? "user" : body.type,
        name: body.name.trim(),
      });
      return NextResponse.json(
        { key, name: metadata.name, id: metadata.id, metadata, storage: "hashed" },
        { status: 201, headers: NO_STORE },
      );
    }
    const body = await request.json();
    const { name } = body;

    // Same rule as rename/PUT: no blank, oversized, or control-character names.
    const nameError = validateKeyName(name);
    if (nameError) {
      return NextResponse.json({ error: nameError }, { status: 400 });
    }

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    const apiKey = await createApiKey(name.trim(), machineId);

    return NextResponse.json(
      {
        key: apiKey.key,
        name: apiKey.name,
        id: apiKey.id,
        machineId: apiKey.machineId,
      },
      { status: 201 },
    );
  } catch (error) {
    return fail(error, "Failed to create key", hashed);
  }
}
