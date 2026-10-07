import { NextResponse } from "next/server";
import { getRecentLogs } from "@/lib/usageDb";
import { usageScope } from "@/lib/usage/scope.js";

export async function GET(request) {
  try {
    const scope = await usageScope(request);
    if (scope instanceof Response) return scope;
    const logs = await getRecentLogs(scope, 200);
    return NextResponse.json(logs);
  } catch (error) {
    console.error("Error fetching logs:", error);
    return NextResponse.json({ error: "Failed to fetch logs" }, { status: 500 });
  }
}
