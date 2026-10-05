import { NextResponse } from "next/server";
import { getCombos, createCombo, getComboByName } from "@/lib/localDb";
import {
  listCombos,
  createCombo as createComboScoped,
  getComboByNameScoped,
} from "@/lib/db/index.js";
import { workspaceScope } from "@/lib/users/workspaceScope.js";
import { findComboCycle, isModelList } from "open-sse/services/combo.js";
import { isValidComboKind } from "@/shared/constants/mediaProviderKinds";

export const dynamic = "force-dynamic";

// Validate combo name: only a-z, A-Z, 0-9, -, _
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.-]+$/;
const BLOCKED_COMBO_NAMES = new Set(["__proto__", "constructor", "prototype"]);

// GET /api/combos - Get all combos (workspace-scoped when the switch is on)
export async function GET(request) {
  try {
    const scope = await workspaceScope(request, "workspace.connections.metadata.read");
    if (scope instanceof Response) return scope;
    const combos = scope ? await listCombos(scope.ctx, scope.workspaceId) : await getCombos();
    return NextResponse.json({ combos });
  } catch (error) {
    console.log("Error fetching combos:", error);
    return NextResponse.json({ error: "Failed to fetch combos" }, { status: 500 });
  }
}

// POST /api/combos - Create new combo
export async function POST(request) {
  try {
    const scope = await workspaceScope(request, "workspace.combos.manage");
    if (scope instanceof Response) return scope;

    const body = await request.json();
    const { name, models, kind } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    // Validate name format
    if (typeof name !== "string" || !VALID_NAME_REGEX.test(name)) {
      return NextResponse.json(
        { error: "Name can only contain letters, numbers, -, _ and ." },
        { status: 400 },
      );
    }

    if (BLOCKED_COMBO_NAMES.has(name)) {
      return NextResponse.json({ error: `Invalid combo name "${name}"` }, { status: 400 });
    }

    // Check if name already exists (inside the selected workspace when scoped)
    const existing = scope
      ? await getComboByNameScoped(scope.ctx, scope.workspaceId, name)
      : await getComboByName(name);
    if (existing) {
      return NextResponse.json({ error: "Combo name already exists" }, { status: 400 });
    }

    if (models !== undefined && !isModelList(models)) {
      return NextResponse.json({ error: "Models must be an array of strings" }, { status: 400 });
    }

    if (!isValidComboKind(kind)) {
      return NextResponse.json({ error: `Invalid combo kind "${kind}"` }, { status: 400 });
    }

    const combos = scope ? await listCombos(scope.ctx, scope.workspaceId) : await getCombos();
    const cycle = findComboCycle(name, models || [], combos);
    if (cycle) {
      return NextResponse.json(
        { error: `Combo cycle detected: ${cycle.join(" → ")}` },
        { status: 400 },
      );
    }

    const combo = scope
      ? await createComboScoped(scope.ctx, scope.workspaceId, {
          name,
          models: models || [],
          kind: kind || null,
        })
      : await createCombo({ name, models: models || [], kind: kind || null });

    import("@/shared/services/quotaSnapshotPoller")
      .then(({ syncQuotaSnapshotPoller }) => syncQuotaSnapshotPoller())
      .catch((error) => console.warn("[Combos] quota poller sync failed:", error?.message));

    return NextResponse.json(combo, { status: 201 });
  } catch (error) {
    console.log("Error creating combo:", error);
    return NextResponse.json({ error: "Failed to create combo" }, { status: 500 });
  }
}
