import { NextResponse } from "next/server";
import { getApiKeys, createApiKey, getApiKeyUsage } from "@/lib/localDb";
import { validateKeyName } from "@/app/(dashboard)/dashboard/endpoint/endpointLogic";
import { getConsistentMachineId } from "@/shared/utils/machineId";

export const dynamic = "force-dynamic";

/**
 * Augment keys with lastUsed + requestsToday.
 * Usage failure must never break key listing → defaults to null / 0.
 */
async function withUsage(keys) {
  let usage = { lastUsed: {}, today: {} };
  try {
    usage = await getApiKeyUsage();
  } catch (err) {
    console.error("Failed to read apiKey usage:", err);
  }
  return keys.map((k) => ({
    ...k,
    lastUsed: usage.lastUsed?.[k.key] ?? null,
    requestsToday: usage.today?.[k.key] ?? 0,
  }));
}

// GET /api/keys - List API keys
export async function GET() {
  try {
    const keys = await getApiKeys();
    return NextResponse.json({ keys: await withUsage(keys) });
  } catch (error) {
    console.log("Error fetching keys:", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key
export async function POST(request) {
  try {
    const body = await request.json();
    const { name } = body;

    // Same rule as rename/PUT: no blank, oversized, or control-character names.
    const nameError = validateKeyName(name);
    if (nameError) {
      return NextResponse.json({ error: nameError }, { status: 400 });
    }

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    const apiKey = await createApiKey(name.trim(), machineId);

    return NextResponse.json(
      {
        key: apiKey.key,
        name: apiKey.name,
        id: apiKey.id,
        machineId: apiKey.machineId,
      },
      { status: 201 },
    );
  } catch (error) {
    console.log("Error creating key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}
