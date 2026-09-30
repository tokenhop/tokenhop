import { NextResponse } from "next/server";
import { getModelAliases, setModelAlias, deleteModelAlias } from "@/models";

export const dynamic = "force-dynamic";

// Combo members may be bare aliases (YAN-386): re-sync the poller's target set.
function syncPoller() {
  import("@/shared/services/quotaSnapshotPoller")
    .then(({ syncQuotaSnapshotPoller }) => syncQuotaSnapshotPoller())
    .catch((error) => console.warn("[Aliases] quota poller sync failed:", error?.message));
}

// GET /api/models/alias - Get all aliases
export async function GET() {
  try {
    const aliases = await getModelAliases();
    return NextResponse.json({ aliases });
  } catch (error) {
    console.log("Error fetching aliases:", error);
    return NextResponse.json({ error: "Failed to fetch aliases" }, { status: 500 });
  }
}

// PUT /api/models/alias - Set model alias
export async function PUT(request) {
  try {
    const body = await request.json();
    const { model, alias } = body;

    if (!model || !alias) {
      return NextResponse.json({ error: "Model and alias required" }, { status: 400 });
    }

    await setModelAlias(alias, model);
    syncPoller();

    return NextResponse.json({ success: true, model, alias });
  } catch (error) {
    console.log("Error updating alias:", error);
    return NextResponse.json({ error: "Failed to update alias" }, { status: 500 });
  }
}

// DELETE /api/models/alias?alias=xxx - Delete alias
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const alias = searchParams.get("alias");

    if (!alias) {
      return NextResponse.json({ error: "Alias required" }, { status: 400 });
    }

    await deleteModelAlias(alias);
    syncPoller();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting alias:", error);
    return NextResponse.json({ error: "Failed to delete alias" }, { status: 500 });
  }
}
