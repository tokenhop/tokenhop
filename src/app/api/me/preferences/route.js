// Per-user UI preferences (YAN-362). Switch off: 404. Full browser session
// only: CLI tokens and gateway keys never touch personal preferences.
import { NextResponse } from "next/server";
import { requireMultiUser } from "@/lib/users/featureSwitch.js";
import { getPrincipal } from "@/lib/users/session.js";
import { USER_KEYS, classifyKey, pickKeys } from "@/lib/settings/settingsScope.js";
import { getUserPreferences, updateUserPreferences } from "@/lib/db/repos/workspaceSettingsRepo.js";
import { isPlainObject, validateSettingsBody } from "@/app/api/settings/validateSettings.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = { "Cache-Control": "no-store" };
const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export async function GET() {
  try {
    const hidden = await requireMultiUser();
    if (hidden) return hidden;
    const ctx = await getPrincipal();
    if (!ctx || ctx.via !== "session") return json({ error: "Unauthorized" }, 401);
    const row = await getUserPreferences(ctx);
    return json({ data: pickKeys(row.data, USER_KEYS), updatedAt: row.updatedAt });
  } catch (error) {
    return json({ error: error.message }, 500);
  }
}

export async function PATCH(request) {
  try {
    const hidden = await requireMultiUser();
    if (hidden) return hidden;
    const ctx = await getPrincipal();
    if (!ctx || ctx.via !== "session") return json({ error: "Unauthorized" }, 401);
    const body = await request.json().catch(() => null);
    if (!isPlainObject(body)) return json({ error: "Settings body must be an object" }, 400);
    for (const key of Object.keys(body)) {
      if (classifyKey(key) !== "user") return json({ error: `Unknown setting: ${key}` }, 400);
    }
    const invalid = validateSettingsBody(pickKeys(body, USER_KEYS));
    if (invalid) return json({ error: invalid }, 400);
    const data = await updateUserPreferences(ctx, body);
    const row = await getUserPreferences(ctx);
    return json({ data: pickKeys(data, USER_KEYS), updatedAt: row.updatedAt });
  } catch (error) {
    return json({ error: error.message }, 500);
  }
}
