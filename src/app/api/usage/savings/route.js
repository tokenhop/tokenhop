import { NextResponse } from "next/server";
import { getSavingsTotals, getUsageSavings } from "@/lib/db/index.js";
import { isHistoryPeriod, periodStart, previousPeriodRange } from "@/shared/utils/period";
import { usageScope } from "@/lib/usage/scope.js";

export const dynamic = "force-dynamic";

// /api/usage/* is protected by src/dashboardGuard.js (proxy middleware).
export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const period = params.get("period") || "7d";
  if (!isHistoryPeriod(period)) {
    return NextResponse.json({ error: "Invalid period" }, { status: 400 });
  }
  // Validated before scope resolution, like the stats route.
  const compare = params.get("compare");
  if (compare !== null && compare !== "previous") {
    return NextResponse.json({ error: "Invalid compare" }, { status: 400 });
  }
  try {
    const scope = await usageScope(request);
    if (scope instanceof Response) return scope;
    if (compare !== "previous") return NextResponse.json(await getUsageSavings(scope, period));

    // One instant and one scope for all three reads.
    const now = Date.now();
    const [savings, currentTotals, previous] = await Promise.all([
      getUsageSavings(scope, period, now),
      // getSavingsTotals is half-open; +1ms makes the current window inclusive of
      // `now`, matching the headline's `timestamp <= now` (ms ISO timestamps).
      getSavingsTotals(scope, { start: periodStart(period, now), end: now + 1 }),
      getSavingsTotals(scope, previousPeriodRange(period, now)),
    ]);
    return NextResponse.json({ ...savings, currentTotals, previous });
  } catch (error) {
    console.error("[API] Failed to get usage savings:", error);
    return NextResponse.json({ error: "Failed to fetch savings" }, { status: 500 });
  }
}
