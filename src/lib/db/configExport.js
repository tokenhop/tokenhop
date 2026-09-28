import { getAdapter } from "./driver.js";
import { parseJson, stringifyJson } from "./helpers/jsonCol.js";
import { getSettings, DEFAULT_SETTINGS } from "./repos/settingsRepo.js";
import { getCombos } from "./repos/combosRepo.js";
import { getUserPricing, invalidatePricingCache } from "./repos/pricingRepo.js";
import {
  buildConfigDocument,
  deriveKnownSettingKeys,
  diffConfig,
} from "@/lib/settingsConfigDoc.js";
import { SETTINGS_SECTIONS } from "@/app/(dashboard)/dashboard/settings/registry.js";
import { getAppVersion } from "./version.js";
import { v4 as uuidv4 } from "uuid";

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

/** Portable config document. Credential-bearing tables never touched. */
export async function exportConfig() {
  return buildConfigDocument({
    settings: await getSettings(),
    combos: await getCombos(),
    pricingOverrides: await getUserPricing(),
    version: getAppVersion(),
  });
}

/** Current config for diff, including defaults. */
export async function getConfigState() {
  return {
    settings: await getSettings(),
    combos: await getCombos(),
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
    const currentCombos = db.all(`SELECT * FROM combos`).map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      models: parseJson(r.models, []),
    }));
    const pricingRows = db.all(`SELECT key, value FROM kv WHERE scope = 'pricing'`);
    const pricingOverrides = {};
    for (const r of pricingRows) pricingOverrides[r.key] = parseJson(r.value, {});

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
          `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
          [uuidv4(), combo.name, combo.kind, stringifyJson(combo.models), now, now],
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
