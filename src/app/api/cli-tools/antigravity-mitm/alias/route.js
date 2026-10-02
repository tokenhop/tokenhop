"use server";

import { NextResponse } from "next/server";
import { getMitmAlias, setMitmAliasAll } from "@/models";
import { MITM_TOOLS } from "@/shared/constants/cliTools";
import { writeAliasForTool } from "@/lib/mitmAliasCache";

// GET - Get MITM aliases for a tool
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const toolName = searchParams.get("tool");
    const aliases = await getMitmAlias(toolName || undefined);
    return NextResponse.json({ aliases });
  } catch (error) {
    console.log("Error fetching MITM aliases:", error.message);
    return NextResponse.json({ error: "Failed to fetch aliases" }, { status: 500 });
  }
}

// PUT - Save MITM aliases for a specific tool
export async function PUT(request) {
  try {
    const { tool, mappings } = await request.json();

    if (!tool || !mappings || typeof mappings !== "object" || Array.isArray(mappings)) {
      return NextResponse.json({ error: "tool and mappings required" }, { status: 400 });
    }

    // Remote users can reach this route, so only known MITM tools are writable.
    if (!Object.hasOwn(MITM_TOOLS, tool)) {
      return NextResponse.json({ error: "Unknown MITM tool" }, { status: 400 });
    }

    if (Object.values(mappings).some((model) => typeof model !== "string")) {
      return NextResponse.json({ error: "mapping values must be strings" }, { status: 400 });
    }

    const filtered = {};
    for (const [alias, model] of Object.entries(mappings)) {
      if (model && model.trim()) {
        filtered[alias] = model.trim();
      }
    }

    await setMitmAliasAll(tool, filtered);
    writeAliasForTool(tool, filtered);
    return NextResponse.json({ success: true, aliases: filtered });
  } catch (error) {
    console.log("Error saving MITM aliases:", error.message);
    return NextResponse.json({ error: "Failed to save aliases" }, { status: 500 });
  }
}
