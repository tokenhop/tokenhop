import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import {
  WORKSPACE_KEYS,
  USER_KEYS,
  pickKeys,
  mergeWorkspaceLayer,
} from "@/lib/settings/settingsScope.js";
import { mirrorToDefaultWorkspace } from "./workspaceSettingsRepo.js";
import { ACTIVE } from "@/shared/brand";
import { readCredentialEncryptionState } from "../credentialEncryptionState.js";
import { CREDENTIAL_FIELD_ALLOWLIST, buildAad, encryptBytes } from "../../security/envelope.js";
import {
  decodeCredentialRowSync,
  ensureWorkspaceDekSync,
  prepareCredentialContext,
} from "../helpers/credentialStorage.js";
import { loadMasterKey } from "../../security/masterKey.js";

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";
const DEFAULT_HEADROOM_URL = process.env.HEADROOM_URL || "http://localhost:8787";

export const DEFAULT_SETTINGS = {
  cloudEnabled: false,
  tunnelEnabled: false,
  tunnelUrl: "",
  tunnelProvider: "cloudflare",
  tailscaleEnabled: false,
  tailscaleUrl: "",
  stickyRoundRobinLimit: 3,
  providerStrategies: {},
  quotaVisibility: {},
  comboStrategy: "fallback",
  comboStickyRoundRobinLimit: 1,
  comboStrategies: {},
  capacityAdapter: {
    vision: { enabled: true, roundRobin: false, models: [] },
    pdf: { enabled: false, roundRobin: false, models: [] },
    audioInput: { enabled: true, roundRobin: false, models: [] },
    videoInput: { enabled: false, roundRobin: false, models: [] },
  },
  requireLogin: true,
  requireApiKey: true,
  // Users & teams switch (YAN-351). Read only via isMultiUserEnabled(); not API-writable.
  multiUserEnabled: false,
  // YAN-367: audit events older than this are pruned daily (initializeApp).
  auditRetentionDays: 365,
  // YAN-369 (ADR-0006): instance-only ToS override for granting personal
  // connections. Follows the SSO_POLICY_KEYS rollout-gating pattern (see
  // GRANT_POLICY_KEYS); shape validated in app/api/settings/validateSettings.js.
  allowPersonalConnectionGrants: false,
  tunnelDashboardAccess: true,
  requestLogsEnabled: false,
  translatorEnabled: false,
  startPage: "/dashboard",
  uiDensity: "comfortable",
  authMode: "password",
  ssoType: "oidc",
  oidcIssuerUrl: "",
  oidcClientId: "",
  oidcClientSecret: "",
  oidcScopes: "openid profile email",
  oidcLoginLabel: "Sign in with OIDC",
  samlEntryPoint: "",
  samlIssuer: ACTIVE.samlIssuerDefault,
  samlCert: "",
  samlLoginLabel: "Sign in with SAML SSO",
  samlAttributeEmail: "email",
  samlAttributeName: "name",
  enableObservability: false,
  observabilityMaxRecords: 1000,
  observabilityBatchSize: 20,
  observabilityFlushIntervalMs: 5000,
  observabilityMaxJsonSize: 5,
  outboundProxyEnabled: false,
  outboundProxyUrl: "",
  outboundNoProxy: "",
  mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
  dnsToolEnabled: {},
  rtkEnabled: true,
  headroomEnabled: false,
  headroomUrl: DEFAULT_HEADROOM_URL,
  headroomCompressUserMessages: false,
  headroomTimeoutMs: 3000,
  cavemanEnabled: false,
  cavemanLevel: "full",
  ponytailEnabled: false,
  ponytailLevel: "full",
  pxpipeEnabled: false,
  pxpipeAutoInstall: true,
  pxpipeMinChars: 25000,
  pxpipeTimeoutMs: 15000,
  // YAN-311 reliability policy. Defaults mirror open-sse/config/reliabilityPolicy.js
  // RELIABILITY_DEFAULTS (today's hardcoded constants); the resolver merges
  // stored values over defaults, so absent keys behave identically to today.
  retryPolicy: {
    502: { tries: 3, delayMs: 3000 },
    503: { tries: 3, delayMs: 2000 },
    504: { tries: 2, delayMs: 3000 },
  },
  cooldowns: {
    rateLimitCapMs: 1800000,
    longMs: 120000,
    shortMs: 5000,
    transientMs: 30000,
  },
  backoff: { startMs: 2000, maxMs: 300000, levels: 15 },
  streamTimeouts: { firstChunkMs: 200000, stallMs: 360000, connectMs: 60000 },
  // YAN-359 SSO group policy: six flat instance keys, rollout-gated. The
  // settings route hides and 404-rejects them while the users & teams rollout
  // is off; shapes are validated in app/api/settings/validateSettings.js.
  ssoGroupsClaim: "groups",
  samlAttributeGroups: "groups",
  ssoAllowedGroups: [],
  ssoAdminGroups: [],
  ssoGroupWorkspaceMap: [],
  ssoDefaultRole: "pending",
};

/** The six rollout-gated SSO group-policy keys (YAN-359). */
export const SSO_POLICY_KEYS = Object.freeze([
  "ssoGroupsClaim",
  "samlAttributeGroups",
  "ssoAllowedGroups",
  "ssoAdminGroups",
  "ssoGroupWorkspaceMap",
  "ssoDefaultRole",
]);

/** The rollout-gated instance keys hiding with the multi-user switch (YAN-369). */
export const GRANT_POLICY_KEYS = Object.freeze(["allowPersonalConnectionGrants"]);

// Raw read: stored JSON exactly as persisted. NEVER decrypts: envelope values
// pass through byte-exact (export, raw writers, featureSwitch all rely on it).
async function readRaw() {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  return row ? parseJson(row.data, {}) : {};
}

/**
 * Narrow raw multi-user boolean for featureSwitch. Goes straight to the
 * stored row (never through decrypting getSettings), so the switch can be
 * resolved at startup with no root and no cycle.
 * @returns {Promise<boolean>}
 */
export async function getMultiUserEnabledSettingRaw() {
  return (await readRaw()).multiUserEnabled === true;
}

/**
 * Explicit established-encryption mode for the MITM optional third hook.
 * Reads the strict marker (partial/corrupt state throws, never "legacy").
 * @returns {Promise<boolean>}
 */
export async function isCredentialEncryptionEstablished() {
  return readCredentialEncryptionState(await getAdapter()).storage === "encrypted";
}

const SECRET_KEYS = CREDENTIAL_FIELD_ALLOWLIST.settings;
const SETTINGS_ROW_ID = "1";

// Default workspace coordinates come from stored metadata, never the client.
function defaultWorkspaceIdRaw(db) {
  return db.get(`SELECT value FROM _meta WHERE key = 'defaultWorkspaceId'`)?.value ?? null;
}

// Trusted runtime: five Default-coordinate secrets decrypted. Established
// storage needs the root (async load happens here, before any sync work).
async function decryptSecrets(db, raw) {
  const state = readCredentialEncryptionState(db);
  if (state.storage !== "encrypted") return raw;
  const root = await loadMasterKey({ expectedKid: state.kekKid });
  const ctx = prepareCredentialContext(db, root);
  const workspaceId = defaultWorkspaceIdRaw(db);
  return decodeCredentialRowSync(db, { id: SETTINGS_ROW_ID, data: JSON.stringify(raw) }, ctx, {
    table: "settings",
    workspaceId,
  });
}

// Metadata mode: never decrypts. Secret leaves are removed from the view and
// replaced by one safe `secretsConfigured` boolean map (stored value present,
// any shape). Consumers needing only presence (bootstrap, lockout, status)
// read it; the settings route strips it and keeps only `oidcConfigured`.
function metadataView(raw) {
  const out = { ...raw };
  const configured = {};
  for (const key of SECRET_KEYS) {
    configured[key] = out[key] !== undefined && out[key] !== null && out[key] !== "";
    delete out[key];
  }
  out.secretsConfigured = configured;
  return out;
}

// Encrypt secret updates on established storage so plaintext never lands.
// Secret updates arrive plaintext (or null/"" to clear); an envelope-shaped
// caller value is refused (same rule as the row codec).
function encodeSecretUpdates(db, updates, root) {
  const state = readCredentialEncryptionState(db);
  const touched = Object.keys(updates).filter((k) => SECRET_KEYS.includes(k));
  for (const k of touched) {
    const value = updates[k];
    // Covered secrets accept only plaintext strings (or null/"" to clear):
    // envelope objects and lookalikes are rejected, never stored.
    if (typeof value !== "string" && value !== null) {
      throw Object.assign(new Error("[settings] caller-supplied envelope rejected"), {
        code: "ENVELOPE_REJECTED",
      });
    }
  }
  if (state.storage !== "encrypted" || touched.length === 0) return updates;
  const ctx = prepareCredentialContext(db, root);
  const workspaceId = defaultWorkspaceIdRaw(db);
  const next = { ...updates };
  let dek = null;
  for (const key of touched) {
    const value = next[key];
    if (typeof value !== "string" || value.length === 0) continue; // clear semantics kept
    if (!workspaceId) {
      throw Object.assign(new Error("[settings] Default workspace required for secrets"), {
        code: "DATA_CORRUPT",
      });
    }
    dek ??= ensureWorkspaceDekSync(db, workspaceId, ctx);
    next[key] = encryptBytes(
      dek.dek,
      dek.kid,
      Buffer.from(value, "utf8"),
      buildAad({ table: "settings", rowId: SETTINGS_ROW_ID, workspaceId, field: key }),
    );
  }
  return next;
}

// Merge raw settings with defaults; backward-compat for missing keys.
// Reliability keys merge allowlisted leaves only: raw DB JSON bypasses PATCH
// validation, so crafted stored JSON can't pollute prototypes or persist junk.
const RELIABILITY_LEAF_KEYS = {
  retryPolicy: ["502", "503", "504"],
  cooldowns: ["rateLimitCapMs", "longMs", "shortMs", "transientMs"],
  backoff: ["startMs", "maxMs", "levels"],
  streamTimeouts: ["firstChunkMs", "stallMs", "connectMs"],
};
export function mergeWithDefaults(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  for (const [key, leaves] of Object.entries(RELIABILITY_LEAF_KEYS)) {
    const stored = raw?.[key];
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      const next = { ...DEFAULT_SETTINGS[key] };
      for (const leaf of leaves) {
        if (!Object.hasOwn(stored, leaf)) continue;
        const value = stored[leaf];
        next[leaf] =
          value && typeof value === "object" && !Array.isArray(value)
            ? { ...(next[leaf] || {}), ...value }
            : value;
      }
      merged[key] = next;
    }
  }
  for (const [key, defVal] of Object.entries(DEFAULT_SETTINGS)) {
    if (merged[key] === undefined) {
      if (
        key === "outboundProxyEnabled" &&
        typeof merged.outboundProxyUrl === "string" &&
        merged.outboundProxyUrl.trim()
      ) {
        merged[key] = true;
      } else {
        merged[key] = defVal;
      }
    }
  }
  return merged;
}

/**
 * Current effective settings.
 * @param {{secretMode?: "runtime"|"metadata"}} [opts] `metadata` exposes
 * non-secrets + safe presence booleans without the root (no decryption, no
 * secret exposure). Default `runtime` decrypts the five Default secrets on
 * established storage (needs the KEK; propagates integrity failures).
 */
export async function getSettings({ secretMode = "runtime" } = {}) {
  const raw = await readRaw();
  // Redact after the merge: defaults would otherwise re-add secret keys as "".
  if (secretMode === "metadata") return metadataView(mergeWithDefaults(raw));
  return mergeWithDefaults(await decryptSecrets(await getAdapter(), raw));
}

// Atomic read-merge-write inside transaction (prevents losing concurrent updates)
export async function updateSettings(updates) {
  const db = await getAdapter();
  const state = readCredentialEncryptionState(db);
  const root =
    state.storage === "encrypted" ? await loadMasterKey({ expectedKid: state.kekKid }) : null;
  let next;
  db.transaction(() => {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    // Raw merge: envelope values for untouched keys pass through byte-exact
    // (never decrypted here); touched secrets are encrypted above in encode.
    const current = row ? parseJson(row.data, {}) : {};
    const encoded =
      state.storage === "encrypted" ? encodeSecretUpdates(db, updates, root) : updates;
    next = { ...current, ...encoded };
    // Pin the issuer the first time SAML settings are saved, so a later brand
    // flip can't change the SP entity ID the IdP already trusts.
    if (Object.keys(updates).some((k) => k.startsWith("saml")) && !next.samlIssuer) {
      next.samlIssuer = ACTIVE.samlIssuerDefault;
    }
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)],
    );
    // YAN-362 single-user path: a flat PATCH keeps the Default workspace row
    // in step (see mirrorToDefaultWorkspace's ponytail note). Split mode never
    // reaches this with workspace keys: the route 400s them.
    mirrorToDefaultWorkspace(db, updates);
  });
  // Trusted callers get plaintext secrets; stored blob stays ciphertext.
  return mergeWithDefaults(await decryptSecrets(db, next));
}

export const COMBO_NOT_FOUND = "COMBO_NOT_FOUND";

// Transform the latest strategy map under one synchronous SQLite transaction.
// requireComboName: combo must exist in the same transaction (guards stale names after
// rename/delete); otherwise throws an Error with code COMBO_NOT_FOUND and writes nothing.
export async function updateComboStrategies(transform, requireComboName) {
  const db = await getAdapter();
  let next;
  db.transaction(() => {
    if (
      requireComboName !== undefined &&
      !db.get(`SELECT id FROM combos WHERE name = ?`, [requireComboName])
    ) {
      throw Object.assign(new Error("Combo not found"), { code: COMBO_NOT_FOUND });
    }
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const current = row ? parseJson(row.data, {}) : {};
    const strategies = Object.hasOwn(current, "comboStrategies") ? current.comboStrategies : {};
    if (!strategies || typeof strategies !== "object" || Array.isArray(strategies)) {
      throw new Error("Invalid stored comboStrategies");
    }
    const nextStrategies = transform(strategies);
    if (
      !nextStrategies ||
      typeof nextStrategies !== "object" ||
      Array.isArray(nextStrategies) ||
      typeof nextStrategies.then === "function"
    ) {
      throw new Error("Invalid comboStrategies transform result");
    }
    if (nextStrategies === strategies) {
      next = current;
      return;
    }
    next = { ...current, comboStrategies: nextStrategies };
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)],
    );
    mirrorToDefaultWorkspace(db, { comboStrategies: nextStrategies });
  });
  return mergeWithDefaults(next);
}

/**
 * Effective settings for one request (YAN-362). Switch off, or a legacy
 * caller with no principal, means today's blob: getSettings().
 * Otherwise `{ ...instance, ...workspace-overrides, ...user-preferences }`,
 * merged shallowly per workspace/user key.
 * Trust contract: a gateway principal (`workspaceId`) is resolved server-side
 * from the key row, so its workspace is trusted. A session ctx
 * (`activeWorkspaceId`, from the cookie claim) is not: membership is
 * re-verified in SQL and a non-member gets the instance layer only. A switch
 * lookup failure propagates (fail closed); it never enables overrides.
 * @param {object|null} ctx gateway/session principal, or null for the legacy blob view.
 */
export async function getEffectivePreferences(ctx) {
  const trustedWs = typeof ctx?.workspaceId === "string" ? ctx.workspaceId : null;
  const sessionWs = typeof ctx?.activeWorkspaceId === "string" ? ctx.activeWorkspaceId : null;
  const userId = typeof ctx?.userId === "string" ? ctx.userId : null;
  if (!trustedWs && !sessionWs && !userId) return getSettings();
  const { isMultiUserEnabled } = await import("@/lib/users/featureSwitch.js");
  if (!(await isMultiUserEnabled())) return getSettings();
  const merged = await getSettings();
  const db = await getAdapter();
  const wsId =
    trustedWs ??
    (sessionWs &&
    userId &&
    db.get(`SELECT 1 AS x FROM memberships WHERE workspaceId = ? AND userId = ?`, [
      sessionWs,
      userId,
    ])
      ? sessionWs
      : null);
  if (wsId) {
    const row = db.get(`SELECT data FROM workspaceSettings WHERE workspaceId = ?`, [wsId]);
    const wsData = pickKeys(parseJson(row?.data, {}), WORKSPACE_KEYS);
    mergeWorkspaceLayer(merged, wsData);
    // YAN-364: workspace rows key comboStrategies by combo id, the instance blob
    // by name. A workspace with no map of its own must not inherit the blob's
    // (Default's) name-keyed entries: the scoped result is the workspace map or
    // {}, flagged (non-enumerable, shared via Symbol.for with comboKeys.js) so
    // lookups use ids only.
    if (!Object.hasOwn(wsData, "comboStrategies")) merged.comboStrategies = {};
    Object.defineProperty(merged, Symbol.for("tokenhop.comboStrategiesById"), {
      value: true,
      enumerable: false,
    });
  }
  if (typeof userId === "string" && userId) {
    const row = db.get(`SELECT data FROM userPreferences WHERE userId = ?`, [userId]);
    Object.assign(merged, pickKeys(parseJson(row?.data, {}), USER_KEYS));
  }
  return merged;
}

/**
 * One merged object per (instance, workspace) context, for schedulers that
 * can't be scoped (quotaSnapshotPoller, weightedTargets, quotaAutoPing).
 * Background jobs AND over the union. [instance] when no rows or switch off.
 * @returns {Promise<object[]>}
 */
export async function listEffectivePreferencesUnscoped() {
  const instance = await getSettings();
  const { isMultiUserEnabled } = await import("@/lib/users/featureSwitch.js");
  if (!(await isMultiUserEnabled())) return [instance];
  const db = await getAdapter();
  // Every workspace participates; one with no override row inherits instance.
  const rows = db.all(
    `SELECT ws.data FROM workspaces w LEFT JOIN workspaceSettings ws ON ws.workspaceId = w.id`,
  );
  if (!rows.length) return [instance];
  return rows.map((r) =>
    mergeWorkspaceLayer({ ...instance }, pickKeys(parseJson(r.data, {}), WORKSPACE_KEYS)),
  );
}

export async function isCloudEnabled() {
  const settings = await getSettings();
  return settings.cloudEnabled === true;
}

export async function getCloudUrl() {
  const settings = await getSettings();
  return settings.cloudUrl || process.env.CLOUD_URL || process.env.NEXT_PUBLIC_CLOUD_URL || "";
}

// DB settings snapshot helper for exportDb(). The MITM internal verifier
// hash stays host-local (lifecycle-only): it must not travel in a snapshot
// readback, so install/compare-clear always reads the live row, never a
// restore.
export async function exportSettings() {
  const raw = await readRaw();
  delete raw.mitmInternalVerifier;
  return raw;
}
