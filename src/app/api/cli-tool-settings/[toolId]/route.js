import { NextResponse } from "next/server";
import { deleteCliToolSettings, getCliToolSettings, setCliToolSettings } from "@/lib/db/index.js";
import { CLI_TOOLS } from "@/shared/constants/cliTools";
import { isValidToolSettings } from "@/lib/cliToolConfigs/toolSettings";

export const dynamic = "force-dynamic";

// Lives outside /api/cli-tools/ on purpose: that prefix is local-only, and these routes
// are DB-only (no fs), so signed-in remote dashboards can use them.
const MAX_BYTES = 16384;

const unknownTool = (toolId) =>
  Object.hasOwn(CLI_TOOLS, toolId)
    ? null
    : NextResponse.json({ error: "Unknown CLI tool" }, { status: 400 });

// GET - Saved settings for one tool ({} when none)
export async function GET(_request, { params }) {
  try {
    const { toolId } = await params;
    const bad = unknownTool(toolId);
    if (bad) return bad;
    return NextResponse.json({ settings: await getCliToolSettings(toolId) });
  } catch (error) {
    console.log("Error fetching CLI tool settings:", error.message);
    return NextResponse.json({ error: "Failed to fetch settings" }, { status: 500 });
  }
}

// PUT - Replace saved settings for one tool
export async function PUT(request, { params }) {
  try {
    const { toolId } = await params;
    const bad = unknownTool(toolId);
    if (bad) return bad;

    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BYTES) {
      return NextResponse.json({ error: "Settings payload too large" }, { status: 413 });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    if (!isValidToolSettings(parsed)) {
      return NextResponse.json(
        {
          error:
            "Settings must be a JSON object of strings, numbers, booleans, arrays of them or of flat objects, or one nested level of them",
        },
        { status: 400 },
      );
    }

    await setCliToolSettings(toolId, parsed);
    return NextResponse.json({ settings: parsed });
  } catch (error) {
    console.log("Error saving CLI tool settings:", error.message);
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }
}

// DELETE - Clear saved settings for one tool
export async function DELETE(_request, { params }) {
  try {
    const { toolId } = await params;
    const bad = unknownTool(toolId);
    if (bad) return bad;
    await deleteCliToolSettings(toolId);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting CLI tool settings:", error.message);
    return NextResponse.json({ error: "Failed to delete settings" }, { status: 500 });
  }
}
