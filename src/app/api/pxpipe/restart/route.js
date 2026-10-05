import { NextResponse } from "next/server";
import { unloadPxpipe, loadPxpipe } from "@/lib/pxpipe/loader.js";
import { getPxpipeStatus } from "@/lib/pxpipe/service.js";
import { audit } from "@/lib/users/audit.js";

export const dynamic = "force-dynamic";

// Reload the in-process module (picks up an upgraded install without a server restart).
export async function POST() {
  try {
    unloadPxpipe();
    await loadPxpipe();
    // YAN-367: host op audit.
    await audit(
      {},
      "hostOps.pxpipe",
      { type: "hostOp", id: "pxpipe/restart" },
      { after: { op: "restart" } },
    );
    return NextResponse.json(getPxpipeStatus());
  } catch (error) {
    return NextResponse.json({ error: error.message, code: error.code || null }, { status: 500 });
  }
}
