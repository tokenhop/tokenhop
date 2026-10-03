import { NextResponse } from "next/server";
import { getUsageStatsUnscoped } from "@/lib/usageDb";

export async function GET() {
  try {
    const stats = await getUsageStatsUnscoped();
    return NextResponse.json(stats);
  } catch (error) {
    console.error("Error fetching usage stats:", error);
    return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500 });
  }
}
