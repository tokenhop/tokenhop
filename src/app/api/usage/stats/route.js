import { NextResponse } from "next/server";
import { getUsageStats, getUsageTotals } from "@/lib/usageDb";
import { isPeriod, periodStart, previousPeriodRange } from "@/shared/utils/period";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";
    const compare = searchParams.get("compare");

    if (period !== "all" && !isPeriod(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }
    // Optional compare=previous adds `currentTotals` + `previous` computed
    // from the same usageHistory windows, so both sides of a delta match.
    // "all" has no previous window, so comparison stays off there.
    if (compare !== null && (compare !== "previous" || !isPeriod(period))) {
      return NextResponse.json({ error: "Invalid compare" }, { status: 400 });
    }

    const stats = await getUsageStats(period);
    if (compare === "previous") {
      const now = Date.now();
      const currentRange = { start: periodStart(period, now), end: now };
      const previousRange = previousPeriodRange(period, now);
      const [currentTotals, previous] = await Promise.all([
        getUsageTotals(currentRange),
        getUsageTotals(previousRange),
      ]);
      return NextResponse.json({ ...stats, currentTotals, previous });
    }
    return NextResponse.json(stats);
  } catch (error) {
    console.error("[API] Failed to get usage stats:", error);
    return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500 });
  }
}
