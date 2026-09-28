/**
 * YAN-313 configuration export/import: pure document logic.
 *
 * Document: { schemaVersion, exportedAt, app: { version }, settings,
 *   redactedSettings, combos, pricingOverrides }.
 *
 * The settings subset is derived, not listed: export takes every stored
 * setting minus the denylists below, and import accepts every key the
 * settings schema knows (DEFAULT_SETTINGS keys plus keys already stored).
 * New settings keys ship through export/import with no change here.
 *
 * Embedded credentials: every string in exported settings (nested too) goes
 * through maskUrlCredentials, so URL userinfo becomes `***@` and secret query
 * params become `=***`. Keys that changed are listed in `redactedSettings`.
 * The `***` marker is a tombstone: import skips any setting that still
 * contains one and keeps the stored value, so a round trip never overwrites
 * stored credentials with the placeholder.
 */

import { maskUrlCredentials } from "./settingsFlags.js";

export const CONFIG_SCHEMA_VERSION = 1;

/** Max raw import body, in bytes. */
export const MAX_CONFIG_BYTES = 1024 * 1024;

// Exactly the two shapes maskUrlCredentials emits: "***@" and "=***".
const TOMBSTONE = /\*\*\*@|=\*\*\*(?:[&#]|$)/;

/** Deep-apply maskUrlCredentials to every string in a settings value. */
function scrubValue(value) {
  if (typeof value === "string") return maskUrlCredentials(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubValue(v)]));
  }
  return value;
}

/**
 * True when a settings value (at any depth) still carries a scrub tombstone.
 * @param {unknown} value Import candidate.
 * @returns {boolean}
 */
export function hasScrubTombstone(value) {
  if (typeof value === "string") return TOMBSTONE.test(value);
  if (Array.isArray(value)) return value.some(hasScrubTombstone);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(hasScrubTombstone);
  }
  return false;
}

/**
 * Credentials: never exported, and an import file containing one is rejected.
 * Covers the password hash, raw password fields, OIDC client secret, SAML
 * private material, API keys/tokens and machine ids.
 */
export const SECRET_SETTING_KEYS = new Set([
  "password",
  "currentPassword",
  "newPassword",
  "oidcClientSecret",
  "samlPrivateKey",
  "samlDecryptionKey",
  "samlSigningKey",
  "mitmSudoEncrypted",
  "apiKey",
  "apiKeys",
  "cliToken",
  "machineId",
  "jwtSecret",
]);

/** Machine-local state: not portable, skipped on export, ignored on import. */
export const MACHINE_LOCAL_SETTING_KEYS = new Set([
  "tunnelUrl",
  "tailscaleUrl",
  "mitmEnabled",
  "mitmCertInstalled",
  "dnsToolEnabled",
]);

/** Env-pinned / read-only values: never exported, rejected on import. */
export const READ_ONLY_SETTING_KEYS = new Set([
  "tunnelProvider",
  "SEARXNG_URL",
  "CLAUDE_CLI_VERSION",
  "CODEX_CLI_VERSION",
  "ZED_CLIENT_VERSION",
]);

/** Keys that don't take effect until a restart or a manual re-enable. */
export const RESTART_SETTING_KEYS = new Set([
  "tunnelEnabled",
  "tailscaleEnabled",
  "headroomCodeAware",
  "headroomKompress",
]);

// Settings registry rows that are UI actions or derived views, not stored keys.
// Secrets must also be listed here (the registry has a password-change row);
// SECRET/MACHINE_LOCAL/READ_ONLY denylists apply first in build/validate.
const NON_SETTING_ROW_KEYS = new Set([
  "theme",
  "language",
  "password",
  "ssoRedirect",
  "ssoTest",
  "pricingOverview",
  "pricingEdit",
  "pricingReset",
  "databasePath",
  "backup",
  "logout",
  "shutdown",
]);

/**
 * Settings keys the import accepts: schema defaults, keys already stored, and
 * every stored-setting row of the Settings registry. UI action/pseudo rows
 * and UPPER_CASE env pins are excluded; env-tagged rows (e.g. overridable
 * runtime flags) stay importable via DEFAULT_SETTINGS — the env var still
 * wins at read time. Keys added to the registry or DEFAULT_SETTINGS later
 * flow through with no change here.
 * @param {{ defaults: object, stored: object, sections: Array<{rows: Array<{key: string, tags?: string[]}>}> }} sources
 * @returns {Set<string>}
 */
export function deriveKnownSettingKeys({ defaults, stored, sections }) {
  const keys = new Set([...Object.keys(defaults ?? {}), ...Object.keys(stored ?? {})]);
  for (const section of sections ?? []) {
    for (const row of section.rows ?? []) {
      if (NON_SETTING_ROW_KEYS.has(row.key)) continue;
      if (SECRET_SETTING_KEYS.has(row.key)) continue;
      if (MACHINE_LOCAL_SETTING_KEYS.has(row.key)) continue;
      if (READ_ONLY_SETTING_KEYS.has(row.key)) continue;
      // UPPER_CASE rows are env pins. Env-tagged rows (overridable runtime
      // flags) stay importable via DEFAULT_SETTINGS — the env var still wins
      // at read time.
      if (/^[A-Z0-9_]+$/.test(row.key)) continue;
      keys.add(row.key);
    }
  }
  return keys;
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const VALID_COMBO_NAME = /^[a-zA-Z0-9_.-]+$/;
const MAX_COMBOS = 1000;
const MAX_SETTINGS_KEYS = 500;
const MAX_PRICING_PROVIDERS = 500;
const PRICING_FIELDS = new Set(["input", "output", "cached", "reasoning", "cache_creation"]);

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

// Key-order-insensitive deep equality for diffing stored settings against
// imported ones (JSON key order is not significant).
function sameJson(a, b) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sort(v[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(a)) === JSON.stringify(sort(b));
}

function isExportableKey(key) {
  return (
    !SECRET_SETTING_KEYS.has(key) &&
    !MACHINE_LOCAL_SETTING_KEYS.has(key) &&
    !READ_ONLY_SETTING_KEYS.has(key) &&
    !UNSAFE_KEYS.has(key)
  );
}

/** Portable combo shape: machine ids and timestamps are dropped. */
function portableCombo(combo) {
  return { name: combo.name, kind: combo.kind ?? null, models: combo.models ?? [] };
}

/**
 * Build the export document. Secrets, machine-local and read-only keys are
 * stripped; every exported string is scrubbed of embedded URL credentials.
 * @param {{ settings: object, combos: Array, pricingOverrides: object, version: string }} state
 * @returns {object} Versioned config document.
 */
export function buildConfigDocument({ settings, combos, pricingOverrides, version }) {
  const portable = {};
  const redactedSettings = [];
  for (const [key, value] of Object.entries(settings ?? {})) {
    if (!isExportableKey(key) || value === undefined) continue;
    const scrubbed = scrubValue(value);
    portable[key] = scrubbed;
    if (!sameJson(value, scrubbed)) redactedSettings.push(key);
  }
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    app: { version: version || "unknown" },
    settings: portable,
    redactedSettings: redactedSettings.sort(),
    combos: (combos ?? []).map(portableCombo),
    pricingOverrides: isPlainObject(pricingOverrides) ? pricingOverrides : {},
  };
}

function comboError(combo, index) {
  const where = `combos[${index}]`;
  if (!isPlainObject(combo)) return `${where} must be an object`;
  // Same rules as POST /api/combos.
  if (
    typeof combo.name !== "string" ||
    !VALID_COMBO_NAME.test(combo.name) ||
    UNSAFE_KEYS.has(combo.name)
  ) {
    return `${where}.name is invalid`;
  }
  if (combo.kind !== undefined && combo.kind !== null && typeof combo.kind !== "string") {
    return `${where}.kind must be a string or null`;
  }
  if (
    combo.models !== undefined &&
    !(Array.isArray(combo.models) && combo.models.every((m) => typeof m === "string"))
  ) {
    return `${where}.models must be an array of strings`;
  }
  return null;
}

function pricingError(pricing) {
  const providers = Object.entries(pricing);
  if (providers.length > MAX_PRICING_PROVIDERS) return "Too many pricingOverrides providers";
  for (const [provider, models] of providers) {
    if (UNSAFE_KEYS.has(provider) || !provider.trim()) {
      return `Invalid pricing provider "${provider}"`;
    }
    if (!isPlainObject(models)) return `Invalid pricing for provider "${provider}"`;
    for (const [model, entry] of Object.entries(models)) {
      if (UNSAFE_KEYS.has(model) || !model.trim()) {
        return `Invalid pricing model "${provider}/${model}"`;
      }
      if (!isPlainObject(entry)) return `Invalid pricing for "${provider}/${model}"`;
      for (const [field, value] of Object.entries(entry)) {
        if (!PRICING_FIELDS.has(field)) {
          return `Invalid pricing field "${field}" for "${provider}/${model}"`;
        }
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          return `Invalid pricing value for "${field}" in "${provider}/${model}"`;
        }
      }
    }
  }
  return null;
}

/**
 * Structural validation of an import document. Unknown and machine-local
 * settings are reported as warnings and dropped; secrets, read-only keys and
 * bad types are errors. Value ranges are checked by the settings PATCH
 * validators in the route.
 * @param {unknown} doc Parsed JSON document.
 * @param {Set<string>} knownKeys Settings keys the schema knows.
 * @returns {{ valid: boolean, errors: string[], warnings: string[], doc: object|null }}
 */
export function validateConfigDocument(doc, knownKeys) {
  const errors = [];
  const warnings = [];
  const fail = () => ({ valid: false, errors, warnings, doc: null });

  if (!isPlainObject(doc)) {
    errors.push("Config must be a JSON object");
    return fail();
  }
  if (doc.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    errors.push(
      `Unsupported schemaVersion ${JSON.stringify(doc.schemaVersion ?? null)}: this version of 9router reads ${CONFIG_SCHEMA_VERSION}`,
    );
    return fail();
  }
  if (!isPlainObject(doc.settings)) errors.push("settings must be an object");
  if (doc.combos !== undefined && !Array.isArray(doc.combos))
    errors.push("combos must be an array");
  if (doc.pricingOverrides !== undefined && !isPlainObject(doc.pricingOverrides)) {
    errors.push("pricingOverrides must be an object");
  }
  if (errors.length > 0) return fail();

  const settingKeys = Object.keys(doc.settings);
  if (settingKeys.length > MAX_SETTINGS_KEYS) errors.push("Too many settings");
  // Tombstoned settings keep their stored value on import (round trip must
  // not overwrite real credentials with "***"): drop with a warning.
  const settings = {};
  for (const key of settingKeys) {
    if (UNSAFE_KEYS.has(key)) errors.push(`Invalid setting "${key}"`);
    else if (SECRET_SETTING_KEYS.has(key)) errors.push(`Secret "${key}" can't be imported`);
    else if (READ_ONLY_SETTING_KEYS.has(key)) errors.push(`Setting "${key}" is read-only`);
    else if (MACHINE_LOCAL_SETTING_KEYS.has(key)) {
      warnings.push(`Machine-specific setting "${key}" ignored`);
    } else if (!knownKeys.has(key)) warnings.push(`Unknown setting "${key}" ignored`);
    else if (hasScrubTombstone(doc.settings[key])) {
      warnings.push(`Setting "${key}" kept: re-enter its credentials to change it`);
    } else settings[key] = doc.settings[key];
  }

  const combos = doc.combos ?? [];
  if (combos.length > MAX_COMBOS) errors.push("Too many combos");
  const names = new Set();
  combos.forEach((combo, i) => {
    const error = comboError(combo, i);
    if (error) errors.push(error);
    else if (names.has(combo.name)) errors.push(`Duplicate combo "${combo.name}"`);
    else names.add(combo.name);
  });

  const pricingOverrides = doc.pricingOverrides ?? {};
  const pricingProblem = pricingError(pricingOverrides);
  if (pricingProblem) errors.push(pricingProblem);

  if (errors.length > 0) return fail();
  const redactedSettings = Array.isArray(doc.redactedSettings)
    ? doc.redactedSettings.filter((k) => typeof k === "string")
    : [];
  return {
    valid: true,
    errors,
    warnings,
    redactedSettings,
    doc: { settings, combos: combos.map(portableCombo), pricingOverrides },
  };
}

function statusOf(exists, same) {
  if (!exists) return "added";
  return same ? "unchanged" : "changed";
}

function summarize(entries) {
  const count = (status) => entries.filter((e) => e.status === status).length;
  return {
    changed: count("changed"),
    added: count("added"),
    unchanged: count("unchanged"),
    entries,
  };
}

/**
 * Preview diff of a validated import against current state. Import only adds
 * and updates; nothing is ever removed, so there is no "removed" group.
 * Masked `***` tombstones are normalized through scrubValue on both sides,
 * so an exported doc diffs to zero changes against the stored credentials it
 * came from.
 * @param {{ settings: object, combos: Array, pricingOverrides: object }} next Validated doc or raw export.
 * @param {{ settings: object, combos: Array, pricingOverrides: object }} current Live state.
 * @returns {{ settings: object, combos: object, pricing: object, restartRequired: boolean }}
 */
export function diffConfig(next, current) {
  const settings = Object.entries(next.settings).map(([key, value]) => {
    const exists = Object.hasOwn(current.settings, key);
    const same = exists && sameJson(scrubValue(current.settings[key]), scrubValue(value));
    const status = statusOf(exists, same);
    return {
      key,
      status,
      from: exists ? current.settings[key] : null,
      to: value,
      restart: status !== "unchanged" && RESTART_SETTING_KEYS.has(key),
    };
  });

  const byName = new Map(current.combos.map((c) => [c.name, portableCombo(c)]));
  const combos = next.combos.map((combo) => {
    const existing = byName.get(combo.name);
    return {
      key: combo.name,
      status: statusOf(Boolean(existing), existing && sameJson(existing, combo)),
      from: existing ?? null,
      to: combo,
    };
  });

  const pricing = [];
  for (const [provider, models] of Object.entries(next.pricingOverrides)) {
    for (const [model, entry] of Object.entries(models)) {
      const prev = current.pricingOverrides[provider]?.[model];
      pricing.push({
        key: `${provider}/${model}`,
        status: statusOf(prev !== undefined, prev !== undefined && sameJson(prev, entry)),
        from: prev ?? null,
        to: entry,
      });
    }
  }

  return {
    settings: summarize(settings),
    combos: summarize(combos),
    pricing: summarize(pricing),
    restartRequired: settings.some((e) => e.restart),
  };
}
