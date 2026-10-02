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

// Remote users can write here, so bound what lands in the DB and aliases.json.
const MAX_MAPPINGS = 200;
const MAX_LENGTH = 256;

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

    const entries = Object.entries(mappings);
    if (entries.length > MAX_MAPPINGS) {
      return NextResponse.json({ error: "too many mappings" }, { status: 400 });
    }
    if (
      entries.some(
        ([alias, model]) =>
          typeof model !== "string" || alias.length > MAX_LENGTH || model.length > MAX_LENGTH,
      )
    ) {
      return NextResponse.json(
        { error: `mapping values must be strings of at most ${MAX_LENGTH} characters` },
        { status: 400 },
      );
    }

    // Null prototype: an alias named "__proto__" is stored as a plain key.
    const filtered = Object.create(null);
    for (const [alias, model] of entries) {
      if (model.trim()) {
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
