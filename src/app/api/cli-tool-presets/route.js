import { NextResponse } from "next/server";
import { getCliToolPresets, setCliToolPresets } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

// Lives outside /api/cli-tools/ on purpose: that prefix is local-only, and this route is
// DB-only (no fs), so signed-in remote dashboards can use it.
const MAX_BYTES = 16384;
const MAX_ITEMS = 64;
const KINDS = { endpoints: "baseUrl", apiKeys: "key" };

const isPlainObject = (v) =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;

const isStr = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;

function validate(body) {
  const field = KINDS[body?.kind];
  if (!field) return 'kind must be "endpoints" or "apiKeys"';
  if (!Array.isArray(body.items) || body.items.length > MAX_ITEMS) {
    return `items must be an array of at most ${MAX_ITEMS} presets`;
  }
  for (const item of body.items) {
    if (!isPlainObject(item)) return "each preset must be a plain object";
    const keys = Object.keys(item);
    if (keys.length !== 2 || !keys.includes("name") || !keys.includes(field)) {
      return `each preset must have exactly the keys "name" and "${field}"`;
    }
    if (!isStr(item.name, 128)) return "preset name must be a string of 1..128 characters";
    if (!isStr(item[field], 2048)) return `preset ${field} must be a string of 1..2048 characters`;
  }
  return null;
}

// GET - All saved presets ({ endpoints: [...], apiKeys: [...] })
export async function GET() {
  try {
    return NextResponse.json({ presets: await getCliToolPresets() });
  } catch (error) {
    console.log("Error fetching CLI tool presets:", error.message);
    return NextResponse.json({ error: "Failed to fetch presets" }, { status: 500 });
  }
}

// PUT - Replace the preset list for one kind
export async function PUT(request) {
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BYTES) {
      return NextResponse.json({ error: "Presets payload too large" }, { status: 413 });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const bad = validate(parsed);
    if (bad) return NextResponse.json({ error: bad }, { status: 400 });

    await setCliToolPresets(parsed.kind, parsed.items);
    return NextResponse.json({ presets: await getCliToolPresets() });
  } catch (error) {
    console.log("Error saving CLI tool presets:", error.message);
    return NextResponse.json({ error: "Failed to save presets" }, { status: 500 });
  }
}
