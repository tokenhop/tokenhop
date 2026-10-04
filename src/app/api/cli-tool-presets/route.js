import { NextResponse } from "next/server";
import { getCliToolPresets, setCliToolPresets } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

// Lives outside /api/cli-tools/ on purpose: that prefix is local-only, and this route is
// DB-only (no fs), so signed-in remote dashboards can use it.
//
// YAN-363 hashed storage adds contract shapes for kind "apiKeys" (repo validates
// authorization and converts/preserves); legacy storage keeps today's exact
// { name, key } contract and response bytes.
const MAX_BYTES = 16384;
const MAX_ITEMS = 64;
const KINDS = { endpoints: "baseUrl", apiKeys: "key" };

const isPlainObject = (v) =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;

const isStr = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;

// apiKeys items: legacy raw { name, key }, hashed ref { name, apiKeyId }, or the
// projected external marker { name, external: true, externalRef } round-trip.
function validApiKeyItem(item) {
  const keys = Object.keys(item);
  if (keys.length === 2 && isStr(item.name, 128) && isStr(item.key, 2048)) return null;
  if (keys.length === 2 && isStr(item.name, 128) && isStr(item.apiKeyId, 128)) return null;
  if (
    keys.length === 3 &&
    isStr(item.name, 128) &&
    item.external === true &&
    /^[0-9a-f]{64}$/.test(item.externalRef ?? "")
  ) {
    return null;
  }
  return "each apiKey preset must be { name, key }, { name, apiKeyId } or the projected external marker";
}

function validate(body) {
  if (!Object.hasOwn(KINDS, body?.kind)) return 'kind must be "endpoints" or "apiKeys"';
  if (!Array.isArray(body.items) || body.items.length > MAX_ITEMS) {
    return `items must be an array of at most ${MAX_ITEMS} presets`;
  }
  for (const item of body.items) {
    if (!isPlainObject(item)) return "each preset must be a plain object";
    if (body.kind === "endpoints") {
      const keys = Object.keys(item);
      if (keys.length !== 2 || !keys.includes("name") || !keys.includes("baseUrl")) {
        return 'each preset must have exactly the keys "name" and "baseUrl"';
      }
      if (!isStr(item.name, 128)) return "preset name must be a string of 1..128 characters";
      if (!isStr(item.baseUrl, 2048))
        return "preset baseUrl must be a string of 1..2048 characters";
      if (!/^https?:\/\//i.test(item.baseUrl)) {
        return "endpoint baseUrl must be an http(s) URL";
      }
    } else if (validApiKeyItem(item)) {
      return validApiKeyItem(item);
    }
  }
  return null;
}

const respond = (error) =>
  error?.status
    ? NextResponse.json({ error: error.message }, { status: error.status })
    : (console.log("Error on CLI tool presets:", error.message),
      NextResponse.json({ error: "Failed to save presets" }, { status: 500 }));

// GET - All saved presets ({ endpoints: [...], apiKeys: [...] })
export async function GET() {
  try {
    return NextResponse.json({ presets: await getCliToolPresets() });
  } catch (error) {
    return respond(error);
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

    await setCliToolPresets(undefined, parsed.kind, parsed.items);
    return NextResponse.json({ presets: await getCliToolPresets() });
  } catch (error) {
    return respond(error);
  }
}
