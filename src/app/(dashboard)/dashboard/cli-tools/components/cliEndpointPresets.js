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
// Shared in-flight load; reset on failure so a later read() retries.
let loadPromise = null;
// Saves are blocked until the first load succeeds: a whole-list PUT from the
// empty pre-load cache would wipe presets saved elsewhere (same rule as
// toolSettingsStore's loadFailed).
let loaded = false;

function setStoreItems(store, next) {
  if (JSON.stringify(next) === JSON.stringify(store.items)) return;
  store.items = next;
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(store.changeEvent));
}

async function importFromStorage(store) {
  let local = [];
  try {
    const raw = JSON.parse(readStorageItem(window.localStorage, store.storageName) || "[]");
    if (Array.isArray(raw)) local = raw.filter((p) => p?.name && p?.[store.itemField]);
  } catch {
    local = [];
  }
  if (!local.length) return;
  setStoreItems(store, local);
  try {
    const res = await fetch("/api/cli-tool-presets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: store.kind, items: local }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (err) {
    console.log("Error importing CLI tool presets:", err.message);
    return;
  }
  window.localStorage.removeItem(ACTIVE.storageKeyPrefix + store.storageName);
  window.localStorage.removeItem(LEGACY.storageKeyPrefix + store.storageName); // legacy(9router): remove in v2
}

function load() {
  loadPromise ??= (async () => {
    const res = await fetch("/api/cli-tool-presets");
    if (!res.ok) throw new Error(`status ${res.status}`);
    const { presets } = await res.json();
    for (const store of stores) {
      const list = Array.isArray(presets?.[store.kind])
        ? presets[store.kind].filter((p) => p?.name && p?.[store.itemField])
        : [];
      if (list.length) setStoreItems(store, list);
      else await importFromStorage(store);
    }
    loaded = true;
  })().catch((err) => {
    loadPromise = null;
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
}) {
  const store = { kind, storageName, changeEvent, itemField, items: [] };
  stores.push(store);

  const read = () => {
    if (typeof window === "undefined") return store.items;
    load();
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
    // Adds or replaces a preset; returns the stored name, or null when skipped
    upsert: (value, name) => {
      const v = normalize(value);
      if (!v) return null;

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
});

export const readPresets = endpoints.read;
export const subscribePresets = endpoints.subscribe;
export const upsertPreset = endpoints.upsert;
export const deletePreset = endpoints.remove;

export const readKeyPresets = apiKeys.read;
export const subscribeKeyPresets = apiKeys.subscribe;
export const upsertKeyPreset = apiKeys.upsert;
export const deleteKeyPreset = apiKeys.remove;

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
