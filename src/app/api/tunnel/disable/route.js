import { NextResponse } from "next/server";
import { disableTunnel } from "@/lib/tunnel";
import { invalidateTunnelStatusCache } from "@/lib/tunnel/statusCache.js";
import { getSettings } from "@/lib/localDb";
import { configureTunnelMonitoring } from "@/shared/services/initializeApp";
import { audit } from "@/lib/users/audit.js";

export async function POST() {
  try {
    const result = await disableTunnel();
    invalidateTunnelStatusCache();
    getSettings()
      .then(configureTunnelMonitoring)
      .catch((error) => console.warn("Tunnel monitor update failed:", error.message));
    await audit(
      {},
      "hostOps.tunnel",
      { type: "hostOp", id: "tunnel/disable" },
      {
        after: { op: "disable" },
      },
    );
    return NextResponse.json(result);
  } catch (error) {
    console.error("Tunnel disable error:", error);
    await audit(
      {},
      "hostOps.tunnel",
      { type: "hostOp", id: "tunnel/disable" },
      {
        after: { op: "disable" },
        result: "failure",
      },
    );
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
