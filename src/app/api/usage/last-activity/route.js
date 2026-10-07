import { NextResponse } from "next/server";
import { getLastActivity } from "@/lib/db/index.js";
import { usageScope } from "@/lib/usage/scope.js";

export const dynamic = "force-dynamic";

// /api/usage/* is protected by src/dashboardGuard.js (proxy middleware).
export async function GET(request) {
  try {
    const scope = await usageScope(request);
    if (scope instanceof Response) return scope;
    return NextResponse.json({ lastRequestAt: await getLastActivity(scope) });
  } catch (error) {
    console.error("[API] Failed to get last activity:", error);
    return NextResponse.json({ error: "Failed to fetch last activity" }, { status: 500 });
  }
}
