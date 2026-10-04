import { NextResponse } from "next/server";
import { reorderCombos } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

// PUT /api/combos/reorder — persist a manual combo order. Body: { ids: string[] }
// listing the dashboard's combo ids in their new relative order.
export async function PUT(request) {
  try {
    const body = await request.json();
    const ids = body?.ids;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      return NextResponse.json({ error: "ids must be an array of combo ids" }, { status: 400 });
    }
    await reorderCombos(ids);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.log("Error reordering combos:", error);
    return NextResponse.json({ error: "Failed to reorder combos" }, { status: 500 });
  }
}
