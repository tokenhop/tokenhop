import { NextResponse } from "next/server";
import {
  disableModels,
  disableModelsUnscoped,
  enableModels,
  enableModelsUnscoped,
  getDisabledModels,
  getDisabledModelsUnscoped,
} from "@/lib/db/index.js";
import { workspaceScope } from "@/lib/users/workspaceScope.js";

export const dynamic = "force-dynamic";

// Scoped writes reject the reserved `ws:` key namespace (ADR-0001).
function isReservedKey(key) {
  return typeof key === "string" && key.startsWith("ws:");
}

// GET /api/models/disabled?providerAlias=xxx
export async function GET(request) {
  try {
    const scope = await workspaceScope(request, "workspace.connections.metadata.read");
    if (scope instanceof Response) return scope;
    const { searchParams } = new URL(request.url);
    const providerAlias = searchParams.get("providerAlias");
    const all = scope
      ? await getDisabledModels(scope.ctx, scope.workspaceId)
      : await getDisabledModelsUnscoped();
    if (providerAlias) return NextResponse.json({ ids: all[providerAlias] || [] });
    return NextResponse.json({ disabled: all });
  } catch (error) {
    console.log("Error fetching disabled models:", error);
    return NextResponse.json({ error: "Failed to fetch disabled models" }, { status: 500 });
  }
}

// POST /api/models/disabled  body: { providerAlias, ids: [...] }
export async function POST(request) {
  try {
    const scope = await workspaceScope(request, "workspace.combos.manage");
    if (scope instanceof Response) return scope;
    const { providerAlias, ids } = await request.json();
    if (!providerAlias || !Array.isArray(ids)) {
      return NextResponse.json({ error: "providerAlias and ids[] required" }, { status: 400 });
    }
    if (scope && isReservedKey(providerAlias)) {
      return NextResponse.json({ error: "Reserved key prefix" }, { status: 400 });
    }
    if (scope) {
      await disableModels(scope.ctx, scope.workspaceId, providerAlias, ids);
    } else {
      await disableModelsUnscoped(providerAlias, ids);
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error?.code === "INVALID") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.log("Error disabling models:", error);
    return NextResponse.json({ error: "Failed to disable models" }, { status: 500 });
  }
}

// DELETE /api/models/disabled?providerAlias=xxx[&id=yyy]
export async function DELETE(request) {
  try {
    const scope = await workspaceScope(request, "workspace.combos.manage");
    if (scope instanceof Response) return scope;
    const { searchParams } = new URL(request.url);
    const providerAlias = searchParams.get("providerAlias");
    const id = searchParams.get("id");
    if (!providerAlias) {
      return NextResponse.json({ error: "providerAlias required" }, { status: 400 });
    }
    if (scope && isReservedKey(providerAlias)) {
      return NextResponse.json({ error: "Reserved key prefix" }, { status: 400 });
    }
    if (scope) {
      await enableModels(scope.ctx, scope.workspaceId, providerAlias, id ? [id] : []);
    } else {
      await enableModelsUnscoped(providerAlias, id ? [id] : []);
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error?.code === "INVALID") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.log("Error enabling models:", error);
    return NextResponse.json({ error: "Failed to enable models" }, { status: 500 });
  }
}
