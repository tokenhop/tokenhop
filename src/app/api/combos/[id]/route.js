import { NextResponse } from "next/server";
import { getCombos, getComboById, updateCombo, deleteCombo, getComboByName } from "@/lib/localDb";
import { findComboCycle, isModelList, resetComboRotation } from "open-sse/services/combo.js";
import { isValidComboKind } from "@/shared/constants/mediaProviderKinds";

const BLOCKED_COMBO_NAMES = new Set(["__proto__", "constructor", "prototype"]);

const VALID_NAME_REGEX = /^[a-zA-Z0-9_.-]+$/;

// GET /api/combos/[id] - Get combo by ID
export async function GET(_request, { params }) {
  try {
    const { id } = await params;
    const combo = await getComboById(id);

    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    return NextResponse.json(combo);
  } catch (error) {
    console.log("Error fetching combo:", error);
    return NextResponse.json({ error: "Failed to fetch combo" }, { status: 500 });
  }
}

// PUT /api/combos/[id] - Update combo
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    // Capture previous name to invalidate rotation state on rename
    const prev = await getComboById(id);
    if (!prev) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    // Validate name format if provided
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !VALID_NAME_REGEX.test(body.name)) {
        return NextResponse.json(
          { error: "Name can only contain letters, numbers, -, _ and ." },
          { status: 400 },
        );
      }

      if (BLOCKED_COMBO_NAMES.has(body.name)) {
        return NextResponse.json({ error: `Invalid combo name "${body.name}"` }, { status: 400 });
      }

      // Check if name already exists (exclude current combo)
      const existing = await getComboByName(body.name);
      if (existing && existing.id !== id) {
        return NextResponse.json({ error: "Combo name already exists" }, { status: 400 });
      }
    }

    if (body.models !== undefined && !isModelList(body.models)) {
      return NextResponse.json({ error: "Models must be an array of strings" }, { status: 400 });
    }

    if (body.kind !== undefined && !isValidComboKind(body.kind)) {
      return NextResponse.json({ error: `Invalid combo kind "${body.kind}"` }, { status: 400 });
    }

    if (body.name !== undefined || body.models !== undefined) {
      const others = (await getCombos()).filter((c) => c.id !== id);
      const cycle = findComboCycle(
        body.name ?? prev.name,
        body.models ?? prev.models ?? [],
        others,
      );
      if (cycle) {
        return NextResponse.json(
          { error: `Combo cycle detected: ${cycle.join(" → ")}` },
          { status: 400 },
        );
      }
    }

    const combo = await updateCombo(id, body);

    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    // Strategy migration now rides updateCombo's transaction; rotation
    // state still resets after successful write.
    if (prev?.name) resetComboRotation(prev.name);
    if (combo.name && combo.name !== prev?.name) resetComboRotation(combo.name);

    import("@/shared/services/quotaSnapshotPoller")
      .then(({ syncQuotaSnapshotPoller }) => syncQuotaSnapshotPoller())
      .catch((error) => console.warn("[Combos] quota poller sync failed:", error?.message));

    return NextResponse.json(combo);
  } catch (error) {
    console.log("Error updating combo:", error);
    return NextResponse.json({ error: "Failed to update combo" }, { status: 500 });
  }
}

// DELETE /api/combos/[id] - Delete combo
export async function DELETE(_request, { params }) {
  try {
    const { id } = await params;
    const prev = await getComboById(id);
    const success = await deleteCombo(id);

    if (!success) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    // deleteCombo drops combo row + own strategy key in one transaction.
    if (prev?.name) resetComboRotation(prev.name);

    import("@/shared/services/quotaSnapshotPoller")
      .then(({ syncQuotaSnapshotPoller }) => syncQuotaSnapshotPoller())
      .catch((error) => console.warn("[Combos] quota poller sync failed:", error?.message));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting combo:", error);
    return NextResponse.json({ error: "Failed to delete combo" }, { status: 500 });
  }
}
