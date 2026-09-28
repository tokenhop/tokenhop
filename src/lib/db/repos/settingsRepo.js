import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

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
  samlIssuer: "urn:9router:sp",
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
};

async function readRaw() {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  return row ? parseJson(row.data, {}) : {};
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
    const stored = (raw || {})[key];
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

export async function getSettings() {
  const raw = await readRaw();
  return mergeWithDefaults(raw);
}

// Atomic read-merge-write inside transaction (prevents losing concurrent updates)
export async function updateSettings(updates) {
  const db = await getAdapter();
  let next;
  db.transaction(() => {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const current = row ? parseJson(row.data, {}) : {};
    next = { ...current, ...updates };
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)],
    );
  });
  return mergeWithDefaults(next);
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
  });
  return mergeWithDefaults(next);
}

export async function isCloudEnabled() {
  const settings = await getSettings();
  return settings.cloudEnabled === true;
}

export async function getCloudUrl() {
  const settings = await getSettings();
  return settings.cloudUrl || process.env.CLOUD_URL || process.env.NEXT_PUBLIC_CLOUD_URL || "";
}

export async function exportSettings() {
  return await readRaw();
}
