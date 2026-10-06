import { makeKv } from "../helpers/kvStore.js";
import { getAdapter } from "../driver.js";
import { readApiKeyStorageState } from "../apiKeyState.js";
import { hashApiKey } from "../../security/masterKey.js";
import { getApiKeyHashKey } from "../../security/apiKeyHashKey.js";
import { can } from "../../users/principal.js";
import { containToolSettings } from "../../cliToolConfigs/toolSettings.js";

// cliToolSettings: key=bare toolId (instance scope), value=settings object.
// Keep the key bare so a scoped prefix (e.g. `ws:<id>/<toolId>`) can be added later without migration.
const kv = makeKv("cliToolSettings");

// Saved endpoint / API-key presets (kv scope cliToolPresets, key = kind).
// Hashed storage (YAN-363): apiKeys presets become canonical {name, apiKeyId}
// references to HMAC-matched rows. Unmatched raws are migration-vetted
// external credentials: preserved byte-for-byte on disk, never disclosed.
const presetsKv = makeKv("cliToolPresets");

const withheld = (status = 400) => {
  throw Object.assign(new Error("Credential preset rejected; values withheld"), { status });
};

// Instance-scope credential context. Null on legacy storage: every preset
// read/write then keeps today's byte-identical behaviour. On hashed storage a
// live session/CLI principal with instance.hostOps plus workspace key
// management is required; bearer (via apiKey) and anonymous principals fail 403.
export async function cliCredentialContext(ctx) {
  const db = await getAdapter();
  const state = readApiKeyStorageState(db);
  if (state.storage !== "hashed") return null;
  if (ctx === undefined) {
    try {
      const { getPrincipal } = await import("../../users/session.js");
      ctx = await getPrincipal();
    } catch {
      ctx = null;
    }
  }
  if (!ctx || !["session", "cli"].includes(ctx.via) || ctx.apiKeyId != null) withheld(403);
  const user = db.get("SELECT instanceRole, status FROM users WHERE id = ?", [ctx.userId]);
  if (user?.status !== "active") withheld(403);
  if (!can({ instanceRole: user.instanceRole }, "instance.hostOps")) withheld(403);
  const { hashKey } = await getApiKeyHashKey(db);
  const rows = db.all("SELECT * FROM apiKeys");
  const hash = (raw) => hashApiKey(raw, hashKey);
  const byHash = new Map(rows.map((row) => [row.keyHash, row]));
  // Live membership re-read per call: ctx roles are advisory only.
  const authorized = (row) => {
    const membership = db.get("SELECT role FROM memberships WHERE workspaceId = ? AND userId = ?", [
      row.workspaceId,
      ctx.userId,
    ]);
    return Boolean(
      membership &&
        can(
          {
            instanceRole: user.instanceRole,
            workspaceRoles: { [row.workspaceId]: membership.role },
          },
          "workspace.keys.manage",
          { workspaceId: row.workspaceId },
        ),
    );
  };
  const ref = (id) => {
    const row = rows.find((r) => r.id === id);
    if (!row || !authorized(row)) withheld(403); // foreign/unknown ids never leak which
    return row;
  };
  const rawRow = (raw) => byHash.get(hash(raw)) ?? null;
  return { db, hash, rawRow, ref, authorized, userId: ctx.userId };
}

// ctx-first (tenancy guard): ctx may be undefined (routes keep the lazy
// session lookup inside cliCredentialContext) or an explicit principal.
export async function getCliToolSettings(ctx, toolId) {
  const context = await cliCredentialContext(ctx);
  if (!context) return toolId ? (await kv.get(toolId)) || {} : await kv.getAll();
  const contain = (value) => containToolSettings(value, value, context, true);
  return toolId
    ? contain((await kv.get(toolId)) || {})
    : Object.fromEntries(
        Object.entries(await kv.getAll()).map(([id, value]) => [id, contain(value)]),
      );
}

export async function setCliToolSettings(ctx, toolId, value) {
  const context = await cliCredentialContext(ctx);
  if (!context) return kv.set(toolId, value || {});
  // Known credential slots convert to canonical refs (or are preserved); any
  // other raw stash attempt stops before mutation. Non-secret prefs pass through.
  const next = containToolSettings(value || {}, (await kv.get(toolId)) || {}, context);
  await kv.set(toolId, next);
}

export async function deleteCliToolSettings(ctx, toolId) {
  // Deletion is as destructive as a write: hashed storage requires the same
  // credential context (bearer/anonymous/disabled principals are refused 403
  // before kv.remove). Legacy storage returns null here and keeps the exact
  // old unconditional deletion.
  await cliCredentialContext(ctx);
  await kv.remove(toolId);
}

// Stable, opaque, non-reversible reference for a retained external entry.
// Same entry ⇒ same ref; no raw or prefix ever enters the digest label.
const externalRef = (item, context) =>
  context.hash(`cli-tool-preset-external:${JSON.stringify(item)}`);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Projection only: stored external rows are never copied into responses.
function project(items, context) {
  const out = [];
  for (const item of items) {
    if (!isObj(item)) withheld();
    const stored =
      typeof item.apiKeyId === "string"
        ? context.db.get("SELECT * FROM apiKeys WHERE id = ?", [item.apiKeyId])
        : typeof item.key === "string"
          ? context.rawRow(item.key)
          : null;
    if (stored) {
      if (!context.authorized(stored)) continue; // foreign ref: hidden, never an error signal
      if (typeof item.name !== "string" || !item.name) withheld();
      out.push({ name: safeName(item.name, item.key), apiKeyId: stored.id });
      continue;
    }
    if (typeof item.key !== "string" || !item.key) withheld();
    // Retained external credential: metadata marker + opaque reference only.
    out.push({
      name: "External credential",
      external: true,
      externalRef: externalRef(item, context),
    });
  }
  return out;
}

// Legacy (pre-YAN-363) writes keep the exact route-era contract.
function assertLegacyItems(items) {
  if (!Array.isArray(items) || items.length > 64) withheld();
  for (const item of items) {
    if (
      !isObj(item) ||
      Object.keys(item).length !== 2 ||
      typeof item.name !== "string" ||
      item.name.length < 1 ||
      item.name.length > 128 ||
      typeof item.key !== "string" ||
      item.key.length < 1 ||
      item.key.length > 2048
    ) {
      withheld();
    }
  }
}

// Keep caller labels unless they contain the raw credential.
function safeName(name, raw) {
  return typeof raw === "string" && name.includes(raw) ? "API key" : name;
}

export async function getCliToolPresets(ctx) {
  const context = await cliCredentialContext(ctx);
  const values = { endpoints: [], apiKeys: [], ...(await presetsKv.getAll()) };
  if (!context) return values;
  return { endpoints: values.endpoints, apiKeys: project(values.apiKeys, context) };
}

export async function setCliToolPresets(ctx, kind, items) {
  const context = await cliCredentialContext(ctx);
  if (!context) {
    // Legacy storage: exact route-era contract, byte-identical writes.
    if (kind === "apiKeys") assertLegacyItems(items || []);
    return presetsKv.set(kind, items || []);
  }
  if (kind !== "apiKeys") return presetsKv.set(kind, items || []);
  const old = (await presetsKv.get("apiKeys")) || [];
  if (!Array.isArray(old)) withheld();

  const rowOf = (item) =>
    typeof item.apiKeyId === "string"
      ? context.db.get("SELECT * FROM apiKeys WHERE id = ?", [item.apiKeyId])
      : typeof item.key === "string"
        ? context.rawRow(item.key)
        : null;

  // Preserve omitted entries and order; canonicalize known raws even when
  // foreign. Authorization below still rejects attempts to write foreign refs.
  const next = old.map((entry) => {
    if (!isObj(entry)) withheld();
    const row = rowOf(entry);
    if (row) {
      if (typeof entry.name !== "string" || !entry.name) withheld();
      return { name: safeName(entry.name, entry.key), apiKeyId: row.id };
    }
    if (typeof entry.key !== "string" || !entry.key) withheld();
    return entry; // existing unmatched raw: confirmed external at activation
  });
  const indexOfId = (id) => next.findIndex((e) => e.apiKeyId === id);

  for (const item of items) {
    if (!isObj(item)) withheld();
    const keys = Object.keys(item);
    if (item.externalRef !== undefined) {
      // Round-trip of a projected external entry: preserve byte-for-byte, same
      // destination binding only. No renaming, no retargeting, no new externals.
      const remaining = next.find(
        (e) => typeof e.key === "string" && externalRef(e, context) === item.externalRef,
      );
      if (
        !remaining ||
        item.external !== true ||
        item.name !== "External credential" ||
        keys.length !== 3
      ) {
        withheld();
      }
      continue;
    }
    if (
      keys.length !== 2 ||
      typeof item.name !== "string" ||
      !item.name ||
      item.name.length > 128
    ) {
      withheld();
    }
    const row = rowOf(item);
    if (!row) withheld(); // Unknown raw: ambiguous; no mutation, no leak.
    context.ref(row.id); // Foreign/unknown id: 403. Includes inactive/revoked rows.
    const at = indexOfId(row.id);
    const entry = { name: safeName(item.name, item.key), apiKeyId: row.id };
    if (at >= 0) next[at] = entry;
    else next.push(entry);
  }
  await presetsKv.set(kind, next);
}
