import { NextResponse } from "next/server";
import { getUsageStats } from "@/lib/usageDb";
import { usageScope } from "@/lib/usage/scope.js";

export async function GET(request) {
  try {
    const scope = await usageScope(request);
    if (scope instanceof Response) return scope;
    const stats = await getUsageStats(scope);
    return NextResponse.json(stats);
  } catch (error) {
    console.error("Error fetching usage stats:", error);
    return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500 });
  }
}
