import { NextResponse } from "next/server";
import { SAVINGS_MILESTONES } from "@/shared/constants/savingsMilestones.js";
import { claimSavingsMilestone } from "@/lib/savingsMilestones.js";

export const dynamic = "force-dynamic";

/**
 * POST /api/shell/savings-milestone — show a savings milestone toast once per
 * install (YAN-408). This route claims the milestone atomically on the server
 * (settings write happens before any toast); the client shows the toast only
 * when the claim succeeds, so two tabs racing never double-fire. Auth:
 * dashboardGuard, same as /api/shell/summary.
 */
export async function POST(request) {
  let body = null;
  try {
    body = await request.json();
  } catch {
    /* invalid JSON handled by the guard below */
  }
  const milestone = body?.milestone;
  if (typeof milestone !== "number" || !SAVINGS_MILESTONES.includes(milestone)) {
    return NextResponse.json(
      { error: `milestone must be one of ${SAVINGS_MILESTONES.join(", ")}` },
      { status: 400 },
    );
  }
  try {
    // Atomically acknowledge; the response value is the milestone this call
    // claimed (null when another client already claimed it).
    return NextResponse.json({ claimedMilestone: await claimSavingsMilestone(milestone) });
  } catch (error) {
    console.error("[API] Failed to claim savings milestone:", error);
    return NextResponse.json({ error: "Failed to claim savings milestone" }, { status: 500 });
  }
}
