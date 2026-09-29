import { NextResponse } from "next/server";
import { getLastActivity } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

// /api/usage/* is protected by src/dashboardGuard.js (proxy middleware).
export async function GET() {
  try {
    return NextResponse.json({ lastRequestAt: await getLastActivity() });
  } catch (error) {
    console.error("[API] Failed to get last activity:", error);
    return NextResponse.json({ error: "Failed to fetch last activity" }, { status: 500 });
  }
}
