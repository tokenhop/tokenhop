// Workspace settings overrides (YAN-362). Switch off: 404 (requireMultiUser).
// Non-member workspace id: 404 (`memberWorkspaceId` throws NOT_FOUND).
// Member without `workspace.preferences.manage`: 403.
import { NextResponse } from "next/server";
import { requireMultiUser } from "@/lib/users/featureSwitch.js";
import { getPrincipal } from "@/lib/users/session.js";
import { can } from "@/lib/users/principal.js";
import { WORKSPACE_KEYS, classifyKey, pickKeys } from "@/lib/settings/settingsScope.js";
import {
  getWorkspaceSettings,
  resolveWorkspaceComboId,
  updateWorkspaceComboStrategies,
  updateWorkspaceSettings,
} from "@/lib/db/repos/workspaceSettingsRepo.js";
import { isPlainObject, validateSettingsBody } from "@/app/api/settings/validateSettings.js";
import {
  applyComboStrategyPatch,
  isValidComboName,
} from "@/app/api/settings/comboStrategyPatch.js";
import { runSettingsSideEffects } from "@/app/api/settings/settingsSideEffects.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = { "Cache-Control": "no-store" };
const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

function toError(error) {
  if (error?.code === "NOT_FOUND" || error?.code === "MEMBER_ONLY") {
    return json({ error: "Workspace not found" }, 404);
  }
  throw error;
}

function splitKeyError(body) {
  for (const key of Object.keys(body)) {
    if (key === "comboStrategyPatch") return "";
    const scope = classifyKey(key);
    if (scope !== "workspace") return `Unknown setting: ${key}`;
  }
  return "";
}

// validateSettingsBody already runs the combo-strategy validator.
const validatePatch = (body) => validateSettingsBody(pickKeys(body, WORKSPACE_KEYS));

export async function GET(_request, { params }) {
  try {
    const hidden = await requireMultiUser();
    if (hidden) return hidden;
    const ctx = await getPrincipal();
    if (!ctx) return json({ error: "Unauthorized" }, 401);
    const { id } = await params;
    let row;
    try {
      row = await getWorkspaceSettings(ctx, id);
    } catch (error) {
      return toError(error);
    }
    if (!can(ctx, "workspace.connections.use", { workspaceId: row.workspaceId })) {
      return json({ error: "Workspace not found" }, 404);
    }
    return json({ data: pickKeys(row.data, WORKSPACE_KEYS), updatedAt: row.updatedAt });
  } catch (error) {
    return json({ error: error.message }, 500);
  }
}

export async function PATCH(request, { params }) {
  try {
    const hidden = await requireMultiUser();
    if (hidden) return hidden;
    const ctx = await getPrincipal();
    if (!ctx) return json({ error: "Unauthorized" }, 401);
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!isPlainObject(body)) return json({ error: "Settings body must be an object" }, 400);
    if (Object.hasOwn(body, "comboStrategyPatch") && Object.keys(body).length !== 1) {
      return json({ error: "comboStrategyPatch must be the only setting" }, 400);
    }

    let wsId;
    try {
      wsId = (await getWorkspaceSettings(ctx, id)).workspaceId;
    } catch (error) {
      return toError(error);
    }
    if (!can(ctx, "workspace.preferences.manage", { workspaceId: wsId })) {
      return json({ error: "Forbidden" }, 403);
    }

    if (Object.hasOwn(body, "comboStrategyPatch")) {
      // YAN-364: workspace strategies are keyed by combo id. A name selector
      // is resolved inside THIS workspace only (never across workspaces); a
      // well-formed name that matches no combo here is the same 409 as a
      // stale id. Malformed selectors fall through to the validator's 400.
      let patchBody = body;
      const sel = body.comboStrategyPatch;
      if (sel && typeof sel === "object" && sel.id === undefined && isValidComboName(sel.name)) {
        const comboId = await resolveWorkspaceComboId(ctx, wsId, { name: sel.name });
        if (!comboId) return json({ error: "Combo not found" }, 409);
        const { name: _name, ...rest } = sel;
        patchBody = { ...body, comboStrategyPatch: { ...rest, id: comboId } };
      }
      const result = await applyComboStrategyPatch(
        patchBody,
        (transform, comboId) => updateWorkspaceComboStrategies(ctx, wsId, transform, comboId),
        { allowId: true },
      );
      if (result.response) return result.response;
      runSettingsSideEffects({ comboStrategyPatch: true }, result);
      const row = await getWorkspaceSettings(ctx, wsId);
      return json({ data: pickKeys(row.data, WORKSPACE_KEYS), updatedAt: row.updatedAt });
    }

    const movedError = splitKeyError(body);
    if (movedError) return json({ error: movedError }, 400);
    const invalid = validatePatch(body);
    if (invalid) return json({ error: invalid }, 400);

    const data = await updateWorkspaceSettings(ctx, wsId, body);
    runSettingsSideEffects(body, data);
    const row = await getWorkspaceSettings(ctx, wsId);
    return json({ data: pickKeys(row.data, WORKSPACE_KEYS), updatedAt: row.updatedAt });
  } catch (error) {
    return json({ error: error.message }, 500);
  }
}
