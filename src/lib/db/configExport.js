import { getAdapter } from "./driver.js";
import { parseJson, stringifyJson } from "./helpers/jsonCol.js";
import { getSettings, DEFAULT_SETTINGS, SSO_POLICY_KEYS } from "./repos/settingsRepo.js";
import { isMultiUserEnabled } from "@/lib/users/featureSwitch.js";
import { mirrorToDefaultWorkspace } from "./repos/workspaceSettingsRepo.js";
import { defaultWorkspaceIdUnscoped } from "./repos/ownership.js";
import { WORKSPACE_KEYS, pickKeys } from "@/lib/settings/settingsScope.js";
import { getPortableCombosUnscoped } from "./repos/combosRepo.js";
import { getUserPricing, invalidatePricingCache } from "./repos/pricingRepo.js";
import {
  buildConfigDocument,
  deriveKnownSettingKeys,
  diffConfig,
} from "@/lib/settingsConfigDoc.js";
import { SETTINGS_SECTIONS } from "@/app/(dashboard)/dashboard/settings/registry.js";
import { getAppVersion } from "./version.js";
import { v4 as uuidv4 } from "uuid";

// YAN-362: the config document stays flat. Reads carry the Default workspace's
// overrides on top of the instance blob; writes store the blob as before and
// mirror the workspace keys into the Default row.
function defaultWorkspaceOverlay(db) {
  const ws = defaultWorkspaceIdUnscoped(db);
  if (!ws) return {};
  const row = db.get(`SELECT data FROM workspaceSettings WHERE workspaceId = ?`, [ws]);
  return pickKeys(parseJson(row?.data, {}), WORKSPACE_KEYS);
}

/** Settings keys known to this install: schema, stored extras, registry rows. */
export async function getKnownConfigSettingKeys() {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  const stored = row ? parseJson(row.data, {}) : {};
  return deriveKnownSettingKeys({
    defaults: DEFAULT_SETTINGS,
    stored,
    sections: SETTINGS_SECTIONS,
  });
}

// YAN-359: the six SSO policy keys ride the config document only while the
// users & teams rollout is on; export/diff state omits them while off.
async function visibleConfigSettings(settings) {
  if (await isMultiUserEnabled()) return settings;
  const out = { ...settings };
  for (const key of SSO_POLICY_KEYS) delete out[key];
  return out;
}

/** Portable config document. Credential-bearing tables never touched. */
export async function exportConfig() {
  const db = await getAdapter();
  // YAN-364: the flat doc has no workspace identity — Default + NULL rows
  // only, never other workspaces' same-name combos.
  return buildConfigDocument({
    settings: await visibleConfigSettings({
      ...(await getSettings()),
      ...defaultWorkspaceOverlay(db),
    }),
    combos: await getPortableCombosUnscoped(),
    pricingOverrides: await getUserPricing(),
    version: getAppVersion(),
  });
}

/** Current config for diff, including defaults. */
export async function getConfigState() {
  const db = await getAdapter();
  return {
    settings: await visibleConfigSettings({
      ...(await getSettings()),
      ...defaultWorkspaceOverlay(db),
    }),
    combos: await getPortableCombosUnscoped(),
    pricingOverrides: await getUserPricing(),
  };
}

/**
 * Import a validated document atomically. Existing settings and combos not
 * present in the file stay untouched; pricing entries are merged. Any write
 * failure rolls back the settings, combo and pricing changes together.
 * @param {{settings: object, combos: Array, pricingOverrides: object}} doc
 * @returns {{ diff: object, restartRequired: boolean }}
 */
export async function applyConfig(doc) {
  const db = await getAdapter();
  let result;
  db.transaction(() => {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const stored = row ? parseJson(row.data, {}) : {};
    // YAN-364: the flat doc has no workspace identity — match and create
    // against Default + ownerless rows only (same scope as exportConfig), so an
    // import never rewrites another workspace's same-name combo. Default rows
    // sort first, so they win a name match over a stale ownerless duplicate.
    const defaultWs = defaultWorkspaceIdUnscoped(db);
    const currentCombos = db
      .all(
        `SELECT * FROM combos WHERE workspaceId IS NULL OR workspaceId = ? ORDER BY workspaceId IS NULL`,
        [defaultWs],
      )
      .map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        models: parseJson(r.models, []),
      }));
    const pricingRows = db.all(`SELECT key, value FROM kv WHERE scope = 'pricing'`);
    const pricingOverrides = {};
    for (const r of pricingRows) pricingOverrides[r.key] = parseJson(r.value, {});

    // YAN-359: recheck mapped targets inside the transaction — a workspace
    // deleted after route validation must fail the apply, not slip through.
    const map = doc.settings?.ssoGroupWorkspaceMap;
    if (Array.isArray(map) && map.length > 0) {
      if (map.some((entry) => typeof entry?.workspaceId !== "string" || !entry.workspaceId)) {
        throw new Error("Invalid ssoGroupWorkspaceMap: unknown or personal workspace");
      }
      const ids = [...new Set(map.map((entry) => entry.workspaceId))];
      const rows = db.all(
        `SELECT id FROM workspaces WHERE kind = 'shared' AND id IN (${ids.map(() => "?").join(",")})`,
        ids,
      );
      const found = new Set(rows.map((r) => r.id));
      if (ids.some((id) => !found.has(id))) {
        throw new Error("Invalid ssoGroupWorkspaceMap: unknown or personal workspace");
      }
    }

    const before = {
      settings: { ...DEFAULT_SETTINGS, ...stored },
      combos: currentCombos,
      pricingOverrides,
    };
    const diff = diffConfig(doc, before);

    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson({ ...stored, ...doc.settings })],
    );
    // YAN-362: the doc is flat; mirror its workspace keys into Default's row.
    mirrorToDefaultWorkspace(db, doc.settings);

    for (const combo of doc.combos) {
      const match = currentCombos.find((c) => c.name === combo.name);
      if (match) {
        db.run(`UPDATE combos SET kind = ?, models = ?, updatedAt = ? WHERE id = ?`, [
          combo.kind,
          stringifyJson(combo.models),
          new Date().toISOString(),
          match.id,
        ]);
      } else {
        const now = new Date().toISOString();
        db.run(
          `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt, workspaceId) VALUES(?, ?, ?, ?, ?, ?, ?)`,
          [uuidv4(), combo.name, combo.kind, stringifyJson(combo.models), now, now, defaultWs],
        );
      }
    }

    for (const [provider, models] of Object.entries(doc.pricingOverrides)) {
      const merged = { ...(pricingOverrides[provider] || {}), ...models };
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(merged)],
      );
    }

    result = { diff, restartRequired: diff.restartRequired };
  });
  invalidatePricingCache();
  return result;
}
