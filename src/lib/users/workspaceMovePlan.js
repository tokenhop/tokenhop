// YAN-701 workspace move: read-only planning. Resolves every requested item by
// explicit (sourceWorkspaceId, id) — a foreign id is just NOT_FOUND, never an
// existence leak — and lists name clashes (conflicts, block the move) and
// consequences the user must confirm (warnings). Sync, adapter-passed: it runs
// inside the apply transaction so the verdict can't go stale before the write.
import { readApiKeyStorageState } from "../db/apiKeyState.js";
import { parseJson } from "../db/helpers/jsonCol.js";
import { moveError } from "./workspaceMoveShared.js";

export const kvKey = (workspaceId, key) => `ws:${workspaceId}/${key}`;

const kvRow = (db, scope, workspaceId, key) =>
  db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [scope, kvKey(workspaceId, key)]);

function kvNames(db, scope, workspaceId) {
  const prefix = kvKey(workspaceId, "");
  return new Set(
    db
      .all(`SELECT key FROM kv WHERE scope = ? AND substr(key, 1, ?) = ?`, [
        scope,
        prefix.length,
        prefix,
      ])
      .map((r) => r.key.slice(prefix.length)),
  );
}

/**
 * @param {object} db adapter
 * @param {{sourceWorkspaceId:string,targetWorkspaceId:string,targetKind:string,items:Array<{type:string,id:string}>}} input
 * @param {{resolveSharing:Function,getSharingWarning:Function}} deps
 * @returns {{ops:object[],conflicts:object[],warnings:object[]}}
 */
export function buildPlan(db, input, deps) {
  const { sourceWorkspaceId: src, targetWorkspaceId: dst, targetKind, items } = input;
  const conflicts = [];
  const warnings = [];
  const ops = [];
  const inSet = (type, id) => items.some((i) => i.type === type && i.id === id);
  const conflict = (it, code, message) =>
    conflicts.push({ type: it.type, id: it.id, code, message });
  const warn = (it, code, message, details) =>
    warnings.push({ type: it.type, id: it.id, code, message, ...(details ? { details } : {}) });
  const notFound = (it) => conflict(it, "NOT_FOUND", "Item not found in the source workspace");

  // Legacy (raw-key) storage has no workspace columns on apiKeys: not movable.
  const hashed = readApiKeyStorageState(db).storage === "hashed";
  if (!hashed && items.some((i) => i.type === "apiKey")) {
    moveError("INVALID", "API key moves require hashed key storage");
  }
  const movingComboNames = new Set(
    items
      .filter((i) => i.type === "combo")
      .map(
        (i) =>
          db.get(`SELECT name FROM combos WHERE id = ? AND workspaceId = ?`, [i.id, src])?.name,
      )
      .filter(Boolean),
  );
  let srcCustom = null;
  let dstCustom = null;
  let srcAliases = null;
  let srcComboNames = null;
  let dstAliases = null;
  let dstComboNames = null;

  for (const it of items) {
    if (it.type === "connection") {
      const row = db.get(`SELECT * FROM providerConnections WHERE id = ? AND workspaceId = ?`, [
        it.id,
        src,
      ]);
      if (!row) {
        notFound(it);
        continue;
      }
      const viaNode = db.get(`SELECT id FROM providerNodes WHERE id = ? AND workspaceId = ?`, [
        row.provider,
        src,
      ]);
      if (viaNode && !inSet("node", viaNode.id)) {
        conflict(it, "NODE_NOT_MOVING", "The custom node this connection uses is not moving");
      }
      // Dedup identity mirrors the repo: email for OAuth logins, else the name.
      const byEmail = row.authType === "oauth" && row.email;
      const column = byEmail || !row.name ? "email" : "name";
      const value = column === "email" ? row.email : row.name;
      if (
        value &&
        db.get(
          `SELECT 1 AS x FROM providerConnections WHERE provider = ? AND workspaceId = ? AND ${column} = ?`,
          [row.provider, dst, value],
        )
      ) {
        conflict(it, "NAME_TAKEN", "The target workspace already has this account");
      }
      const grants = db.get(
        `SELECT COUNT(*) AS n FROM connectionGrants WHERE connectionId = ? AND revokedAt IS NULL`,
        [it.id],
      ).n;
      if (grants > 0) {
        warn(it, "GRANTS_REVOKED", "Active grants on this connection will be revoked", {
          count: grants,
        });
      }
      if (
        !viaNode &&
        targetKind === "shared" &&
        deps.resolveSharing(row.provider, row.authType) === "personal"
      ) {
        warn(it, "PROVIDER_TERMS", deps.getSharingWarning(row.provider));
      }
      ops.push({ ...it, row, grants });
    } else if (it.type === "node") {
      const row = db.get(`SELECT * FROM providerNodes WHERE id = ? AND workspaceId = ?`, [
        it.id,
        src,
      ]);
      if (!row) {
        notFound(it);
        continue;
      }
      const prefix = parseJson(row.data, {}).prefix;
      if (
        typeof prefix === "string" &&
        prefix &&
        db
          .all(`SELECT data FROM providerNodes WHERE workspaceId = ?`, [dst])
          .some((r) => parseJson(r.data, {}).prefix === prefix)
      ) {
        conflict(it, "NAME_TAKEN", "The target workspace already uses this node prefix");
      }
      const staying = db
        .all(`SELECT id FROM providerConnections WHERE provider = ? AND workspaceId = ?`, [
          it.id,
          src,
        ])
        .some((r) => !inSet("connection", r.id));
      if (staying) {
        conflict(it, "NODE_IN_USE", "Connections that use this node are not moving with it");
      }
      ops.push({ ...it, row });
    } else if (it.type === "combo") {
      const row = db.get(`SELECT * FROM combos WHERE id = ? AND workspaceId = ?`, [it.id, src]);
      if (!row) {
        notFound(it);
        continue;
      }
      if (db.get(`SELECT 1 AS x FROM combos WHERE name = ? AND workspaceId = ?`, [row.name, dst])) {
        conflict(it, "NAME_TAKEN", "The target workspace already has a combo with this name");
      }
      srcAliases ??= kvNames(db, "modelAliases", src);
      dstAliases ??= kvNames(db, "modelAliases", dst);
      srcComboNames ??= new Set(
        db.all(`SELECT name FROM combos WHERE workspaceId = ?`, [src]).map((r) => r.name),
      );
      dstComboNames ??= new Set(
        db.all(`SELECT name FROM combos WHERE workspaceId = ?`, [dst]).map((r) => r.name),
      );
      const refs = new Set();
      for (const model of parseJson(row.models, [])) {
        if (typeof model !== "string") continue;
        const split = model.indexOf("/");
        if (split > 0) {
          const provider = model.slice(0, split);
          const isNode = db.get(
            `SELECT 1 AS x FROM providerNodes WHERE id = ? AND workspaceId = ?`,
            [provider, src],
          );
          if (isNode && !inSet("node", provider)) refs.add(provider);
          // Custom models are keyed `<providerAlias>|<modelId>|<type>`; a combo
          // ref `<providerAlias>/<modelId>` matches any type. Dangling when the
          // source has it, it isn't moving, and the target can't resolve it.
          const prefix = `${provider}|${model.slice(split + 1)}|`;
          srcCustom ??= kvNames(db, "customModels", src);
          dstCustom ??= kvNames(db, "customModels", dst);
          const has = (names) => [...names].some((k) => k.startsWith(prefix));
          const moving = items.some((i) => i.type === "customModel" && i.id.startsWith(prefix));
          if (has(srcCustom) && !moving && !has(dstCustom)) refs.add(`custom:${model}`);
        } else if (srcAliases.has(model) && !inSet("alias", model) && !dstAliases.has(model)) {
          refs.add(model);
        } else if (
          srcComboNames.has(model) &&
          !movingComboNames.has(model) &&
          !dstComboNames.has(model)
        ) {
          refs.add(model);
        }
      }
      if (refs.size > 0) {
        warn(it, "COMBO_REF_NOT_MOVING", "This combo refers to items that stay behind", {
          count: refs.size,
        });
      }
      const keysLeft = hashed
        ? db
            .all(`SELECT id, allowedCombos FROM apiKeys WHERE workspaceId = ?`, [src])
            .filter((k) => !inSet("apiKey", k.id) && parseJson(k.allowedCombos, []).includes(it.id))
        : [];
      if (keysLeft.length > 0) {
        warn(it, "KEY_COMBO_REF", "API keys that stay behind are restricted to this combo", {
          count: keysLeft.length,
        });
      }
      ops.push({ ...it, row });
    } else if (it.type === "apiKey") {
      const row = db.get(`SELECT * FROM apiKeys WHERE id = ? AND workspaceId = ?`, [it.id, src]);
      if (!row) {
        notFound(it);
        continue;
      }
      if (
        row.userId &&
        !db.get(
          `SELECT 1 AS x FROM memberships m JOIN users u ON u.id = m.userId
           WHERE m.workspaceId = ? AND m.userId = ? AND u.status = 'active'`,
          [dst, row.userId],
        )
      ) {
        conflict(it, "KEY_OWNER_NOT_MEMBER", "The key's owner is not a member of the target");
      }
      const ok = (comboId) =>
        inSet("combo", comboId) ||
        db.get(`SELECT 1 AS x FROM combos WHERE id = ? AND workspaceId = ?`, [comboId, dst]);
      if (parseJson(row.allowedCombos, []).some((c) => !ok(c))) {
        conflict(it, "KEY_COMBO_REF", "The key is restricted to combos missing in the target");
      }
      // Key budgets follow their key (ids, limits and spend history intact). The
      // target's workspace ceiling still applies, exactly as budgetsRepo
      // requireWrite enforces it (NULL = unlimited exceeds a finite cap).
      const ceilings = db.all(
        `SELECT window, limitUsd, limitTokens, limitRequests FROM budgets WHERE scopeType = 'workspace' AND scopeId = ?`,
        [dst],
      );
      const keyBudgets = db.all(
        `SELECT window, limitUsd, limitTokens, limitRequests FROM budgets WHERE scopeType = 'key' AND scopeId = ?`,
        [it.id],
      );
      const LIMITS = ["limitUsd", "limitTokens", "limitRequests"];
      if (
        keyBudgets.some((b) =>
          ceilings.some(
            (c) =>
              c.window === b.window &&
              LIMITS.some((f) => c[f] !== null && (b[f] === null || b[f] > c[f])),
          ),
        )
      ) {
        conflict(
          it,
          "KEY_BUDGET_EXCEEDS_TARGET",
          "The key's budget exceeds the target workspace budget",
        );
      }
      ops.push({ ...it, row });
    } else {
      const scope = {
        alias: "modelAliases",
        customModel: "customModels",
        disabledModel: "disabledModels",
      }[it.type];
      const row = kvRow(db, scope, src, it.id);
      if (!row) {
        notFound(it);
        continue;
      }
      if (kvRow(db, scope, dst, it.id)) {
        conflict(it, "NAME_TAKEN", "The target workspace already has an entry with this key");
      }
      ops.push({ ...it, scope });
    }
  }
  return { ops, conflicts, warnings };
}
