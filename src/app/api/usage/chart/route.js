import { NextResponse } from "next/server";
import { getChartData } from "@/lib/usageDb";
import { isPeriod } from "@/shared/utils/period";
import { usageScope } from "@/lib/usage/scope.js";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";

    if (!isPeriod(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    const scope = await usageScope(request);
    if (scope instanceof Response) return scope;
    const data = await getChartData(scope, period);
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Failed to get chart data:", error);
    return NextResponse.json({ error: "Failed to fetch chart data" }, { status: 500 });
  }
}
