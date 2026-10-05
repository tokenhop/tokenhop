import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";
import { TenancyError } from "@/lib/users/errors.js";
import { memberWorkspaceId, defaultWorkspaceIdUnscoped } from "./ownership.js";

// mitmAlias is instance-scope host tooling (YAN-364 decision 1): bare keys.
const mitmKv = makeKv("mitmAlias");

// Reserved workspace kv prefix (ADR-0001). Mirrors makeKv's scoping (Task 2.1)
// for the one raw-SQL write below that cannot go through makeKv.
function wsKey(workspaceId, key) {
  return workspaceId ? `ws:${workspaceId}/${key}` : key;
}

// Scoped writes reject user keys inside the reserved `ws:` namespace; routes
// also 400 them, this is the defensive backstop (plan decision 3).
function assertBareKey(key) {
  if (typeof key === "string" && key.startsWith("ws:")) {
    throw new TenancyError("INVALID", "Reserved key prefix");
  }
}

// ─── modelAliases: key=alias, value=modelString ────────────────────────────

export async function getModelAliases(ctx, workspaceId) {
  const db = await getAdapter();
  memberWorkspaceId(ctx, db, workspaceId);
  return await makeKv("modelAliases", { workspaceId }).getAll();
}

export async function setModelAlias(ctx, workspaceId, alias, model) {
  const db = await getAdapter();
  memberWorkspaceId(ctx, db, workspaceId);
  assertBareKey(alias);
  await makeKv("modelAliases", { workspaceId }).set(alias, model);
}

export async function deleteModelAlias(ctx, workspaceId, alias) {
  const db = await getAdapter();
  memberWorkspaceId(ctx, db, workspaceId);
  assertBareKey(alias);
  await makeKv("modelAliases", { workspaceId }).remove(alias);
}

// ─── customModels: key=`${providerAlias}|${id}|${type}`, value=model object ─

function customKey(providerAlias, id, type) {
  return `${providerAlias}|${id}|${type}`;
}

export async function getCustomModels(ctx, workspaceId) {
  const db = await getAdapter();
  memberWorkspaceId(ctx, db, workspaceId);
  return Object.values(await makeKv("customModels", { workspaceId }).getAll());
}

// Atomic upsert inside transaction to prevent duplicate races.
// Re-adding an existing model updates caps/name without resetting omitted fields.
function addCustomModelInTx(db, k, { providerAlias, id, type = "llm", name, caps }) {
  let added = false;
  db.transaction(() => {
    const row = db.get(`SELECT value FROM kv WHERE scope = 'customModels' AND key = ?`, [k]);
    if (row) {
      const prev = parseJson(row.value) || {};
      const next = { ...prev, ...(name ? { name } : {}), ...(caps ? { caps } : {}) };
      db.run(`UPDATE kv SET value = ? WHERE scope = 'customModels' AND key = ?`, [
        stringifyJson(next),
        k,
      ]);
      return;
    }
    const value = stringifyJson({
      providerAlias,
      id,
      type,
      name: name || id,
      ...(caps ? { caps } : {}),
    });
    db.run(`INSERT INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, value]);
    added = true;
  });
  return added;
}

export async function addCustomModel(ctx, workspaceId, data) {
  const db = await getAdapter();
  memberWorkspaceId(ctx, db, workspaceId);
  const k = wsKey(workspaceId, customKey(data.providerAlias, data.id, data.type || "llm"));
  assertBareKey(customKey(data.providerAlias, data.id, data.type || "llm"));
  return addCustomModelInTx(db, k, data);
}

export async function deleteCustomModel(ctx, workspaceId, data) {
  const db = await getAdapter();
  memberWorkspaceId(ctx, db, workspaceId);
  await makeKv("customModels", { workspaceId }).remove(
    customKey(data.providerAlias, data.id, data.type || "llm"),
  );
}

// ─── Unscoped twins (switch-off / legacy path) ─────────────────────────────
// Before the owner bootstrap: bare keys, unchanged. After it: the Default
// workspace's rows only, exposed with unprefixed logical keys (never other
// workspaces' rows).

async function defaultKv(scope) {
  const db = await getAdapter();
  return makeKv(scope, { workspaceId: defaultWorkspaceIdUnscoped(db) });
}

export async function getModelAliasesUnscoped() {
  return await (await defaultKv("modelAliases")).getAll();
}

export async function setModelAliasUnscoped(alias, model) {
  await (await defaultKv("modelAliases")).set(alias, model);
}

export async function deleteModelAliasUnscoped(alias) {
  await (await defaultKv("modelAliases")).remove(alias);
}

export async function getCustomModelsUnscoped() {
  return Object.values(await (await defaultKv("customModels")).getAll());
}

export async function addCustomModelUnscoped(data) {
  const db = await getAdapter();
  return addCustomModelInTx(
    db,
    wsKey(
      defaultWorkspaceIdUnscoped(db),
      customKey(data.providerAlias, data.id, data.type || "llm"),
    ),
    data,
  );
}

export async function deleteCustomModelUnscoped(data) {
  await (await defaultKv("customModels")).remove(
    customKey(data.providerAlias, data.id, data.type || "llm"),
  );
}

// ─── mitmAlias: instance scope, untouched (key=toolName, value=mappings) ───

export async function getMitmAlias(toolName) {
  if (toolName) {
    const v = await mitmKv.get(toolName);
    return v || {};
  }
  return await mitmKv.getAll();
}

export async function setMitmAliasAll(toolName, mappings) {
  await mitmKv.set(toolName, mappings || {});
}
