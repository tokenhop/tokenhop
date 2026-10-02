import { NextResponse } from "next/server";
import { getCliToolSettings } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

// GET - Saved settings for every CLI tool, keyed by toolId
export async function GET() {
  try {
    return NextResponse.json({ settings: await getCliToolSettings() });
  } catch (error) {
    console.log("Error fetching CLI tool settings:", error.message);
    return NextResponse.json({ error: "Failed to fetch settings" }, { status: 500 });
  }
}
