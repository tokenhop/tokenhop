import { makeKv } from "../helpers/kvStore.js";

// cliToolSettings: key=bare toolId (instance scope), value=settings object.
// Keep the key bare so a scoped prefix (e.g. `ws:<id>/<toolId>`) can be added later without migration.
const kv = makeKv("cliToolSettings");

export async function getCliToolSettings(toolId) {
  if (toolId) return (await kv.get(toolId)) || {};
  return await kv.getAll();
}

export async function setCliToolSettings(toolId, value) {
  await kv.set(toolId, value || {});
}

export async function deleteCliToolSettings(toolId) {
  await kv.remove(toolId);
}

// Saved endpoint / API-key presets (kv scope cliToolPresets, key = kind).
const presetsKv = makeKv("cliToolPresets");

export async function getCliToolPresets() {
  return { endpoints: [], apiKeys: [], ...(await presetsKv.getAll()) };
}

export async function setCliToolPresets(kind, items) {
  await presetsKv.set(kind, items || []);
}
