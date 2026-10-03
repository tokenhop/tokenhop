import { NextResponse } from "next/server";
import { testSingleConnection } from "./testUtils.js";
import { getConnection } from "@/lib/db/index.js";
import { getProviderConnectionByIdUnscoped } from "@/lib/localDb";
import { loadScoped } from "@/lib/users/workspaceScope.js";

const loadConnection = (capability, id) =>
  loadScoped(
    capability,
    id,
    getConnection,
    getProviderConnectionByIdUnscoped,
    "Connection not found",
  );

// POST /api/providers/[id]/test - Test connection
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    // YAN-361: the row must be usable by the principal before the test writes to it.
    const loaded = await loadConnection("workspace.connections.use", id);
    if (loaded instanceof Response) return loaded;
    const result = await testSingleConnection(id);

    if (result.error === "Connection not found") {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    return NextResponse.json({
      valid: result.valid,
      error: result.error,
      refreshed: result.refreshed || false,
    });
  } catch (error) {
    console.log("Error testing connection:", error);
    return NextResponse.json({ error: "Test failed" }, { status: 500 });
  }
}
