import { NextResponse } from "next/server";
import {
  addCustomModel,
  addCustomModelUnscoped,
  deleteCustomModel,
  deleteCustomModelUnscoped,
  getCustomModels,
  getCustomModelsUnscoped,
} from "@/lib/db/index.js";
import { CAPACITY_META } from "@/shared/constants/models";
import { workspaceScope } from "@/lib/users/workspaceScope.js";
import { refreshCustomModelCaps } from "@/lib/customModelCaps";

export const dynamic = "force-dynamic";

// Whitelist capability keys to boolean values — ignore anything else
function sanitizeCaps(caps) {
  if (!caps || typeof caps !== "object") return null;
  const clean = {};
  for (const key of Object.keys(CAPACITY_META)) {
    if (typeof caps[key] === "boolean") clean[key] = caps[key];
  }
  return Object.keys(clean).length ? clean : null;
}

// Scoped writes reject the reserved `ws:` key namespace (ADR-0001).
function isReservedKey(key) {
  return typeof key === "string" && key.startsWith("ws:");
}

// GET /api/models/custom - List all custom models
export async function GET(request) {
  try {
    const scope = await workspaceScope(request, "workspace.connections.metadata.read");
    if (scope instanceof Response) return scope;
    const models = scope
      ? await getCustomModels(scope.ctx, scope.workspaceId)
      : await getCustomModelsUnscoped();
    return NextResponse.json({ models });
  } catch (error) {
    console.log("Error fetching custom models:", error);
    return NextResponse.json({ error: "Failed to fetch custom models" }, { status: 500 });
  }
}

// POST /api/models/custom - Add custom model
export async function POST(request) {
  try {
    const scope = await workspaceScope(request, "workspace.combos.manage");
    if (scope instanceof Response) return scope;
    const { providerAlias, id, type, name, caps } = await request.json();
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    if (scope && (isReservedKey(providerAlias) || isReservedKey(id))) {
      return NextResponse.json({ error: "Reserved key prefix" }, { status: 400 });
    }
    const cleanCaps = sanitizeCaps(caps);
    const data = {
      providerAlias,
      id,
      type: type || "llm",
      name,
      ...(cleanCaps ? { caps: cleanCaps } : {}),
    };
    const added = scope
      ? await addCustomModel(scope.ctx, scope.workspaceId, data)
      : await addCustomModelUnscoped(data);
    await refreshCustomModelCaps();
    return NextResponse.json({ success: true, added });
  } catch (error) {
    if (error?.code === "INVALID") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.log("Error adding custom model:", error);
    return NextResponse.json({ error: "Failed to add custom model" }, { status: 500 });
  }
}

// DELETE /api/models/custom?providerAlias=xxx&id=yyy&type=zzz
export async function DELETE(request) {
  try {
    const scope = await workspaceScope(request, "workspace.combos.manage");
    if (scope instanceof Response) return scope;
    const { searchParams } = new URL(request.url);
    const providerAlias = searchParams.get("providerAlias");
    const id = searchParams.get("id");
    const type = searchParams.get("type") || "llm";
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    if (scope && (isReservedKey(providerAlias) || isReservedKey(id))) {
      return NextResponse.json({ error: "Reserved key prefix" }, { status: 400 });
    }
    const data = { providerAlias, id, type };
    if (scope) {
      await deleteCustomModel(scope.ctx, scope.workspaceId, data);
    } else {
      await deleteCustomModelUnscoped(data);
    }
    await refreshCustomModelCaps();
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error?.code === "INVALID") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.log("Error deleting custom model:", error);
    return NextResponse.json({ error: "Failed to delete custom model" }, { status: 500 });
  }
}
