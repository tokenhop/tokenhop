import { NextResponse } from "next/server";
import { getHomeSummary } from "@/lib/db/index.js";
import { isPeriod } from "@/shared/utils/period";
import { usageScope } from "@/lib/usage/scope.js";

export const dynamic = "force-dynamic";

// /api/* is deny-by-default protected by src/dashboardGuard.js (proxy middleware).
export async function GET(request) {
  const period = new URL(request.url).searchParams.get("period") || "7d";
  if (!isPeriod(period)) {
    return NextResponse.json({ error: "Invalid period" }, { status: 400 });
  }
  try {
    const scope = await usageScope(request);
    if (scope instanceof Response) return scope;
    return NextResponse.json(await getHomeSummary(scope, period));
  } catch (error) {
    console.error("[API] Failed to get home summary:", error);
    return NextResponse.json({ error: "Failed to fetch home summary" }, { status: 500 });
  }
}
