# Plan: YAN-364 — workspace-scoped combos, model aliases, custom models and disabled models

## Summary

Combos, model aliases, custom models and disabled models are instance-global today. YAN-364 moves them behind the workspace boundary per ADR-0001: a rebuilt `combos` table with `workspaceId` + `UNIQUE(workspaceId, name)`, `ws:<workspaceId>/` key-prefix scoping for the three kv scopes, id-keyed `comboStrategies` in workspace settings, scoped dashboard routes, and principal-aware name resolution in the gateway. Switch off = byte-identical single-user behaviour.

## User Story

As a workspace member, I want my combos, aliases, custom and disabled models to exist only in my workspace, so that two workspaces can reuse the same names without seeing or clobbering each other.

## Problem → Solution

One global combo/alias/disabled/custom-model set, `combos.name UNIQUE` instance-wide, combo strategies keyed by combo **name** in the instance blob → workspace-scoped storage (`combos.workspaceId`, `ws:<id>/` kv keys), strategies keyed by combo **id** in workspace settings, and request resolution that reads only the caller's workspace, then built-ins. No cross-workspace fallback.

## Metadata

- **Complexity**: Large (~28 files)
- **Source PRD**: N/A — issue YAN-364 + `docs/users/README.md` (§4, §5, §7, §8) + `docs/users/spec.md` + ADR-0001
- **PRD Phase**: N/A
- **Estimated Files**: 13 src creates/updates + 3 route updates + 5 handler updates + 2 test files + fixture
- **Trunk landing**: **behind the switch** (`TOKENHOP_MULTI_USER`). Switch off = today.

## Batches

Tasks grouped by dependency for parallel execution. Tasks within the same batch run concurrently; batches run in order.

| Batch | Tasks                   | Depends On | Parallel Width |
| ----- | ----------------------- | ---------- | -------------- |
| B1    | 1.1                     | —          | 1              |
| B2    | 2.1, 2.2, 2.3, 2.4, 2.5 | B1         | 5              |
| B3    | 3.1, 3.2, 3.3           | B2         | 3              |
| B4    | 4.1                     | B3         | 1              |
| B5    | 5.1                     | B4         | 1              |

- **Total tasks**: 11
- **Total batches**: 5
- **Max parallel width**: 5

### Naming contract (B2 tasks run in parallel; agree on these exact export names up front)

Repo exports owned by Task 2.2, consumed by 2.4, 2.5 and B3 (all re-exported from `src/lib/db/index.js`):

- combos: `getCombosUnscoped`, `getComboByIdUnscoped`, `getComboByNameUnscoped`, `createComboUnscoped`, `updateComboUnscoped`, `deleteComboUnscoped`, `reorderCombosUnscoped`; scoped `listCombos(ctx, workspaceId)`, `getCombo(ctx, id)`, `getComboByNameScoped(ctx, workspaceId, name)`, `createCombo(ctx, workspaceId, data)`, `updateCombo(ctx, id, data)`, `deleteCombo(ctx, id)`, `reorderCombos(ctx, workspaceId, ids)`.
- aliases/custom: `getModelAliasesUnscoped`, `setModelAliasUnscoped`, `deleteModelAliasUnscoped`, `getCustomModelsUnscoped`, `addCustomModelUnscoped`, `deleteCustomModelUnscoped`; scoped `getModelAliases(ctx, workspaceId)`, `setModelAlias(ctx, workspaceId, alias, model)`, `deleteModelAlias(ctx, workspaceId, alias)`, `getCustomModels(ctx, workspaceId)`, `addCustomModel(ctx, workspaceId, data)`, `deleteCustomModel(ctx, workspaceId, data)`.
- disabled: `getDisabledModelsUnscoped`, `getDisabledByProviderUnscoped`, `disableModelsUnscoped`, `enableModelsUnscoped`; scoped `getDisabledModels(ctx, workspaceId)`, `getDisabledByProvider(ctx, workspaceId, providerAlias)`, `disableModels(ctx, workspaceId, providerAlias, ids)`, `enableModels(ctx, workspaceId, providerAlias, ids)`.
- kv: `makeKv(scope, ctx = null)` where `ctx` is any object with `workspaceId` (Task 2.1). Prefix filtering uses `substr(key, 1, ?) = ?`, never `LIKE` (alias keys may contain `%`/`_`).
- ownership (Task 2.1): `adoptOwnerlessRowsUnscoped(db)` **itself** gains combos + kv + strategy-seed adoption; every existing caller (`bootstrap.js runBootstrap` both branches, `usersRepo.js bootstrapOwnerUnscoped`, `importDb`) gets it for free.
- lookup helpers (Task 2.2, new file `src/lib/comboKeys.js`): `comboStrategyKey(principal, combo)` returns `combo.id` when a principal exists, else `combo.name`; `comboRotationKey(workspaceId, name)` returns `workspaceId:name` when a workspaceId exists, else `name`. Consumed by 3.1/3.3 (and `weightedTargets` via the dual-lookup note in 2.2).
- gateway readers (Task 2.5): `getGatewayCombos`, `getGatewayAliases`, `getGatewayCustomModels`, `getGatewayDisabled`.

Breakage window: Task 2.2 renames repo exports. Its edits repoint the call sites it owns (index/shims/schedulers/export/summary); the **direct** `@/lib/db/repos/combosRepo.js` imports in `chat.js`, `tts.js`, `imageGeneration.js` (Task 3.3) and the combos routes/probe (3.1) keep working through the `localDb`/`models` shim aliases only until B3 rewrites them. **Land B2 + B3 as one unit** (one commit/PR stack) before running the full suite; the per-task VALIDATE lines run only their own tests.

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/tokenhop/tokenhop/.claude/worktrees/yan-364 (branch: feat/yan-364-scoped-combos)

All tasks — parallel and sequential — share this one feature worktree path.

## UX Design

### Before

One shared list of combos/aliases/custom/disabled models; combo strategy editor keyed by combo name.

### After

Each workspace sees and edits only its own combos/aliases/models; same combo name can exist in two workspaces independently; strategy editor stores per-combo-id entries. Single-user install (switch off): pixels and bytes unchanged.

### Interaction Changes

| Touchpoint                                                  | Before       | After           | Notes                                                                                                                        |
| ----------------------------------------------------------- | ------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `/dashboard/combos`, provider model lists                   | global lists | workspace lists | only when switch on and 2+ active users (`workspaceScope` precedent)                                                         |
| `comboStrategyPatch` API on `/api/workspaces/[id]/settings` | name-keyed   | id-keyed        | workspace route accepts `{ id }` or `{ name }` (name resolved to id in that workspace); instance `/api/settings` keeps names |

---

## Mandatory Reading

Files that MUST be read before implementing:

| Priority | File                                                   | Lines                     | Why                                                                               |
| -------- | ------------------------------------------------------ | ------------------------- | --------------------------------------------------------------------------------- |
| P0       | `docs/users/README.md`                                 | §4, §5, §7, §8            | binding scope: scoped-by-default, ctx-first repos, cross-workspace negative tests |
| P0       | `docs/users/adr/0001-tenancy-model.md`                 | all                       | `ws:<id>/` prefix, `UNIQUE(workspaceId, name)` rebuild, in-memory state rule      |
| P0       | `docs/prps/plans/yan-361-connection-ownership.plan.md` | all                       | closest precedent: nullable scope column, adoption at bootstrap, scoped repo API  |
| P0       | `src/lib/db/repos/connectionsRepo.js`                  | 437-487                   | scoped repo API shape (`listConnections(ctx, …)`, `*Unscoped`)                    |
| P0       | `src/lib/db/repos/combosRepo.js`                       | 1-164                     | file being scoped; `moveComboStrategy` to replace                                 |
| P0       | `src/sse/services/model.js`                            | 1-106                     | gateway name resolution hook                                                      |
| P0       | `src/lib/auth/gatewayResources.js`                     | 1-69                      | principal-scoped gateway reads (`getGatewayConnections/Nodes`)                    |
| P0       | `src/lib/db/tenancy.js`                                | 1-63                      | classification to update; guard test                                              |
| P0       | `src/lib/db/migrations/005-connection-ownership.js`    | all                       | additive+idempotent migration precedent                                           |
| P0       | `src/lib/db/migrations/helpers.js`                     | 27-64                     | `rebuildTable`                                                                    |
| P1       | `src/lib/db/schema.js`                                 | 92-112                    | `combos` + `kv` TABLES defs to update                                             |
| P1       | `src/lib/db/repos/ownership.js`                        | 1-54                      | `adoptOwnerlessRowsUnscoped`, `memberWorkspaceId`                                 |
| P1       | `src/lib/db/helpers/kvStore.js`                        | 1-45                      | `makeKv(scope)` → `makeKv(scope, ctx)`                                            |
| P1       | `src/lib/db/repos/workspaceSettingsRepo.js`            | 53-98                     | `updateWorkspaceComboStrategies` (name check → id check)                          |
| P1       | `src/app/api/settings/comboStrategyPatch.js`           | 1-69                      | patch validator; id/name body support                                             |
| P1       | `src/lib/auth/routePolicy.js`                          | 183-195                   | combo/model route rows to make `scoped`                                           |
| P1       | `src/lib/users/workspaceScope.js`                      | 1-93                      | `workspaceScope`/`principalScope`/`denyRow` route helpers                         |
| P1       | `src/sse/handlers/chat.js`                             | 168-180, 367-393, 445-476 | combo resolution + `isModelDisabled` call sites                                   |
| P1       | `src/lib/db/repos/settingsRepo.js`                     | 172-273                   | `updateComboStrategies`, `getEffectivePreferences`                                |
| P1       | `src/lib/users/bootstrap.js`                           | 105-140                   | where adoption runs at switch-on                                                  |
| P2       | `tests/unit/connection-ownership.test.js`              | 1-120                     | test harness pattern to mirror                                                    |
| P2       | `tests/setup/tenancyHarness.js`                        | all                       | `seedTenancy`, `callRoute`, `denied`                                              |
| P2       | `tests/unit/tenancy-guard.test.js`                     | 1-60                      | HELPER_ALLOWLIST entries to remove                                                |
| P2       | `src/lib/users/principal.js`                           | 26-66                     | capability map (`workspace.combos.manage` exists; no `workspace.models.*` yet)    |

## External Documentation

N/A — internal patterns only. No new dependencies.

---

## Patterns to Mirror

### NAMING_CONVENTION

```js
// SOURCE: src/lib/db/repos/connectionsRepo.js:145,462
export async function getProviderConnectionsUnscoped(filter = {}) { … }
export async function getConnection(ctx, id) { … }   // ctx first, or *Unscoped
```

### SCOPED_REPO (IDOR-safe lookup, membership re-verified in SQL)

```js
// SOURCE: src/lib/db/repos/connectionsRepo.js:441-465
const MEMBER_ROW = `SELECT pc.* FROM providerConnections pc JOIN memberships m ON m.workspaceId = pc.workspaceId WHERE pc.id = ? AND m.userId = ?`;
export async function getConnection(ctx, id) {
  assertCtx(ctx);
  const db = await getAdapter();
  return rowToConn(db.get(MEMBER_ROW, [id, ctx.userId]));
}
```

### MIGRATION (additive, idempotent, frozen literal DDL)

```js
// SOURCE: src/lib/db/migrations/005-connection-ownership.js:18-30
export default {
  version: 5,
  name: "connection-ownership",
  up(db) {
    … if (!tableHasColumn(db, table, col)) db.exec(`ALTER TABLE …`);
    for (const [name, sql] of Object.entries(INDEXES)) if (!indexExists(db, name)) db.exec(sql);
  },
};
```

### REBUILD (UNIQUE change needs the 12-step rebuild)

```js
// SOURCE: src/lib/db/migrations/helpers.js:34-63
rebuildTable(db, name, newDef, (copySql = null)); // copySql may rewrite columns (e.g. re-key strategies)
```

### GATEWAY_RESOURCES (principal-scoped reads; legacy storage → global)

```js
// SOURCE: src/lib/auth/gatewayResources.js:25-34,59-69
export async function requireGatewayWorkspace(principal) {
  if (principal) return { db, workspaceId: assertGatewayPrincipal(principal) };
  if (readApiKeyStorageState(db).storage !== "legacy")
    throw new Error("Hashed gateway routing requires a principal");
  return { db, workspaceId: null };
}
```

### ROUTE_SCOPING (switch off → unscoped path; on → workspace row)

```js
// SOURCE: src/app/api/providers/route.js:76-83
const scope = await workspaceScope(request, "workspace.connections.metadata.read");
if (scope instanceof Response) return scope;
const connections = scope
  ? await listConnections(scope.ctx, scope.workspaceId)
  : await getProviderConnectionsUnscoped();
```

### KV_PREFIX (reserved pattern)

```js
// SOURCE: src/lib/db/repos/cliToolSettingsRepo.js:8-10
// Keep the key bare so a scoped prefix (e.g. `ws:<id>/<toolId>`) can be added later without migration.
```

### TEST_STRUCTURE

```js
// SOURCE: tests/unit/connection-ownership.test.js:30-46
async function load(state) { vi.resetModules(); process.env[ENV] = state; db = await import("@/lib/db/index.js"); }
… t = await seedTenancy(); … expect(await denied(db.getConnection(b.ctx, c.id))).toBe(true);
```

### ERROR_HANDLING

```js
// SOURCE: src/lib/db/repos/ownership.js:44-53
if (!ok) throw new TenancyError("NOT_FOUND", "Workspace not found"); // never "forbidden" — ids don't leak
```

---

## Design Decisions

1. **ADR-0001 confirmed**: kv workspace dimension is the `ws:<workspaceId>/` **key prefix** (scope string unchanged, PK `(scope, key)` unchanged, no kv rebuild). `pricing` and `gemini_thought_signatures` stay instance/system. `mitmAlias` is host tooling (`/api/cli-tools/antigravity-mitm/alias`, `localOnly`) — **reclassify to instance** in `tenancy.js` (it is `pending-scope` YAN-364 today).
2. **Migration 009 is additive and unconditional** — follows 005–008 precedent: none gate on the switch. Rebuild `combos` to `workspaceId TEXT REFERENCES workspaces(id) ON DELETE CASCADE` (nullable, like 005), `createdByUserId TEXT`, drop `name TEXT UNIQUE NOT NULL`, add table-level `UNIQUE (workspaceId, name)`, index `idx_combo_ws (workspaceId)`, **plus partial index `idx_combo_name_legacy ON combos(name) WHERE workspaceId IS NULL`** — pre-bootstrap rows keep DB-level global name uniqueness (NULLs are distinct in table-level UNIQUE, so this partial index closes the legacy hole; SQLite enforces it only for NULL-workspaceId rows). **No backfill in the migration**: Default exists only after the YAN-356 bootstrap (YAN-361 precedent).
3. **Adoption lives inside `adoptOwnerlessRowsUnscoped`** (`src/lib/db/repos/ownership.js`): `OWNED += ["combos"]` plus two new steps called from that same function — `adoptKvScopesUnscoped(db)` and `seedDefaultComboStrategiesUnscoped(db)`. Every existing call site (`bootstrap.js runBootstrap` fresh + re-adoption branches, `usersRepo.js bootstrapOwnerUnscoped:326`, `importDb:574`) then adopts combos, kv keys and strategies with **zero new call sites**; `bootstrap.js`/`usersRepo.js` are not edited. kv adoption is collision-safe: per scope, `INSERT OR IGNORE INTO kv(scope,key,value) SELECT scope, 'ws:'||?||'/'||key, value FROM kv WHERE scope=? AND substr(key,1,4) <> 'ws:'` (prefixed value wins on collision; bare source dropped after), then `DELETE FROM kv WHERE scope=? AND substr(key,1,4) <> 'ws:'`. **Legacy keys already starting `ws:` are treated as already-scoped and left untouched**; scoped route/repo writes reject user keys starting with `ws:` (400), so this namespace is reserved. Strategy seed converts the blob's name-keyed `comboStrategies` into the Default workspace row keyed by **combo id** (lookup `WHERE name = ? AND workspaceId IS ?` Default; already-converted ids are never overwritten — idempotent).
4. **Strategy lookup uses one helper, never translation**: `comboStrategyKey(principal, combo)` (`src/lib/comboKeys.js`, Task 2.2) returns the combo **id** when a gateway/management principal exists, else the **name**. Every `resolveComboStrategy` caller threads it (`chat.js` 3 sites, `tts.js`, `imageGeneration.js`, `search.js`, `fetch.js`, `comboProbe.js` with its management principal). **Leak fix (rev2): with the switch ON and a workspace resolved, `getEffectivePreferences` stamps the merged result with a non-enumerable `Symbol.for("tokenhop.comboStrategiesById")` marker and forces `comboStrategies` to the workspace's own id-keyed map or `{}` — `comboStrategyFor` then looks up by id ONLY, so workspace B never inherits Default's/A's same-name blob strategy; with the switch OFF (or no principal) no marker is set and the legacy name-keyed lookup is byte-identical.** `getEffectivePreferences` is changed minimally and only for that scoped branch (see the leak fix above); with the switch off its result is untouched — workspace rows deliver id-keyed maps as-is, the instance blob stays name-keyed. Schedulers (`weightedTargets`) have no principal: they resolve `combo.id` first, then `combo.name` (workspace prefs are id-keyed, instance prefs name-keyed; whole-instance by design, no isolation risk). `moveComboStrategy`/the rename cascade stays **only** in `updateComboUnscoped` (name-keyed blob/legacy path) and must never rewrite id-keyed workspace rows by name. Id keys make renames strategy-preserving: scoped `updateCombo` needs no rewrite; scoped `deleteCombo` removes the id entry from that workspace's row in the same transaction.
5. **Name resolution in workspace W**: W's combos → W's aliases → built-in provider models/registry. No cross-workspace fallback. Hook: extend `src/lib/auth/gatewayResources.js` with `getGatewayCombos(principal)`, `getGatewayAliases(principal)`, `getGatewayCustomModels(principal)`, `getGatewayDisabled(principal)` (same shape as `getGatewayConnections/Nodes`; legacy storage → `workspaceId: null` → global reads). `src/sse/services/model.js` gains principal-aware `getComboByName(modelStr, { principal })`, `resolveModelAlias(alias, { principal })`, `getComboModels(modelStr, { principal })`; `getModelInfo` already takes `{ principal }` (line 46) — its combo/alias branches switch to the scoped lookups. YAN-368 keeps full routing later; this is the minimal correct hook already used by nodes.
6. **Rotation state re-key via one helper** (ADR-0001 consequence): `comboRotationKey(workspaceId, name)` (`src/lib/comboKeys.js`) — `${workspaceId}:${name}` when a workspaceId exists, else the plain name (legacy keys byte-identical). Every rotation call site (`chat.js` outer + nested, `tts.js`, `imageGeneration.js`, `search.js`, `fetch.js` `comboName` args) passes `comboRotationKey(gateway?.workspaceId, name)`; every `resetComboRotation(key)` caller (`combos/[id]/route.js` PUT/DELETE — workspaceId from the loaded row when scoped, null legacy) uses the same helper. Bare `resetComboRotation()` (clear-all in `settingsSideEffects.js`, config import) is unchanged. Engine internals (`open-sse/services/combo.js` maps) just key on the string — open-sse stays untouched.
7. **Capabilities stay as-is (ADR-0002 fixed list)**: `workspace.combos.manage` already covers "combos, aliases, custom models, disabled models" (ADR-0002 capability list). The matrix grants it to owner/admin (`x*`, member workspaces) and ws-owner/ws-manager only — **members and viewers get no combos/model access** ("viewer: `workspace.budgets.read` + `workspace.usage.read` … cannot read metadata beyond usage"). So: combos/models **GETs keep today's `workspace.connections.metadata.read`** (admin oversight any-workspace + manager in-workspace), **writes keep `workspace.combos.manage`**; rows only gain `scoped: true`. No `workspace.combos.read`/`workspace.models.manage` are added — that would amend the fixed ADR-0002 list (flagged for the reviewer; if wanted, it is a `principal.js` + `routePolicy.js`-only change — see Notes).
8. **Schedulers stay unscoped**: `quotaSnapshotPoller`, `weightedTargets`, `customModelCaps`, `src/lib/home/summary.js`, `src/lib/db/configExport.js`, `exportDb`/`importDb` read the renamed `*Unscoped` repo functions (whole-instance views are their job; per-workspace scheduling is YAN-368/370). `comboProbe` is the exception: it is request-driven, so it consumes the **authorized scoped combo** (3.1). `src/lib/db/index.js` keeps re-exporting everything.
9. **Routes go scoped behind the existing helpers**: `workspaceScope(request, cap)` (collection routes) and `loadScoped(cap, id, getScoped, getUnscoped, notFound)` (item routes) — identical to YAN-361. Switch off or ≤1 active user → `scope === null` → today's unscoped path, byte-identical.
10. **`/api/combos/reorder`**: `reorderCombos` becomes `reorderCombos(ctx, workspaceId, ids)` (scoped rank partition) + `reorderCombosUnscoped(ids)`; route row gets `cap: COMBOS` (write) — it is currently `META`-only, tighten as part of the row update.
11. **Scoped reads never fall back to unscoped readers.** With a principal, a miss (or error) in the scoped read means "not in this workspace" — resolution falls through to built-ins only, never to global kv/combos. `isModelDisabled` keeps today's failure semantics: a **read error** returns `false` (fail-open, traffic not blocked) — but it reads the workspace's disabled map, never the global one. `getGateway*` readers propagate storage errors like `getGatewayConnections` does (no widening).
12. **importDb wipe covers all keys in the three scopes regardless of prefix**: the existing `DELETE FROM kv WHERE scope IN (...)` is scope-level (prefix lives in the key), so it already wipes `ws:`-prefixed rows — **`disabledModels` is added to the IN-list** (it was never wiped; spec finding 8). The `exportDb` gap for `disabledModels` stays as-is (pre-existing patch issue; YAN-375 covers the format). Post-wipe inserts are bare, then adoption (inside `adoptOwnerlessRowsUnscoped`, same transaction) re-prefixes them into Default. Duplicate combo names inside one payload fail the adoption's `UNIQUE(workspaceId,name)` → the whole import transaction rolls back cleanly (no partial state).
13. **B1 review — hashed-path config import adopts too** (`src/lib/db/helpers/gatewayKeyTransfer.js`): `applyGatewayKeySnapshot` wipes `combos` + kv and reinserts legacy snapshot rows with **NULL** `workspaceId` and bare keys (lines 871, 1007-1017), and unlike `importDb`'s legacy branch it never calls adoption — on a hashed (multi-user) instance those rows would stay ownerless until the next bootstrap. Fix (Task 2.2): call `adoptOwnerlessRowsUnscoped(db)` inside the apply transaction, after the row inserts and before its `PRAGMA foreign_key_check` — same transaction, same semantics, no new surface (the function's signature/body is what 2.1 extends; no ordering constraint between the two B2 tasks). Also add `disabledModels` to the helper's local `KV_SCOPES` wipe list (line 27), mirroring decision 12.

## Files to Change

Owner column = the single task that edits the file (non-overlapping within a batch; a file appears in at most one task).

| File                                                   | Action | Owner                                                                                                                | Justification                                                                               |
| ------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/lib/db/migrations/009-workspace-scoped-combos.js` | CREATE | 1.1                                                                                                                  | combos rebuild (UNIQUE(ws,name), scope cols, idx + legacy partial unique)                   |
| `src/lib/db/migrations/index.js`                       | UPDATE | 1.1                                                                                                                  | register m009                                                                               |
| `src/lib/db/schema.js`                                 | UPDATE | 1.1                                                                                                                  | TABLES.combos new shape + `idx_combo_name_legacy`                                           |
| `src/lib/db/tenancy.js`                                | UPDATE | 1.1                                                                                                                  | combos → scoped; 3 kv scopes → scoped; mitmAlias → instance                                 |
| `tests/unit/db-tenancy-schema.test.js`                 | UPDATE | 1.1                                                                                                                  | schema-shape assertions for the rebuilt `combos` (fixer-owned in B1; 4.1 does not touch it) |
| `src/lib/db/helpers/kvStore.js`                        | UPDATE | 2.1                                                                                                                  | `makeKv(scope, ctx)` ws-prefix (no LIKE)                                                    |
| `src/lib/db/repos/ownership.js`                        | UPDATE | 2.1                                                                                                                  | OWNED += combos; internal kv adoption + strategy seed inside `adoptOwnerlessRowsUnscoped`   |
| `src/lib/comboKeys.js`                                 | CREATE | 2.2                                                                                                                  | `comboStrategyKey`, `comboRotationKey`                                                      |
| `src/lib/db/repos/combosRepo.js`                       | UPDATE | 2.2                                                                                                                  | scoped + Unscoped APIs; Unscoped create stamps Default; rename cascade name-blob only       |
| `src/lib/db/helpers/gatewayKeyTransfer.js`             | UPDATE | 2.2                                                                                                                  | apply adopts combos/kv in-tx (decision 13); `KV_SCOPES` += `disabledModels`                 |
| `src/lib/db/repos/aliasRepo.js`                        | UPDATE | 2.2                                                                                                                  | scoped + Unscoped APIs (mitmAlias untouched)                                                |
| `src/lib/db/repos/disabledModelsRepo.js`               | UPDATE | 2.2                                                                                                                  | scoped + Unscoped APIs                                                                      |
| `src/lib/db/index.js`                                  | UPDATE | 2.2                                                                                                                  | re-exports; importDb wipe adds `disabledModels`                                             |
| `src/lib/localDb.js`                                   | UPDATE | 2.2                                                                                                                  | shim exports (old names aliased to Unscoped)                                                |
| `src/models/index.js`                                  | UPDATE | 2.2                                                                                                                  | shim exports                                                                                |
| `src/lib/disabledModelsDb.js`                          | UPDATE | 2.2                                                                                                                  | shim exports                                                                                |
| `src/shared/services/quotaSnapshotPoller.js`           | UPDATE | 2.2                                                                                                                  | renamed Unscoped fns                                                                        |
| `src/shared/services/weightedTargets.js`               | UPDATE | 2.2                                                                                                                  | renamed Unscoped fns; strategy lookup id then name                                          |
| `src/lib/customModelCaps.js`                           | UPDATE | 2.2                                                                                                                  | `getCustomModels` → Unscoped                                                                |
| `src/lib/db/configExport.js`                           | UPDATE | 2.2                                                                                                                  | `getCombos` → Unscoped (direct `combosRepo` import)                                         |
| `src/app/api/shell/summary/route.js`                   | UPDATE | 2.2                                                                                                                  | `getCombos` → Unscoped                                                                      |
| `src/lib/auth/routePolicy.js`                          | UPDATE | 2.3                                                                                                                  | combos/models rows → `scoped: true` (existing caps)                                         |
| `src/lib/db/repos/workspaceSettingsRepo.js`            | UPDATE | 2.4                                                                                                                  | `updateWorkspaceComboStrategies` require-id; full-map replace helper for mirror             |
| `src/lib/db/repos/settingsRepo.js`                     | UPDATE | 2.4                                                                                                                  | `mirrorToDefaultWorkspace` name→id (replace semantics)                                      |
| `src/app/api/settings/comboStrategyPatch.js`           | UPDATE | 2.4                                                                                                                  | accept `{ id }` or `{ name }`                                                               |
| `src/app/api/workspaces/[id]/settings/route.js`        | UPDATE | 2.4                                                                                                                  | resolve name→id for patch                                                                   |
| `src/lib/auth/gatewayResources.js`                     | UPDATE | 2.5                                                                                                                  | `getGatewayCombos/Aliases/CustomModels/Disabled`                                            |
| `src/sse/services/model.js`                            | UPDATE | 2.5                                                                                                                  | principal-aware combo/alias lookups                                                         |
| `src/app/api/combos/route.js`                          | UPDATE | 3.1                                                                                                                  | workspaceScope + scoped repo calls                                                          |
| `src/app/api/combos/[id]/route.js`                     | UPDATE | 3.1                                                                                                                  | loadScoped + scoped repo calls + `comboRotationKey`                                         |
| `src/app/api/combos/reorder/route.js`                  | UPDATE | 3.1                                                                                                                  | scoped reorder                                                                              |
| `src/app/api/combos/[id]/test/route.js`                | UPDATE | 3.1                                                                                                                  | loadScoped (IDOR) + pass authorized combo to probe                                          |
| `src/app/api/combos/[id]/headroom/route.js`            | UPDATE | 3.1                                                                                                                  | loadScoped (IDOR)                                                                           |
| `src/sse/services/comboProbe.js`                       | UPDATE | 3.1                                                                                                                  | consume authorized/scoped combo; `comboStrategyKey`                                         |
| `src/app/api/models/route.js`                          | UPDATE | 3.2                                                                                                                  | scoped alias/custom/disabled reads                                                          |
| `src/app/api/models/alias/route.js`                    | UPDATE | 3.2                                                                                                                  | scoped                                                                                      |
| `src/app/api/models/custom/route.js`                   | UPDATE | 3.2                                                                                                                  | scoped                                                                                      |
| `src/app/api/models/disabled/route.js`                 | UPDATE | 3.2                                                                                                                  | scoped                                                                                      |
| `src/sse/handlers/chat.js`                             | UPDATE | 3.3                                                                                                                  | scoped lookups, `comboStrategyKey`, `comboRotationKey`, `isModelDisabled`                   |
| `src/sse/handlers/tts.js`                              | UPDATE | 3.3                                                                                                                  | same (also direct `combosRepo` import)                                                      |
| `src/sse/handlers/imageGeneration.js`                  | UPDATE | 3.3                                                                                                                  | same (also direct `combosRepo` import)                                                      |
| `src/sse/handlers/search.js`                           | UPDATE | 3.3                                                                                                                  | gateway-scoped combos, keys                                                                 |
| `src/sse/handlers/fetch.js`                            | UPDATE | 3.3                                                                                                                  | gateway-scoped combos, keys                                                                 |
| `src/app/api/v1/models/route.js`                       | UPDATE | 3.3                                                                                                                  | `buildModelsList` reads scoped via principal                                                |
| `tests/unit/tenancy-guard.test.js`                     | UPDATE | 1.1 (classification expectations, already edited) then 4.1 (allowlist cleanup, sequential batches B1→B4, no overlap) | classification + drop combosRepo allowlist entries                                          |
| `tests/unit/scoped-combos.test.js`                     | CREATE | 4.1                                                                                                                  | migration, adoption, IDOR, strategies, import/export                                        |
| `tests/unit/gateway-scoped-resolution.test.js`         | CREATE | 4.1                                                                                                                  | same-name routing, `/v1/models`, rotation, fail behaviour                                   |

Not edited (by design): `src/lib/users/bootstrap.js`, `src/lib/db/repos/usersRepo.js` — adoption runs inside `adoptOwnerlessRowsUnscoped`, which both already call.

## NOT Building

- NOT NULL rebuild of `combos.workspaceId` (deferred to the switch flip, YAN-380 — same as YAN-361).
- No `allowedCombos`/grant resolution changes (YAN-368 principal-aware routing).
- No usage/attribution scoping (YAN-370), no budgets (YAN-372).
- No per-workspace schedulers (quota poller, weighted targets stay whole-instance; YAN-368/370).
- No UI changes — the dashboard already selects a workspace via the scoped routes' `?workspaceId=` selector; single-user UI is pixel-identical.
- No export/import format change beyond re-prefixing imported kv/combos rows into Default (full user-aware export is YAN-375).
- No changes to `mitmAlias` repo functions or routes (stays instance).
- No open-sse engine changes beyond the rotation-key prefix threaded from `src/sse` (open-sse stays DB-free).

---

## Step-by-Step Tasks

### Task 1.1: Migration 009 + schema + tenancy classification — Depends on [none]

- **BATCH**: B1
- **ACTION**: Create migration 009 rebuilding `combos`; register it; update `TABLES.combos`; reclassify tables/kv scopes in `tenancy.js`.
- **IMPLEMENT**: `src/lib/db/migrations/009-workspace-scoped-combos.js`: idempotency guard `if (tableHasColumn(db, "combos", "workspaceId")) return;` then `rebuildTable(db, "combos", NEW_DEF)` where NEW_DEF columns = `id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT, models TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, sortOrder INTEGER, workspaceId TEXT REFERENCES workspaces(id) ON DELETE CASCADE, createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL`, constraints `["UNIQUE (workspaceId, name)"]`, indexes `["CREATE INDEX IF NOT EXISTS idx_combo_ws ON combos(workspaceId)", "CREATE UNIQUE INDEX IF NOT EXISTS idx_combo_name_legacy ON combos(name) WHERE workspaceId IS NULL"]` (old `idx_combo_name` is dropped with the rebuild; the partial unique index keeps **pre-bootstrap/legacy rows globally name-unique at DB level**, closing the NULL-NULL hole). Register in `migrations/index.js` (import + MIGRATIONS list). `schema.js`: replace `TABLES.combos` with the same shape (both indexes) + comment `// YAN-364 (migration 009): UNIQUE(workspaceId,name); NULL workspaceId rows stay globally name-unique until bootstrap adopts them into Default`. `tenancy.js`: `combos: { class: "scoped", scopeColumn: "workspaceId", note: "NULL until owner bootstrap (YAN-364)" }`; kv: `modelAliases/customModels/disabledModels: { class: "scoped", scopeColumn: "key", note: "ws:<workspaceId>/ key prefix" }`; `mitmAlias: { class: "instance", note: "host MITM tooling (cli-tools routes)" }`.
- **MIRROR**: `005-connection-ownership.js` (idempotency), `helpers.js rebuildTable`, schema.js `providerConnections` shape.
- **IMPORTS**: migration imports `rebuildTable, tableHasColumn` from `./helpers.js`.
- **GOTCHA**: The drift-guard test (`db-migration-chain.test.js`) compares chain output to `TABLES` — both must change together (the partial index must be in both). `rebuildTable` runs with FKs off; `PRAGMA foreign_key_check` must pass. Do NOT backfill (no Default yet). Once rows carry a workspaceId (post-adoption), same names in different workspaces are allowed — that is the point; only NULL-workspaceId rows are globally unique.
- **VALIDATE**: `cd tests && npx vitest run unit/db-migration-chain.test.js unit/tenancy-guard.test.js` — chain produces exactly TABLES; classification complete.

### Task 2.1: kv prefix + ownership adoption — Depends on [1.1]

- **BATCH**: B2
- **ACTION**: `makeKv(scope, ctx)` with `substr`-based prefixing; fold combos + kv + strategy-seed adoption into `adoptOwnerlessRowsUnscoped` itself.
- **IMPLEMENT**: `kvStore.js`: `export function makeKv(scope, ctx = null)` — the prefix is `ws:<workspaceId>/` when `ctx?.workspaceId` exists, else empty; every method prefixes `key` (get/set/remove/setMany); `getAll()` selects with `WHERE scope = ? AND substr(key, 1, ?) = ?` (prefix length, prefix) — **never `LIKE`** (alias keys may contain `%`/`_`) — and **strips the prefix** from returned keys. `ownership.js`: `OWNED += "combos"`. Add **non-exported** helpers called from `adoptOwnerlessRowsUnscoped(db)` after the table adoption: (a) `adoptKvScopes(db)` — for each of `["modelAliases", "customModels", "disabledModels"]`, when Default exists: `INSERT OR IGNORE INTO kv(scope, key, value) SELECT scope, 'ws:' || ? || '/' || key, value FROM kv WHERE scope = ? AND substr(key, 1, 4) <> 'ws:'` (existing prefixed row **wins** on collision), then `DELETE FROM kv WHERE scope = ? AND substr(key, 1, 4) <> 'ws:'`; return total prefixed count; keys already starting `ws:` are treated as already-scoped and left alone; (b) `seedComboStrategies(db)` — read blob `comboStrategies`; for each **name** key, `SELECT id FROM combos WHERE name = ? AND workspaceId IS ?` (Default), merge `{ [id]: entry }` into the Default `workspaceSettings` row; already-present ids are never overwritten (INSERT-only semantics; idempotent reruns). Both are called inside `adoptOwnerlessRowsUnscoped(db)` (and therefore run at bootstrap in `bootstrap.js` both branches, inside `usersRepo.js bootstrapOwnerUnscoped:326`, and in `importDb:574` — **no new call sites**, none of those files edited). Keep the non-exported helpers local so the tenancy-guard lint surface is unchanged (guarded caller is `*Unscoped`).
- **MIRROR**: `ownership.js adoptOwnerlessRowsUnscoped` (idempotent adoption, return count), `workspaceSettingsRepo.js seedDefaultWorkspaceSettingsUnscoped` (INSERT-only seeding).
- **IMPORTS**: `parseJson/stringifyJson` from `../helpers/jsonCol.js`.
- **GOTCHA**: `makeKv` ctx is a **workspace carrier** (`{ workspaceId }`), not a full Principal — gateway principals also fit; no `assertCtx` inside `makeKv` (repos do that). Legacy callers pass nothing → bare keys, byte-identical. The collision rule is deterministic: **prefixed value wins, bare value is dropped** (log the count via `backfill()`); a bare key written after first adoption gets adopted on the next bootstrap re-run (test in 4.1).
- **VALIDATE**: `npx vitest run unit/connection-ownership.test.js` (adoption still passes) + node smoke of `makeKv` prefix round-trip incl. a key containing `%`.

### Task 2.2: Scoped repos + lookup helpers + legacy call sites — Depends on [1.1]

- **BATCH**: B2
- **ACTION**: Split `combosRepo.js`, `aliasRepo.js`, `disabledModelsRepo.js` into ctx-first scoped APIs + renamed `*Unscoped` legacy APIs; add `src/lib/comboKeys.js`; repoint every legacy call site this task owns.
- **IMPLEMENT**: **New `src/lib/comboKeys.js`** (pure, no imports): `comboStrategyKey(principal, combo)` → `principal ? combo.id : combo.name`; `comboRotationKey(workspaceId, name)` → `workspaceId:name` when set, else `name`. **combosRepo**: keep `rowToCombo`/`ORDER_BY`. Unscoped (renamed, byte-identical bodies): `getCombosUnscoped, getComboByIdUnscoped, getComboByNameUnscoped, updateComboUnscoped, deleteComboUnscoped, reorderCombosUnscoped`; **`createComboUnscoped` additionally stamps `workspaceId: defaultWorkspaceIdUnscoped(db)` when it exists** (mirrors `createProviderConnectionUnscoped` at connectionsRepo.js:219-224) — legacy create stays globally name-unique pre-bootstrap via `idx_combo_name_legacy`, per-workspace after. Scoped: `listCombos(ctx, workspaceId)`, `getCombo(ctx, id)` (membership-join lookup), `getComboByNameScoped(ctx, workspaceId, name)`, `createCombo(ctx, workspaceId, data)` (stamps workspaceId + createdByUserId; sortOrder `MAX(...) WHERE workspaceId IS ?`), `updateCombo(ctx, id, data)` (id-keyed strategies survive renames — no rewrite), `deleteCombo(ctx, id)` (same tx: `DELETE` row + remove the **id** entry from that workspace's `workspaceSettings.comboStrategies`; no global cascade), `reorderCombos(ctx, workspaceId, ids)`. `moveComboStrategy` stays **only** under `updateComboUnscoped`/`deleteComboUnscoped` (name-keyed blob/legacy path) and never rewrites id-keyed workspace rows by name. **aliasRepo**: `aliasKv`/`customKv` built per call via `makeKv(scope, ctx)`; scoped `getModelAliases/setModelAlias/deleteModelAlias/getCustomModels/addCustomModel/deleteCustomModel(ctx, workspaceId, …)` (membership re-verified via `memberWorkspaceId`; `addCustomModel`'s raw SQL uses the prefixed key, keeps its transaction); Unscoped twins (ctx = null); reject scoped writes whose user key starts with `ws:` (400 at route, defensive throw at repo). mitmAlias fns untouched (instance). **disabledModelsRepo**: same split with prefixed keys. **Legacy call sites (this task owns)**: `src/lib/db/index.js` re-exports per naming contract and `importDb`'s wipe IN-list gains `'disabledModels'` (scope-level DELETE — already prefix-agnostic); `src/lib/localDb.js`, `src/models/index.js`, `src/lib/disabledModelsDb.js` shims export new names and alias **old** names to the `*Unscoped` twins; `src/shared/services/quotaSnapshotPoller.js`, `src/lib/customModelCaps.js`, `src/lib/db/configExport.js` (direct `combosRepo` import), `src/app/api/shell/summary/route.js` switch to `*Unscoped`; `src/shared/services/weightedTargets.js` switches imports **and** resolves strategies by `combo.id` first then `combo.name` (workspace prefs are id-keyed; instance prefs name-keyed; whole-instance scheduler, decision 4). `src/lib/db/helpers/gatewayKeyTransfer.js` (same task, no shared files with the above): add `adoptOwnerlessRowsUnscoped(db)` inside the `applyGatewayKeySnapshot` transaction after the row inserts, before its `PRAGMA foreign_key_check` — legacy combos/kv from the snapshot land in Default in-transaction (decision 13); add `disabledModels` to its local `KV_SCOPES` wipe list.
- **MIRROR**: `connectionsRepo.js:437-487` scoped API; `memberWorkspaceId`.
- **IMPORTS**: `assertCtx` from `@/lib/users/errors.js`, `memberWorkspaceId, defaultWorkspaceIdUnscoped` from `./ownership.js`.
- **GOTCHA**: tenancy-guard lint: every exported fn touching `combos` or scoped kv takes `ctx` first or ends `Unscoped`. Do NOT keep old unsuffixed names for scoped-table functions inside `repos/` (lint would flag them); shim aliases live outside `repos/` and are not scanned.
- **VALIDATE**: `npx vitest run unit/db-migration-chain.test.js` + node smoke importing `@/lib/db/index.js` exports.

### Task 2.3: Route policy — Depends on [1.1]

- **BATCH**: B2
- **ACTION**: Make combos/models route rows `scoped` with the **existing** capabilities (decision 7 — no capability-map change).
- **IMPLEMENT**: `routePolicy.js` rows become: `"/api/combos": scoped(read(META, COMBOS))`, `"/api/combos/reorder": scoped({ cap: COMBOS })`, `"/api/combos/[id]": scoped(read(META, COMBOS))`, `"/api/combos/[id]/headroom": scoped({ cap: META })`, `"/api/combos/[id]/test": scoped({ cap: USE })`, `"/api/models": scoped(read(META, COMBOS))`, `"/api/models/alias": scoped(read(META, COMBOS))`, `"/api/models/custom": scoped(read(META, COMBOS))`, `"/api/models/disabled": scoped(read(META, COMBOS))`. (`/api/models/availability`, `/api/models/test`, `/api/models/catalog-sync`, `/api/tags` unchanged; `principal.js` unchanged.)
- **MIRROR**: existing `scoped(read(META, CONN))` rows (providers).
- **GOTCHA**: `/api/combos/[id]/test` handler additionally re-checks `workspace.combos.manage`/`USE` per row workspace (3.1) — the row's `USE` cap is the gate, the handler does the row-level check like every other scoped item route.
- **VALIDATE**: `npx vitest run unit/route-policy.test.js unit/capabilities.test.js`.

### Task 2.4: Strategy keying (settings repos + patch) — Depends on [1.1]

- **BATCH**: B2
- **ACTION**: Workspace `comboStrategies` keyed by combo id; patch API accepts id or name; mirror converts name→id with explicit lossy semantics.
- **IMPLEMENT**: `workspaceSettingsRepo.js updateWorkspaceComboStrategies`: replace the `requireComboName` existence check with `requireComboId` — a lookup `SELECT id FROM combos WHERE id = ? AND workspaceId = ?` with the combo id and the verified workspace id; add a small `replaceWorkspaceComboStrategiesUnscoped(db, workspaceId, nextStrategies)` full-map writer **for the mirror only** (the mirror's conversion re-keys the whole map — per-key merging can't express name→id renames). `settingsRepo.js mirrorToDefaultWorkspace`: when the picked patch contains `comboStrategies`, convert every name key to the combo id in Default (`SELECT id FROM combos WHERE name = ? AND workspaceId IS ?`) and write the **converted full map** via the new writer; **explicitly lossy**: an entry whose name no longer resolves to a combo in Default is dropped from the mirrored row while the blob keeps it (mirrors today's per-entry behaviour for renamed/deleted combos; decision 4). `comboStrategyPatch.js`: accept `body.comboStrategyPatch = { id }` **or** `{ name }` (validate the present one with the same regex/blocked set; pass the resolved key to the update callback; weight-count cap still validated on the merged entry inside the transaction). `src/app/api/workspaces/[id]/settings/route.js`: when the patch carries `name`, resolve to the combo id inside that workspace (`getComboByNameScoped(ctx, wsId, name)` → 409 when absent) and call `updateWorkspaceComboStrategies(ctx, wsId, transform, id)`. Instance `/api/settings` path: unchanged (name-keyed blob).
- **MIRROR**: `updateWorkspaceComboStrategies` current shape (transactional transform, COMBO_NOT_FOUND).
- **GOTCHA**: `updateComboStrategies` (instance blob) must stay name-keyed and byte-identical — only the mirror changes. The workspace row holds ids only; the blob holds names only; never rewrite one namespace with the other's keys.
- **VALIDATE**: `npx vitest run unit/combo-strategy-atomic.test.js unit/settings-split.test.js`.

### Task 2.5: Gateway resources + model resolution — Depends on [1.1]

- **BATCH**: B2
- **ACTION**: Principal-scoped gateway readers for combos/aliases/custom/disabled; wire `src/sse/services/model.js`.
- **IMPLEMENT**: `gatewayResources.js`: `getGatewayCombos(principal)` (workspaceId → `SELECT * FROM combos WHERE workspaceId = ?` ordered as repo; null → `getCombosUnscoped()`), `getGatewayAliases(principal)`, `getGatewayCustomModels(principal)`, `getGatewayDisabled(principal)` — scoped reads go through `makeKv(scope, { workspaceId })` (substr prefix, 2.1) or an equivalent `substr` query; null → the `*Unscoped` repo getters; same return shapes as the repos (alias map, model array, disabled map). `src/sse/services/model.js`: `resolveModelAlias(alias, options = {})` — principal → `getGatewayAliases`, else `getModelAliasesUnscoped()`; `getComboByName(modelStr, options = {})` — principal → `getGatewayCombos` find by name, else `getComboByNameUnscoped`; `getComboModels(modelStr, options = {})` — same, `combo.models`; `getModelInfo` combo branch (line 79) and alias branch (line 87-90) use the scoped variants with `options.principal`.
- **MIRROR**: `gatewayResources.js getGatewayConnections/Nodes`; `requireGatewayWorkspace`.
- **GOTCHA**: No cross-workspace fallback: a principal-scoped miss must NOT fall back to global reads — fall through to built-ins only (`getModelInfoCore` alias/builtin/infer path). Keep `BUILTIN_MODEL_ALIASES` and registry handling untouched.
- **VALIDATE**: `npx vitest run unit/alias-baseline` equivalents: `node tests/__baseline__/verify-alias.mjs` still passes (registry aliases untouched) + `npx vitest run unit/gateway-key-routing.test.js`.

### Task 3.1: Scoped combos routes — Depends on [2.1, 2.2, 2.3, 2.4, 2.5]

- **BATCH**: B3
- **ACTION**: `api/combos/*` routes resolve workspace scope and call scoped repos.
- **IMPLEMENT**: `combos/route.js`: `const scope = await workspaceScope(request, caps)` — GET with `"workspace.connections.metadata.read"`, POST with `"workspace.combos.manage"`; scoped → `listCombos/createCombo/getComboByNameScoped` (name-dup check within the workspace; `findComboCycle(name, models, await listCombos(scope.ctx, scope.workspaceId))`); unscoped → today's fns. `[id]/route.js`: `loadScoped(cap, id, getScoped, getUnscoped, "Combo not found")` (cap = metadata.read for GET, combos.manage for PUT/DELETE) — 404 another workspace's combo, 403 member-without-role; update/delete via `updateCombo/deleteCombo(scope?.ctx ?? scopeCtx, …)`; `resetComboRotation(comboRotationKey(scope?.workspaceId ?? null, name))` on rename + delete (imports from `@/lib/comboKeys.js`). `reorder/route.js`: `workspaceScope(request, "workspace.combos.manage")` → `reorderCombos(scope.ctx, scope.workspaceId, ids)` else `reorderCombosUnscoped(ids)`. **`[id]/test/route.js`**: `loadScoped("workspace.connections.use", id, getCombo, getComboByIdUnscoped, "Combo not found")`, then capability check on `row.workspaceId`, rate-limit key **per (workspaceId, comboId)**, and call `runComboProbe` with the **authorized combo + scoped context** (never a raw id the caller could swap); `runComboProbe` (comboProbe.js) resolves `strategy` via `comboStrategyKey(management, combo)` — callers pass the already-loaded combo, no raw-id lookup. **`[id]/headroom/route.js`**: same `loadScoped` IDOR shape (metadata.read). All guarded behind existing `requireMultiUser`-style switch behaviour via `workspaceScope`/`principalScope` returning `null` → unscoped path byte-identical.
- **MIRROR**: `src/app/api/providers/route.js:76-83`, `workspaceScope.js loadScoped/denyRow`.
- **GOTCHA**: Switch off or single active user → `scope === null` → unscoped path — keep the exact current code path for that branch. The probe's per-combo rate-limit map today keys by combo id; per-workspace ids never collide (UUIDs) — add the workspace into the key struct anyway so a future id reuse can't cross.
- **VALIDATE**: `npx vitest run unit/route-policy.test.js` + manual smoke via harness in 4.1 tests.

### Task 3.2: Scoped models routes — Depends on [2.1, 2.2, 2.3, 2.4, 2.5]

- **BATCH**: B3
- **ACTION**: `api/models/*` (list, alias, custom, disabled) routes scoped.
- **IMPLEMENT**: Each route: `const scope = await workspaceScope(request, cap)` — GET with `"workspace.connections.metadata.read"`, writes (PUT/POST/DELETE) with `"workspace.combos.manage"`; scoped → `getModelAliases(scope.ctx, scope.workspaceId)` etc.; unscoped → `*Unscoped`. `api/models/route.js` GET composes scoped aliases + custom + disabled the same way it does today (same response shape). PUT alias: dup-check inside the workspace map only; scoped writes reject keys starting `ws:` (400).
- **MIRROR**: Task 3.1 + `workspaceScope`.
- **GOTCHA**: `syncPoller()` side-effects (`quotaSnapshotPoller`, `refreshCustomModelCaps`) stay as-is (whole-instance).
- **VALIDATE**: covered by 4.1 route tests; `npm run lint` clean.

### Task 3.3: Gateway handlers + /v1/models — Depends on [2.1, 2.2, 2.3, 2.4, 2.5]

- **BATCH**: B3
- **ACTION**: Thread the gateway principal through combo/alias/disabled resolution in chat + media handlers and `buildModelsList`.
- **IMPLEMENT**: Imports `comboStrategyKey, comboRotationKey` from `@/lib/comboKeys.js`. `chat.js`: `getComboModels(modelStr, { principal: gateway })` (lines 169, 368, 476), `getComboByName(modelStr, { principal: gateway })` (172, 371, 479), `resolveComboStrategy(settings, comboStrategyKey(gateway, { id: (await getComboByName(modelStr, { principal: gateway }))?.id ?? null, name: modelStr }))` (183, 374, 495) — the id comes from the already-loaded authorized combo; when authorizing a nested candidate at 371–372, `combo.id` is in hand. Reorder combo kwargs: thread the charged `comboName` for rotation as `comboRotationKey(gateway?.workspaceId ?? null, modelStr)` at every `handleComboChat`/`handleFusionChat` call (outer 252/219, nested 570/537, adapter loops 311) — same `comboName` string today drives `comboName` (logging, fallback ring, `onFallback`) **and** the rotation maps; change only what open-sse reads: since `combo.js` keys rotation on the passed `comboName`, pass the **prefixed** name and log/record under the same string (single-use-only probes are unaffected; logging shows the key — acceptable, matches decision 6). `isModelDisabled(provider, model, principal)` — scoped disabled map via `getGatewayDisabled(principal)` when principal else `getDisabledModelsUnscoped()`; **read error → `false` (today's fail-open, unchanged)**; never consult the global map when a principal exists. `tts.js`/`imageGeneration.js`: same three changes (queries use their local `gateway` var; direct `combosRepo` imports switch to the `(…)Scoped`-with-principal fns via `src/sse/services/model.js`). `search.js`/`fetch.js`: `getCombos` → principal ? `getGatewayCombos(gateway)` : `getCombosUnscoped()`; `resolveComboStrategy(settings, comboStrategyKey(gateway, { id: candidate.listed?combo.id:null, name: providerInput }))` — for web combos the combo **id** is known from the just-listed catalog entry; fall back to name only in legacy. `v1/models/route.js buildModelsList`: principal → `getGatewayCombos/CustomModels/Aliases/Disabled(principal)`; else today's unscoped reads (keep the try/catch fallbacks).
- **MIRROR**: existing `principal ? getGatewayConnections(...) : getProviderConnectionsUnscoped()` pattern in `v1/models/route.js:188-198`.
- **GOTCHA**: Legacy storage (`gateway === null`) must keep the byte-identical global path. `authorizeGatewayTarget` checks already key on combo **id** — ids are per-workspace unique after scoping, no change.
- **VALIDATE**: `npx vitest run unit/gateway-key-routing.test.js unit/api-key-hashed-ui.test.js` + 4.1 gateway tests.

### Task 4.1: Guard + tests — Depends on [3.1, 3.2, 3.3]

- **BATCH**: B4
- **ACTION**: tenancy-guard allowlist cleanup; `exportDb` duplicate-name case; critical test coverage.
- **IMPLEMENT**: Remove `combosRepo.js:updateCombo/deleteCombo` from `tenancy-guard.test.js` HELPER_ALLOWLIST (keep `settingsRepo` entries; `updateComboUnscoped` ends in `Unscoped` so it needs no entry) and update the allowlist comment. `exportDb` shape: combos rows add `workspaceId`/`createdByUserId` (kept through export; legacy consumers ignore them); the export-import roundtrip test in 4.1 asserts two same-name combos in different workspaces survive and same-workspace dups roll back. **New `tests/unit/scoped-combos.test.js`** (mirror `connection-ownership.test.js`): (a) migration fixture — run chain over `tests/fixtures/db/v1.0.0.sql` with combos seeded incl. two same-name combos, assert rebuild keeps rows, `UNIQUE(workspaceId,name)` + `idx_combo_name_legacy` present (assert the index SQL contains `WHERE workspaceId IS NULL`), rerun no-op; (b) bootstrap adoption: combos → Default, bare kv keys re-prefixed (incl. a `%`-bearing key), `ws:`-seeded keys untouched, blob strategies converted to id keys in the Default row; idempotent rerun = 0 changes; a bare key written **after** adoption is adopted on the next run; collision case: bare + prefixed same logical key → prefixed value wins; (c) createComboUnscoped stamps Default `workspaceId` when it exists (409 on dup **before** bootstrap via partial unique; 409 same-workspace after); (d) cross-workspace negatives on repos + routes incl. `[id]/test` and `[id]/headroom` (B tries A's combo id → 404; `?workspaceId=` selector to non-member → 404); same combo name in two workspaces coexists; duplicate name inside one workspace rejected (400/409); (e) strategy patch by id and by name; rename keeps strategy (id-keyed), delete drops id entry only; mirror drops unresolvable names (lossy, blob keeps); (f) import/export: legacy-path payload with same-name combos in different workspaces + three-scope kv rows round-trips; same-workspace dup payload rolls back; `disabledModels` rows are wiped+reimported; **hashed-path `applyGatewayKeySnapshot` with a legacy combos section: rows land adopted in Default (not NULL-workspaceId), kv re-prefixed, in-transaction (decision 13)**; (g) switch-off regression: unscoped CRUD byte-identical incl. strategy rename cascade and `/v1/models`. **New `tests/unit/gateway-scoped-resolution.test.js`**: same-name combos + different aliases per workspace; hashed principals → per-workspace `getModelInfo`/`getComboModels`; B's principal cannot expand A's combo (`null` → built-in fallthrough, never global); scoped kv miss never reads global; `/v1/models` scoped listing; `isModelDisabled` read-error → `false` (fail-open, scoped map only); rotation-key isolation (same-name combos rotate independently); legacy storage (`principal: null`) keeps global resolution incl. `/v1/models`.
- **MIRROR**: `tests/unit/connection-ownership.test.js`, `tests/setup/tenancyHarness.js`, `tests/unit/gateway-key-routing.test.js`.
- **GOTCHA**: Tests must run under both `TOKENHOP_MULTI_USER=off|on` (CI matrix) — use the `load(state)` resetModules pattern. Never import route handlers without the `next/headers` mock.
- **VALIDATE**: `npm test` green in both switch states.

### Task 5.1: Docs + full validation — Depends on [4.1]

- **BATCH**: B5
- **ACTION**: Update architecture notes; run the full gate.
- **IMPLEMENT**: `docs/ARCHITECTURE.md`: one-line updates — persistence section (combos/kv scoped per ADR-0001), Module Mapping (combos/aliases routes workspace-scoped). `docs/users/README.md` issue map: no edit (handbook maintained elsewhere). Verify file sizes ≤ ~500 lines on touched files.
- **MIRROR**: yan-352 plan precedent (docs touch minimal, validation commands explicit).
- **GOTCHA**: Do not run the alias baseline updater — only the verifier.
- **VALIDATE**: full gate below.

---

## Testing Strategy

### Unit Tests

| Test                              | Input                                                      | Expected Output                                                                                                                                                                | Edge Case?                                    |
| --------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| migration 009 over v1.0.0 fixture | combos + strategies + aliases                              | rows kept, new UNIQUE + legacy partial unique, idempotent rerun                                                                                                                | restore-rerun                                 |
| upgraded schema                   | post-009 DB, dup name insert                               | rejected while `workspaceId IS NULL`; allowed across workspaces; index SQL asserts the `WHERE workspaceId IS NULL` predicate and table SQL asserts `UNIQUE(workspaceId, name)` | partial index                                 |
| bootstrap adoption                | ownerless combos, bare kv keys, name-keyed blob strategies | Default ownership, `ws:` keys, id-keyed Default row; rerun = 0 changes                                                                                                         | no Default → 0                                |
| kv adoption collision             | bare `k` + existing `ws:D/k`                               | prefixed value kept, bare dropped                                                                                                                                              | `%`-bearing keys, `ws:`-legacy keys untouched |
| bare key after adoption           | unscoped writer post-bootstrap                             | adopted on next bootstrap re-run                                                                                                                                               | idempotent                                    |
| import/export                     | same-name combos in two workspaces + three-scope kv        | round-trips; same-workspace dup payload rolls back cleanly; `disabledModels` wiped                                                                                             | prefix-agnostic wipe                          |
| hashed-path config import         | `applyGatewayKeySnapshot` with legacy combos + bare kv     | rows adopted into Default in the same tx (no NULL workspaceId)                                                                                                                 | decision 13                                   |
| probe/headroom IDOR               | B's session, A's combo id                                  | 404 (loadScoped), never 403-leak                                                                                                                                               | `?workspaceId=` non-member                    |
| cross-workspace repo negatives    | B.ctx vs A's combo/alias/custom/disabled                   | NOT_FOUND/null, no rows leaked                                                                                                                                                 | IDOR by id                                    |
| same-name combos                  | `panel` in ws A and ws B                                   | both exist; dup inside A rejected                                                                                                                                              | name reuse                                    |
| strategy id-keying                | patch by id, rename, delete                                | rename keeps entry; delete drops id entry only                                                                                                                                 | legacy name cascade intact off-switch         |
| gateway resolution                | principal of W requests combo/alias name                   | W's rows only; miss → built-ins, never other workspace                                                                                                                         | service key (userId null)                     |
| `/v1/models` scoped               | principal with allowedCombos/Models                        | only W's combos + canonical allowed ids                                                                                                                                        | unrestricted key = all of W                   |
| switch-off regression             | legacy storage, no principal                               | byte-identical resolution + CRUD + `/v1/models`                                                                                                                                | pre-bootstrap NULL workspaceId                |

### Edge Cases Checklist

- [x] Empty workspace (no combos/aliases) → built-ins still resolve
- [x] Pre-bootstrap rows (workspaceId NULL) → adopted once, never re-adopted; DB-level name uniqueness held by `idx_combo_name_legacy` while NULL
- [x] Imported DB (bare kv keys + combos) → re-prefixed into Default in import tx; `disabledModels` wiped with the other two scopes; same-workspace dup names roll back whole import
- [x] kv adoption collision (bare + prefixed same logical key) → prefixed value wins, bare dropped
- [x] Bare key written **after** first adoption → adopted on next bootstrap re-run (idempotent)
- [x] Legacy key already starting `ws:` → treated as already-scoped, never re-prefixed; scoped writes reject user keys starting `ws:` (400) so the namespace stays reserved
- [x] Key containing `%` or `_` → prefix matching via `substr`, never `LIKE` (no wildcard ambiguity)
- [x] Alias named like a combo in another workspace → no cross-workspace hit
- [x] Rotation state isolation: two workspaces' same-name combos rotate independently (`comboRotationKey`)
- [x] Scoped read failure (storage error) → never falls back to global readers; `isModelDisabled` returns `false` (fail-open, as today)
- [x] Concurrent rename + strategy patch (same transaction, COMBO_NOT_FOUND)

---

## Validation Commands

### Static Analysis

```bash
npm run lint
npm run lint:brand
```

EXPECT: zero errors.

### Unit Tests

```bash
cd tests && npx vitest run unit/tenancy-guard.test.js unit/route-policy.test.js unit/db-migration-chain.test.js unit/scoped-combos.test.js unit/gateway-scoped-resolution.test.js unit/connection-ownership.test.js unit/settings-split.test.js unit/combo-strategy-atomic.test.js unit/gateway-key-routing.test.js
```

EXPECT: all pass.

### Full Test Suite (both switch states, as CI)

```bash
TOKENHOP_MULTI_USER=off npm test
TOKENHOP_MULTI_USER=on npm test
```

EXPECT: no regressions vs `tests/__baseline__/known-fails.txt` in either state.

### Baselines

```bash
node tests/__baseline__/verify-alias.mjs
node tests/__baseline__/verify-providers.mjs
```

EXPECT: alias/provider baselines unchanged (registry untouched).

### Build

```bash
npm run build
```

EXPECT: clean build.

### Database Validation

Covered by `unit/db-migration-chain.test.js` (chain == TABLES) + the migration fixture test in 4.1.

### Manual Validation

- [ ] Switch off, fresh dev run: create/rename/delete combo, set alias, disable a model — behaves exactly as today
- [ ] Switch on, two users: same combo name in two workspaces; A's traffic never expands B's combo; `/v1/models` per key shows only that key's workspace

---

## Acceptance Criteria

- [ ] All tasks completed
- [ ] `UNIQUE(workspaceId, name)` on combos; same name in two workspaces works, dup inside one fails
- [ ] kv `modelAliases/customModels/disabledModels` read/write under `ws:<id>/` in scoped mode; `mitmAlias` instance
- [ ] Workspace `comboStrategies` keyed by combo id; instance blob unchanged (names)
- [ ] Every scoped read/write has a cross-workspace negative test
- [ ] Gateway resolves combos/aliases/custom/disabled per principal workspace, no cross-workspace fallback; legacy storage byte-identical
- [ ] Tenancy guard green; pending-scope list shrinks (combos + 3 kv scopes classified; mitmAlias instance)
- [ ] `/api/combos/[id]/test` + `/headroom` enforce IDOR (B's id → 404); probe consumes the authorized combo
- [ ] importDb wipes `disabledModels` + re-prefixes scoped scopes on import; hashed `applyGatewayKeySnapshot` adopts in-tx (no NULL-workspaceId combos); same-workspace name dups fail closed
- [ ] `npm run lint`, `npm test` (off + on), `npm run build`, `npm run lint:brand` green; alias baseline verified
- [ ] No new dependencies; touched files ≤ ~500 lines
- [ ] Single-user regression incl. `/v1/models`

## Completion Checklist

- [ ] Code follows discovered patterns (scoped repos, workspaceScope routes, gatewayResources)
- [ ] Error handling matches codebase style (TenancyError NOT_FOUND, never "forbidden" on foreign ids)
- [ ] Repo functions ctx-first or `*Unscoped`
- [ ] Tests follow `seedTenancy`/`callRoute` harness
- [ ] No hardcoded values (capabilities via principal.js, prefixes via one helper)
- [ ] No unnecessary scope additions

## Risks

| Risk                                                                                                                                                             | Likelihood | Impact | Mitigation                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `comboStrategyPatch` clients sending only `name` after a same-name combo exists in two workspaces                                                                | medium     | low    | name resolves inside the **selected workspace** only; ambiguous cross-workspace names can never collide                                                                                                                                 |
| kv adoption collision: bare and prefixed key for the same logical entry                                                                                          | medium     | low    | deterministic rule: prefixed value wins, bare dropped (`INSERT OR IGNORE` + `DELETE`), count logged; tested in 4.1(b)                                                                                                                   |
| Legacy bare key written after first adoption lingers until next bootstrap                                                                                        | medium     | low    | scoped reads use the prefix only; unscoped writers are system paths that stamp Default; re-adoption is idempotent and runs at every bootstrap — tested in 4.1(b)                                                                        |
| Same-name dup combos inside one payload on import                                                                                                                | low        | medium | `UNIQUE(workspaceId,name)` fails after adoption stamps Default → whole import transaction rolls back cleanly (no partial state); tested in 4.1(f)                                                                                       |
| Pre-bootstrap NULL-workspaceId dup names (closed by `idx_combo_name_legacy`) vs post-adoption same-name-in-two-workspaces                                        | medium     | low    | partial index enforces global uniqueness only while `workspaceId IS NULL`; after adoption, per-workspace UNIQUE governs; app-level checks in both paths                                                                                 |
| Instance blob keeps name-keyed strategies while Default row is id-keyed — drift on rename in single-user-after-bootstrap mode                                    | medium     | medium | `updateComboUnscoped.moveComboStrategy` cascades names in blob only (never workspace rows); mirror converts to id; scoped mode never mixes (ws row wins via `getEffectivePreferences` pickKeys); mirror losses documented in decision 4 |
| `comboStrategyPatch` clients sending only `name` after a same-name combo exists in two workspaces                                                                | medium     | low    | name resolves inside the **selected workspace** only; ambiguous cross-workspace names can never collide                                                                                                                                 |
| `mirrorToDefaultWorkspace` name→id conversion drops strategies whose combo no longer resolves (renamed before conversion, or same-name combos in two workspaces) | low        | low    | dropped from the mirror; blob keeps the entry (today's behaviour for that entry); conversion is full-map replace, not lossy merge                                                                                                       |
| Schedulers (quota poller, weighted targets) read whole-instance combos/aliases — could ping connections outside the caller's workspace                           | low        | low    | already process-level today; per-workspace scheduling is YAN-368/370 scope; documented decision 8                                                                                                                                       |
| tenancy-guard regex scan misses prefixed-key SQL built via string concat                                                                                         | medium     | low    | keep scoped kv access inside `makeKv(scope, ctx)` and repo functions with literal scope names (scan patterns unchanged)                                                                                                                 |

| In-memory rotation cross-workspace leak | low | medium | single `comboRotationKey` helper used by every rotation call site and reset caller; rotation-isolation test |
| Schedulers (quota poller, weighted targets) read whole-instance combos/aliases — could ping connections outside the caller's workspace | low | low | already process-level today; per-workspace scheduling is YAN-368/370 scope; documented decision 8 |
| tenancy-guard regex scan misses prefixed-key SQL built via string concat | medium | low | keep scoped kv access inside `makeKv(scope, ctx)` and repo functions with literal scope names (scan patterns unchanged) |
| Probe path gains a raw-id swap window | low | medium | route loads the combo via `loadScoped` (IDOR-checked) and passes the **combo object**; probe never re-looks-up by caller-supplied id |

## Notes

- **Ambiguity resolved — "migration runs only when switch on?"**: precedent (005–008) is additive, unconditional, idempotent; irreversible/data steps run at bootstrap (switch-on). 009 follows that: DDL always, adoption at bootstrap. No migration reads the feature switch (migrations must stay environment-free).
- **Capability question (reviewer)**: issue says `workspace.combos.* / workspace.models.*`, but ADR-0002's fixed list already defines `workspace.combos.manage` (owner/admin `x*`, ws-owner/ws-manager; members/viewers: none — "viewer: budgets.read + usage.read … cannot read metadata beyond usage"). Plan reuses existing caps (decision 7) and does not touch `principal.js`. If the maintainer wants the new pair after all, add `workspace.combos.read` (member+ + `ADMIN_ANY_WORKSPACE`) and `workspace.models.manage` (`WS_MANAGER`) in `principal.js` and swap the constants in `routePolicy.js` — nothing else changes.
- YAN-368 (principal-aware routing) will replace the scheduler/global reads and extend resolution to grants; the `getGateway*` helpers added here are its intended hook point.
- `open-sse` is untouched: `combo.js` keys rotation on whatever `comboName` string it receives (prefixed upstream via `comboRotationKey`); `comboStrategy.js` keeps `(settings, key)` — callers choose the key via `comboStrategyKey`. All DB awareness lives in `src/`.
- `bootstrap.js` and `usersRepo.js` are deliberately not edited: folding kv/strategy adoption into `adoptOwnerlessRowsUnscoped` covers every caller (S1).
- Task 2.4 (`settingsRepo.js`): `getEffectivePreferences` stamps the workspace-scoped marker and forces `comboStrategies` to the workspace map or `{}` (rev2 leak fix, decision 4); `comboKeys.js` `comboStrategyFor` reads that marker. The pre-adoption name-keyed-blob fixture in `gateway-key-routing.test.js` must seed the workspace row (id-keyed) instead — it is NOT blessed via a global fallback.
