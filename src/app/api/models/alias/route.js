import { NextResponse } from "next/server";
import {
  deleteModelAlias,
  deleteModelAliasUnscoped,
  getModelAliases,
  getModelAliasesUnscoped,
  setModelAlias,
  setModelAliasUnscoped,
} from "@/lib/db/index.js";
import { workspaceScope } from "@/lib/users/workspaceScope.js";

export const dynamic = "force-dynamic";

// Combo members may be bare aliases (YAN-386): re-sync the poller's target set.
function syncPoller() {
  import("@/shared/services/quotaSnapshotPoller")
    .then(({ syncQuotaSnapshotPoller }) => syncQuotaSnapshotPoller())
    .catch((error) => console.warn("[Aliases] quota poller sync failed:", error?.message));
}

// Scoped writes reject the reserved `ws:` key namespace (ADR-0001).
function isReservedKey(key) {
  return typeof key === "string" && key.startsWith("ws:");
}

// GET /api/models/alias - Get all aliases
export async function GET(request) {
  try {
    const scope = await workspaceScope(request, "workspace.connections.metadata.read");
    if (scope instanceof Response) return scope;
    const aliases = scope
      ? await getModelAliases(scope.ctx, scope.workspaceId)
      : await getModelAliasesUnscoped();
    return NextResponse.json({ aliases });
  } catch (error) {
    console.log("Error fetching aliases:", error);
    return NextResponse.json({ error: "Failed to fetch aliases" }, { status: 500 });
  }
}

// PUT /api/models/alias - Set model alias
export async function PUT(request) {
  try {
    const scope = await workspaceScope(request, "workspace.combos.manage");
    if (scope instanceof Response) return scope;
    const body = await request.json();
    const { model, alias } = body;

    if (!model || !alias) {
      return NextResponse.json({ error: "Model and alias required" }, { status: 400 });
    }

    if (scope && isReservedKey(alias)) {
      return NextResponse.json({ error: "Reserved key prefix" }, { status: 400 });
    }

    if (scope) {
      await setModelAlias(scope.ctx, scope.workspaceId, alias, model);
    } else {
      await setModelAliasUnscoped(alias, model);
    }
    syncPoller();

    return NextResponse.json({ success: true, model, alias });
  } catch (error) {
    if (error?.code === "INVALID") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.log("Error updating alias:", error);
    return NextResponse.json({ error: "Failed to update alias" }, { status: 500 });
  }
}

// DELETE /api/models/alias?alias=xxx - Delete alias
export async function DELETE(request) {
  try {
    const scope = await workspaceScope(request, "workspace.combos.manage");
    if (scope instanceof Response) return scope;
    const { searchParams } = new URL(request.url);
    const alias = searchParams.get("alias");

    if (!alias) {
      return NextResponse.json({ error: "Alias required" }, { status: 400 });
    }

    if (scope && isReservedKey(alias)) {
      return NextResponse.json({ error: "Reserved key prefix" }, { status: 400 });
    }

    if (scope) {
      await deleteModelAlias(scope.ctx, scope.workspaceId, alias);
    } else {
      await deleteModelAliasUnscoped(alias);
    }
    syncPoller();

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error?.code === "INVALID") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.log("Error deleting alias:", error);
    return NextResponse.json({ error: "Failed to delete alias" }, { status: 500 });
  }
}
