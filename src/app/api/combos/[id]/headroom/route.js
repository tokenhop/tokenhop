import { NextResponse } from "next/server";
import { getComboById } from "@/lib/localDb";
import { getCombo } from "@/lib/db/index.js";
import { loadScoped } from "@/lib/users/workspaceScope.js";
import { loadComboHeadroomDetailFn } from "@/sse/services/comboHeadroom.js";

// GET /api/combos/[id]/headroom - Headroom per combo member (YAN-261).
// Additive detail (YAN-411): `quotaByModel` maps each member to
// { headroom, source } so the editor can explain which quota numbers shifted
// the effective shares.
export async function GET(_request, { params }) {
  try {
    const { id } = await params;
    // YAN-364 IDOR: scoped load first — another workspace's id is a 404.
    const loaded = await loadScoped(
      "workspace.connections.metadata.read",
      id,
      getCombo,
      getComboById,
      "Combo not found",
    );
    if (loaded instanceof Response) return loaded;
    const combo = loaded.row;

    const fn = await loadComboHeadroomDetailFn();
    const models = Array.isArray(combo.models) ? combo.models : [];
    const quotaByModel = Object.fromEntries(models.map((m) => [m, fn(m)]));
    return NextResponse.json({
      headroom: Object.fromEntries(models.map((m) => [m, quotaByModel[m].headroom])),
      quotaByModel,
    });
  } catch (error) {
    console.log("Error fetching combo headroom:", error);
    return NextResponse.json({ error: "Failed to fetch combo headroom" }, { status: 500 });
  }
}
