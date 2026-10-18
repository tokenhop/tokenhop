import { NextResponse } from "next/server";
import { getRollupUsageTotals, getUsageStats, getUsageTotals } from "@/lib/usageDb";
import {
  isPeriod,
  isRollupOnlyPeriod,
  periodStart,
  previousPeriodRange,
} from "@/shared/utils/period";
import { usageScope } from "@/lib/usage/scope.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";
    const compare = searchParams.get("compare");

    if (!isPeriod(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }
    // Optional compare=previous adds `currentTotals` + `previous` computed
    // from the same windows, so both sides of a delta match: usageHistory for
    // today..60d, usageRollup for 90d/all ("all" has `previous: null`).
    if (compare !== null && compare !== "previous") {
      return NextResponse.json({ error: "Invalid compare" }, { status: 400 });
    }

    const scope = await usageScope(request);
    if (scope instanceof Response) return scope;

    const stats = await getUsageStats(scope, period);
    if (compare === "previous" && isRollupOnlyPeriod(period)) {
      return NextResponse.json({ ...stats, ...(await getRollupUsageTotals(scope, period)) });
    }
    if (compare === "previous") {
      const now = Date.now();
      const currentRange = { start: periodStart(period, now), end: now };
      const previousRange = previousPeriodRange(period, now);
      const [currentTotals, previous] = await Promise.all([
        getUsageTotals(scope, currentRange),
        getUsageTotals(scope, previousRange),
      ]);
      return NextResponse.json({ ...stats, currentTotals, previous });
    }
    return NextResponse.json(stats);
  } catch (error) {
    console.error("[API] Failed to get usage stats:", error);
    return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500 });
  }
}
