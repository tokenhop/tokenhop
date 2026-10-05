import { NextResponse } from "next/server";
import { getCombos, getComboById, updateCombo, deleteCombo, getComboByName } from "@/lib/localDb";
import {
  getCombo,
  updateCombo as updateComboScoped,
  deleteCombo as deleteComboScoped,
  listCombos,
  getComboByNameScoped,
} from "@/lib/db/index.js";
import { loadScoped } from "@/lib/users/workspaceScope.js";
import { comboRotationKey } from "@/lib/comboKeys.js";
import { findComboCycle, isModelList, resetComboRotation } from "open-sse/services/combo.js";
import { isValidComboKind } from "@/shared/constants/mediaProviderKinds";

const BLOCKED_COMBO_NAMES = new Set(["__proto__", "constructor", "prototype"]);

const VALID_NAME_REGEX = /^[a-zA-Z0-9_.-]+$/;

// GET /api/combos/[id] - Get combo by ID
export async function GET(_request, { params }) {
  try {
    const { id } = await params;
    const loaded = await loadScoped(
      "workspace.connections.metadata.read",
      id,
      getCombo,
      getComboById,
      "Combo not found",
    );
    if (loaded instanceof Response) return loaded;
    return NextResponse.json(loaded.row);
  } catch (error) {
    console.log("Error fetching combo:", error);
    return NextResponse.json({ error: "Failed to fetch combo" }, { status: 500 });
  }
}

// PUT /api/combos/[id] - Update combo
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const loaded = await loadScoped(
      "workspace.combos.manage",
      id,
      getCombo,
      getComboById,
      "Combo not found",
    );
    if (loaded instanceof Response) return loaded;
    const { scope, row: prev } = loaded;

    const body = await request.json();

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

      // Check if name already exists (inside the combo's workspace when scoped)
      const existing = scope
        ? await getComboByNameScoped(scope.ctx, prev.workspaceId, body.name)
        : await getComboByName(body.name);
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
      const others = (
        scope ? await listCombos(scope.ctx, prev.workspaceId) : await getCombos()
      ).filter((c) => c.id !== id);
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

    const combo = scope
      ? await updateComboScoped(scope.ctx, id, body)
      : await updateCombo(id, body);

    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    // Strategy migration now rides updateCombo's transaction; rotation
    // state still resets after successful write. Scoped combos key rotation
    // by workspace (YAN-364): same name in two workspaces rotates apart.
    const wsId = scope ? prev.workspaceId : null;
    if (prev?.name) resetComboRotation(comboRotationKey(wsId, prev.name));
    if (combo.name && combo.name !== prev?.name)
      resetComboRotation(comboRotationKey(wsId, combo.name));

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
    const loaded = await loadScoped(
      "workspace.combos.manage",
      id,
      getCombo,
      getComboById,
      "Combo not found",
    );
    if (loaded instanceof Response) return loaded;
    const { scope, row: prev } = loaded;

    const success = scope ? await deleteComboScoped(scope.ctx, id) : await deleteCombo(id);

    if (!success) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    // deleteCombo drops combo row + own strategy key in one transaction.
    if (prev?.name)
      resetComboRotation(comboRotationKey(scope ? prev.workspaceId : null, prev.name));

    import("@/shared/services/quotaSnapshotPoller")
      .then(({ syncQuotaSnapshotPoller }) => syncQuotaSnapshotPoller())
      .catch((error) => console.warn("[Combos] quota poller sync failed:", error?.message));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting combo:", error);
    return NextResponse.json({ error: "Failed to delete combo" }, { status: 500 });
  }
}
