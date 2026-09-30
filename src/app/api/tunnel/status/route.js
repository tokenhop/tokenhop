import { NextResponse } from "next/server";
import { getTunnelStatus, getTailscaleStatus, getDownloadStatus } from "@/lib/tunnel";
import { peekTunnelStatus, storeTunnelStatus } from "@/lib/tunnel/statusCache.js";

export async function GET() {
  try {
    // Coalesce rapid polls; mutation routes invalidate after changing state.
    let probes = peekTunnelStatus();
    if (!probes) {
      const [tunnel, tailscale] = await Promise.all([getTunnelStatus(), getTailscaleStatus()]);
      probes = { tunnel, tailscale };
      storeTunnelStatus(probes);
    }
    const download = getDownloadStatus();
    return NextResponse.json({ ...probes, download });
  } catch (error) {
    console.error("Tunnel status error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
