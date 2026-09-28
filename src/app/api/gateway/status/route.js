import { NextResponse } from "next/server";
import { resolveListenPort, shapeGatewayStatus } from "@/lib/gatewayStatus";

export const dynamic = "force-dynamic";

/**
 * Authenticated gateway status. Not on the public allowlist, so the same
 * dashboard auth as `/api/settings` applies. No secrets, no env dump.
 */
export async function GET() {
  const body = shapeGatewayStatus({
    uptimeSeconds: process.uptime(),
    nowMs: Date.now(),
    port: resolveListenPort(process.env, process.argv),
  });
  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}
