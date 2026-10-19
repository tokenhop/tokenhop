import { NextResponse } from "next/server";
import { getChartData } from "@/lib/usageDb";
import { isCustomPeriod, isPeriod, localTodayKey, parseDateRange } from "@/shared/utils/period";
import { usageScope } from "@/lib/usage/scope.js";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";

    let range = null;
    if (isCustomPeriod(period)) {
      const parsed = parseDateRange(
        searchParams.get("from"),
        searchParams.get("to"),
        localTodayKey(),
        // Server accepts `to` one day past its local today so a browser timezone ahead of the server still validates.
        { futureToleranceDays: 1 },
      );
      if (!parsed.ok) {
        return NextResponse.json(
          { error: parsed.message, code: "invalid_request", reason: parsed.reason },
          { status: 400 },
        );
      }
      range = { from: parsed.from, to: parsed.to };
    } else if (!isPeriod(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    const scope = await usageScope(request);
    if (scope instanceof Response) return scope;
    const data = await getChartData(scope, period, range);
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Failed to get chart data:", error);
    return NextResponse.json({ error: "Failed to fetch chart data" }, { status: 500 });
  }
}
