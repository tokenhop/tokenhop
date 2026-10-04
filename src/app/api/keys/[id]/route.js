import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, updateApiKey } from "@/lib/localDb";
import { validateKeyName } from "@/app/(dashboard)/dashboard/endpoint/endpointLogic";

import { readApiKeyStorageState } from "@/lib/db/apiKeyState";
import { getAdapter } from "@/lib/db/driver";

const NO_STORE = { "Cache-Control": "no-store" };

async function managementScope(request) {
  // Bearers never authorize dashboard management, including alongside a cookie.
  // The CLI token is not rejected here: resolvePrincipal validates it through
  // the shared peer policy (loopback once a second user exists), same as the
  // collection route. Same scope logic as ../route.js — keep them in sync.
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

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  let hashed = false;
  try {
    const { id } = await params;
    hashed = readApiKeyStorageState(await getAdapter()).storage === "hashed";
    if (hashed) {
      const scope = await managementScope(request);
      if (scope.error)
        return NextResponse.json(
          { error: scope.error },
          { status: scope.status, headers: NO_STORE },
        );
      const { getApiKey } = await import("@/lib/users/apiKeyManagement");
      const key = await getApiKey(scope.ctx, scope.workspaceId, id);
      return NextResponse.json({ key, storage: "hashed" }, { headers: NO_STORE });
    }
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key });
  } catch (error) {
    return fail(error, "Failed to fetch key", hashed);
  }
}

// PUT /api/keys/[id] - Update key
export async function PUT(request, { params }) {
  let hashed = false;
  try {
    const { id } = await params;
    hashed = readApiKeyStorageState(await getAdapter()).storage === "hashed";
    if (hashed) {
      const scope = await managementScope(request);
      if (scope.error)
        return NextResponse.json(
          { error: scope.error },
          { status: scope.status, headers: NO_STORE },
        );
      const { updateApiKey } = await import("@/lib/users/apiKeyManagement");
      let body;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ error: "Bad request" }, { status: 400, headers: NO_STORE });
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        return NextResponse.json({ error: "Bad request" }, { status: 400, headers: NO_STORE });
      if (body.name !== undefined) {
        const nameError = validateKeyName(body.name);
        if (nameError)
          return NextResponse.json({ error: nameError }, { status: 400, headers: NO_STORE });
        body.name = body.name.trim();
      }
      const key = await updateApiKey(scope.ctx, scope.workspaceId, id, body);
      return NextResponse.json({ key, storage: "hashed" }, { headers: NO_STORE });
    }
    const body = await request.json();
    const { isActive, name } = body;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive;
    if (name !== undefined) {
      const nameError = validateKeyName(name);
      if (nameError) return NextResponse.json({ error: nameError }, { status: 400 });
      updateData.name = name.trim();
    }

    const updated = await updateApiKey(id, updateData);

    return NextResponse.json({ key: updated });
  } catch (error) {
    return fail(error, "Failed to update key", hashed);
  }
}

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(request, { params }) {
  let hashed = false;
  try {
    const { id } = await params;
    hashed = readApiKeyStorageState(await getAdapter()).storage === "hashed";
    if (hashed) {
      const scope = await managementScope(request);
      if (scope.error)
        return NextResponse.json(
          { error: scope.error },
          { status: scope.status, headers: NO_STORE },
        );
      const { revokeApiKey } = await import("@/lib/users/apiKeyManagement");
      const key = await revokeApiKey(scope.ctx, scope.workspaceId, id);
      return NextResponse.json({ key, storage: "hashed" }, { headers: NO_STORE });
    }

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    return fail(error, "Failed to delete key", hashed);
  }
}
