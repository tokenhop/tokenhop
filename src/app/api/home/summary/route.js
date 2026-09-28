import { NextResponse } from "next/server";
import { getHomeSummary } from "@/lib/db/index.js";

const VALID_PERIODS = new Set(["today", "7d", "30d"]);
export const dynamic = "force-dynamic";

// /api/* is deny-by-default protected by src/dashboardGuard.js (proxy middleware).
export async function GET(request) {
  const period = new URL(request.url).searchParams.get("period") || "7d";
  if (!VALID_PERIODS.has(period)) {
    return NextResponse.json({ error: "Invalid period" }, { status: 400 });
  }
  try {
    return NextResponse.json(await getHomeSummary(period));
  } catch (error) {
    console.error("[API] Failed to get home summary:", error);
    return NextResponse.json({ error: "Failed to fetch home summary" }, { status: 500 });
  }
}
