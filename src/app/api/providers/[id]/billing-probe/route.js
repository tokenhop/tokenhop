import { NextResponse } from "next/server";
import { getConnection } from "@/lib/db/index.js";
import { getProviderConnectionByIdUnscoped } from "@/lib/localDb";
import { loadScoped } from "@/lib/users/workspaceScope.js";
import { PROBE_RESULT, probeBillingConnection } from "@/shared/services/billingProbe.js";

const loadConnection = (capability, id) =>
  loadScoped(
    capability,
    id,
    getConnection,
    getProviderConnectionByIdUnscoped,
    "Connection not found",
  );

// POST /api/providers/[id]/billing-probe - run the credit-recovery probe now.
// A probe spends real tokens on the connection's key, so it requires the
// connection MANAGE capability (stricter than the read-only connection test).
// It shares its single-flight lease with the background scheduler and is
// rate-limited server-side. The response carries only the lock (fixed message,
// allowlisted codes) — never credentials or upstream free text.
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const loaded = await loadConnection("workspace.connections.manage", id);
    if (loaded instanceof Response) return loaded;

    const { result, billingLock, retryAfterMs } = await probeBillingConnection(id, {
      manual: true,
    });
    const lock = billingLock ?? null;
    if (result === PROBE_RESULT.notFound) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }
    if (result === PROBE_RESULT.disabled) {
      return NextResponse.json(
        { error: "Connection is disabled", result, billingLock: lock },
        { status: 409 },
      );
    }
    if (result === PROBE_RESULT.rateLimited) {
      return NextResponse.json(
        { result, billingLock: lock, retryAfterMs },
        {
          status: 429,
          headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
        },
      );
    }
    return NextResponse.json({ result, billingLock: lock });
  } catch (error) {
    console.log("Error probing connection billing:", error?.message);
    return NextResponse.json({ error: "Billing probe failed" }, { status: 500 });
  }
}
