import { ACTIVE, LEGACY } from "@/shared/brand";
import { UPDATER_CONFIG } from "@/shared/constants/config";

// Read the active key; otherwise the legacy key. Used only for the one-time
// localStorage import below.
function readStorageItem(storage, name) {
  const key = ACTIVE.storageKeyPrefix + name;
  const value = storage.getItem(key);
  if (value !== null) return value;
  const legacyKey = LEGACY.storageKeyPrefix + name; // legacy(9router): remove in v2
  if (legacyKey === key) return null;
  return storage.getItem(legacyKey);
}

const stores = [];
// Shared in-flight load; reset on failure so a later read() retries after the cooldown.
let loadPromise = null;
// Cooldown after a failed GET, so read()-during-render cannot fetch-storm a down server.
const RETRY_MS = 5000;
let failedAt = 0;
// Saves are blocked until the first load succeeds: a whole-list PUT from the
// empty pre-load cache would wipe presets saved elsewhere (same rule as
// toolSettingsStore's loadFailed).
let loaded = false;

function setStoreItems(store, next) {
  if (JSON.stringify(next) === JSON.stringify(store.items)) return;
  store.items = next;
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(store.changeEvent));
}

// Saved apiKeys items: legacy raw { name, key }, hashed ref { name, apiKeyId },
// or the projected external marker { name, external: true, externalRef }.
const isApiKeyPreset = (p) =>
  Boolean(
    p &&
      typeof p.name === "string" &&
      p.name &&
      ((typeof p.key === "string" && p.key) ||
        typeof p.apiKeyId === "string" ||
        (p.external === true && typeof p.externalRef === "string")),
  );
// Only the key-context contract determines storage mode; empty/ref lists cannot.
let keyStorageMode = null;
// Empty GET can arrive before key context; retain eligibility until confirmed.
let deferredLegacyImport = false;
let apiKeyImportDone = false;
let keyModeVersion = 0;
export function setKeyPresetStorageMode(mode) {
  const next = ["hashed", "legacy"].includes(mode) ? mode : null;
  if (next === keyStorageMode) return;
  keyStorageMode = next;
  keyModeVersion += 1;
  if (deferredLegacyImport && !apiKeyImportDone) {
    const store = stores.find((s) => s.neverRaw);
    if (next === "legacy" && loaded && store) {
      deferredLegacyImport = false;
      void runApiKeyImport(store);
    } else if (next === "hashed") {
      deferredLegacyImport = false;
      // The unknown empty GET is now resolved as canonical empty; the
      // browser localStorage copy stays untouched.
      if (store) setStoreItems(store, []);
    }
    // Unknown reset leaves the deferral armed for the confirmed mode.
  }
}

function runApiKeyImport(store) {
  apiKeyImportDone = true;
  return importFromStorage(store, true);
}

async function importFromStorage(store, legacyOnly = false) {
  let local = [];
  try {
    const raw = JSON.parse(readStorageItem(window.localStorage, store.storageName) || "[]");
    if (Array.isArray(raw)) local = raw.filter((p) => p?.name && p?.[store.itemField]);
  } catch {
    local = [];
  }
  if (!local.length) return;
  // Confirmed-legacy-only import (apiKeys): a mode flip while the import was
  // pending means raw keys must not be PUT anywhere.
  if (legacyOnly && keyStorageMode !== "legacy") return;
  const modeVersion = keyModeVersion;
  setStoreItems(store, local);
  try {
    const res = await fetch("/api/cli-tool-presets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: store.kind, items: local }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const { presets } = await res.json();
    // The acknowledged server list is canonical — including an empty one (all
    // entries removed or filtered as external). A malformed response is NOT
    // an acknowledgment: never apply the optimistic browser copy as truth.
    if (!Array.isArray(presets?.[store.kind])) throw new Error("malformed preset response");
    // Obsolete legacy responses cannot replace cache or delete browser data.
    // A hashed confirmation in the meantime resolves to canonical empty.
    if (legacyOnly && modeVersion !== keyModeVersion) {
      if (keyStorageMode === "hashed") setStoreItems(store, []);
      return;
    }
    applyServerItems(store, presets);
  } catch (err) {
    // Ambiguous rejection: keep the browser copy and the local raws — never
    // delete data the server has not confirmed it holds.
    console.log("Error importing CLI tool presets:", err.message);
    if (store.kind === "apiKeys" && modeVersion === keyModeVersion) setImportError(store, local);
    return;
  }
  window.localStorage.removeItem(ACTIVE.storageKeyPrefix + store.storageName);
  window.localStorage.removeItem(LEGACY.storageKeyPrefix + store.storageName); // legacy(9router): remove in v2
}

// Replace a store's items with the server's canonical list for its kind.
function applyServerItems(store, presets) {
  const list = presets?.[store.kind];
  setStoreItems(store, Array.isArray(list) ? list.filter(store.isValid) : []);
}

// YAN-363: text shown when a hashed server could not accept the browser's raw
// key presets. Kept data, clear error — never silent deletion.
function setImportError(store, kept) {
  store.importError = kept
    ? `${kept.length} saved key preset${kept.length > 1 ? "s" : ""} kept in this browser — the server did not confirm them. Nothing was deleted.`
    : "";
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(store.changeEvent));
}

function load() {
  loadPromise ??= (async () => {
    const res = await fetch("/api/cli-tool-presets");
    if (!res.ok) throw new Error(`status ${res.status}`);
    const { presets } = await res.json();
    for (const store of stores) {
      const list = Array.isArray(presets?.[store.kind])
        ? presets[store.kind].filter(store.isValid)
        : [];
      if (list.length) {
        setStoreItems(store, list);
        if (store.neverRaw) {
          deferredLegacyImport = false;
          apiKeyImportDone = true;
        }
      } else if (store.neverRaw && keyStorageMode === "hashed") setStoreItems(store, []);
      else if (store.neverRaw && keyStorageMode === "legacy") await runApiKeyImport(store);
      else if (!store.neverRaw) await importFromStorage(store);
      // Unknown mode defers the eligible legacy import until the key context
      // confirms a mode; the cache stays untouched (never canonical empty).
      else if (!apiKeyImportDone) deferredLegacyImport = true;
    }
    loaded = true;
  })().catch((err) => {
    loadPromise = null;
    failedAt = Date.now();
    console.log("Error fetching CLI tool presets:", err.message);
  });
  return loadPromise;
}

// DB-backed preset stores (endpoints, API keys) shared by every CLI tool card
function createStore({
  kind,
  storageName,
  changeEvent,
  itemField,
  normalize = (v) => v,
  defaultName = (v) => v,
  isValid = (p) => Boolean(p?.name && p?.[itemField]),
  // YAN-363: hashed mode never accepts a raw key write for this store.
  neverRaw = false,
}) {
  const store = {
    kind,
    storageName,
    changeEvent,
    itemField,
    items: [],
    isValid,
    neverRaw,
    importError: "",
  };
  stores.push(store);

  const read = () => {
    if (typeof window === "undefined") return store.items;
    if (Date.now() - failedAt >= RETRY_MS) load();
    return store.items;
  };

  const write = (items) => {
    if (typeof window === "undefined") return;
    setStoreItems(store, items);
    if (!loaded) {
      console.log("CLI tool presets not loaded; preset not saved");
      return;
    }
    fetch("/api/cli-tool-presets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, items }),
    }).catch((err) => console.log("Error saving CLI tool presets:", err.message));
  };

  return {
    read,
    subscribe: (handler) => {
      if (typeof window === "undefined") return () => {};
      window.addEventListener(changeEvent, handler);
      return () => window.removeEventListener(changeEvent, handler);
    },
    readImportError: () => store.importError,
    // Adds or replaces a preset; returns the stored name, or null when skipped
    upsert: (value, name) => {
      const v = normalize(value);
      if (!v) return null;
      if (store.neverRaw) {
        // Authoritative mode gate: hashed never accepts a raw key; unknown
        // (context not loaded or failed) fails closed for writes. Raw saves
        // happen only under a confirmed legacy context — never inferred from
        // the shape of the preset list (empty or external-only included).
        if (keyStorageMode !== "legacy" || store.importError) return null;
      }

      const items = read();
      const existing = items.find((p) => normalize(p[itemField]) === v);
      if (existing && !name) return existing.name;

      const finalName = (name || defaultName(v)).trim();
      if (!finalName) return null;

      const next = [
        ...items.filter((p) => p.name !== finalName && normalize(p[itemField]) !== v),
        { name: finalName, [itemField]: v },
      ].sort((a, b) => a.name.localeCompare(b.name));
      write(next);
      return finalName;
    },
    remove: (name) => write(read().filter((p) => p.name !== name)),
  };
}

const stripSlash = (url) => (url || "").replace(/\/+$/, "");

const endpoints = createStore({
  kind: "endpoints",
  storageName: "cliToolEndpointPresets",
  changeEvent: `${ACTIVE.eventPrefix}endpoint-presets-changed`,
  itemField: "baseUrl",
  normalize: stripSlash,
  defaultName: (url) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  },
});

const apiKeys = createStore({
  kind: "apiKeys",
  storageName: "cliToolApiKeyPresets",
  changeEvent: `${ACTIVE.eventPrefix}api-key-presets-changed`,
  itemField: "key",
  // Legacy raw { name, key }, hashed ref { name, apiKeyId }, or the projected
  // external marker { name, external: true, externalRef }. Refs are display
  // metadata only — no raw secret is ever recoverable from them.
  isValid: isApiKeyPreset,
  neverRaw: true,
});

export const readPresets = endpoints.read;
export const subscribePresets = endpoints.subscribe;
export const upsertPreset = endpoints.upsert;
export const deletePreset = endpoints.remove;

export const readKeyPresets = apiKeys.read;
export const subscribeKeyPresets = apiKeys.subscribe;
export const upsertKeyPreset = apiKeys.upsert;
export const deleteKeyPreset = apiKeys.remove;
export const readKeyImportError = apiKeys.readImportError;

// Save an applied endpoint unless it exactly matches a built-in dropdown option
export function rememberEndpoint(baseUrl, { tunnelPublicUrl, tailscaleUrl, cloudUrl } = {}) {
  const url = stripSlash(baseUrl);
  if (!url) return null;

  const builtIns = [
    `http://127.0.0.1:${UPDATER_CONFIG.appPort}`,
    tunnelPublicUrl,
    tailscaleUrl,
    cloudUrl,
  ]
    .filter(Boolean)
    .flatMap((u) => [stripSlash(u), `${stripSlash(u)}/v1`]);
  if (builtIns.includes(url)) return null;

  return upsertPreset(url);
}

export { stripSlash };
