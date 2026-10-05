import { NextResponse } from "next/server";
import { enableTunnel } from "@/lib/tunnel";
import { invalidateTunnelStatusCache } from "@/lib/tunnel/statusCache.js";
import { getSettings } from "@/lib/localDb";
import { configureTunnelMonitoring } from "@/shared/services/initializeApp";
import { audit } from "@/lib/users/audit.js";

const DNS_WARMUP_DELAY_MS = 8000;

export async function POST() {
  try {
    const result = await enableTunnel();
    invalidateTunnelStatusCache();
    getSettings()
      .then(configureTunnelMonitoring)
      .catch((error) => console.warn("Tunnel monitor start failed:", error.message));
    // Wait for DNS warmup to propagate at Cloudflare edge after tunnel registered
    await new Promise((r) => setTimeout(r, DNS_WARMUP_DELAY_MS));
    // YAN-367: host op audit — result summary only, never tunnel secrets.
    await audit(
      {},
      "hostOps.tunnel",
      { type: "hostOp", id: "tunnel/enable" },
      {
        after: { op: "enable", enabled: result?.enabled ?? null },
      },
    );
    return NextResponse.json(result);
  } catch (error) {
    console.error("Tunnel enable error:", error);
    await audit(
      {},
      "hostOps.tunnel",
      { type: "hostOp", id: "tunnel/enable" },
      {
        after: { op: "enable" },
        result: "failure",
      },
    );
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
