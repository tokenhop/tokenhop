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
