import { NextResponse } from "next/server";
import { getRecentLogsUnscoped } from "@/lib/usageDb";

export async function GET() {
  try {
    const logs = await getRecentLogsUnscoped(200);
    return NextResponse.json(logs);
  } catch (error) {
    console.error("[API ERROR] /api/usage/logs failed:", error);
    console.error("[API ERROR] Stack:", error?.stack);
    return NextResponse.json({ error: "Failed to fetch logs" }, { status: 500 });
  }
}
