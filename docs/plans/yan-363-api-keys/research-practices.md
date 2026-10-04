# Practices Research: Hashed, Workspace-Scoped Gateway API Keys (YAN-363 / GH #231)

## Executive Summary

YAN-363 lands on a codebase that has already built almost every seam it needs: the migration framework with `rebuildTable` (YAN-352), the principal + capability model (YAN-353/357), the workspace-scope helpers (YAN-361), the tenancy test harness (YAN-354), and the route policy rows for `/api/keys`. The shortest safe implementation is: one new migration file using the existing helpers, one new crypto module using only `node:crypto`, a reshaped `apiKeysRepo.js`, a new `resolveApiKey` resolver wired into the marked hook in `session.js:176`, and replacing nine copy-pasted `requireApiKey` blocks with one helper. No new dependencies; `parseApiKey`/`verifyApiKeyCrc` stay dead and unused.

## Existing Reusable Code

Verified against the worktree at commit `bf80e10a`. Every claim below was read in the named file.

| Module/Utility                           | Location                                                                                                                                                                | Purpose                                                                                                                                                                                       | How to Reuse for This Feature                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Migration registry + idempotency helpers | `src/lib/db/migrations/index.js`, `helpers.js` (`tableHasColumn`, `indexExists`, `rebuildTable`, `backfill`)                                                            | Ordered, transactional, backup-gated migrations; `rebuildTable` implements the SQLite 12-step rebuild for UNIQUE/PK/FK changes                                                                | New `006-api-keys.js`: `rebuildTable(db, "apiKeys", TABLES.apiKeys)` so uniqueness moves to `keyHash`, with a `copySql` that hashes the old `key` column in place (`legacy = 1`). Register in `MIGRATIONS` and update `TABLES.apiKeys` in `src/lib/db/schema.js:78-88`; `tests/unit/db-migration-chain.test.js` then proves the chain matches                                                          |
| `apiKeysRepo`                            | `src/lib/db/repos/apiKeysRepo.js`                                                                                                                                       | All key CRUD + `validateApiKey` (exact-match at :73-78)                                                                                                                                       | Reshape `rowToKey` (drop `key`, add `keyHash/hashKid/prefix/legacy/workspaceId/userId/allowedModels/allowedCombos/expiresAt/lastUsedAt`). Keep the export names via `src/lib/db/index.js` barrel and the `src/lib/localDb.js` shim — no import changes anywhere                                                                                                                                        |
| `extractClientApiKey`                    | `src/lib/auth/clientApiKey.js`                                                                                                                                          | Single Bearer → `x-api-key` → `x-goog-api-key` → `?key=` extraction                                                                                                                           | `resolveApiKey` and every gateway check already funnel through this; do not re-parse headers anywhere                                                                                                                                                                                                                                                                                                  |
| Principal model                          | `src/lib/users/principal.js`                                                                                                                                            | `Principal` typedef already carries `apiKeyId` and `via: "apiKey"` (:13-14); `CAPABILITIES` already lists `workspace.keys.create`/`workspace.keys.manage`                                     | Return the existing typedef from `resolveApiKey`; nothing new to design                                                                                                                                                                                                                                                                                                                                |
| Request-principal hook                   | `src/lib/users/session.js`                                                                                                                                              | `resolvePrincipalOrThrow` has an explicit placeholder at :176: `// Gateway API keys resolve here once YAN-363 lands (via: "apiKey").` Also the `multiUserOn()` 5 s TTL cache pattern (:40-53) | Wire `resolveApiKey` into exactly that comment's position. Copy the module-local TTL-cache idiom for the key-resolution cache and add an explicit `invalidateApiKeyCache()` called from revoke/delete — no caching library                                                                                                                                                                             |
| Feature switch                           | `src/lib/users/featureSwitch.js` (`isMultiUserEnabled`, `requireMultiUser`)                                                                                             | Only sanctioned reader of the multi-user switch                                                                                                                                               | Gate all hash-on / scoped behavior; with the switch off, raw storage and exact-match validation stay byte-identical (ADR-0005 "Key hashing only when the switch is on")                                                                                                                                                                                                                                |
| Route policy rows                        | `src/lib/auth/routePolicy.js:177-178`                                                                                                                                   | `"/api/keys": { cap: { GET: "workspace.keys.manage", POST: "workspace.keys.create" } }`, `"/api/keys/[id]": { cap: "workspace.keys.manage" }`                                                 | Already correct. Zero edits here; `tests/unit/route-policy.test.js` would fail on an unmapped route anyway                                                                                                                                                                                                                                                                                             |
| Workspace-scope helpers                  | `src/lib/users/workspaceScope.js` (`principalScope`, `workspaceScope`, `loadScoped`, `denyRow`)                                                                         | Switch-on workspace selection + capability check; switch-off/single-user short-circuits to today's unscoped path                                                                              | `/api/keys/*` handlers call `workspaceScope(request, "workspace.keys.manage")` (or `…create`) and then hit the repo with `{ ctx, workspaceId }`, exactly like the connections routes from YAN-361                                                                                                                                                                                                      |
| Default-workspace adoption               | `src/lib/db/repos/ownership.js` (`defaultWorkspaceIdUnscoped`, `adoptOwnerlessRowsUnscoped`)                                                                            | Adopts ownerless rows into the Default workspace inside a transaction                                                                                                                         | Migration 006 uses the same idiom to stamp existing keys as Default-workspace service keys (`workspaceId = defaultWorkspaceIdUnscoped(db)`, `userId = NULL`), so existing clients keep working (ADR-0005)                                                                                                                                                                                              |
| Tenancy classification                   | `src/lib/db/tenancy.js`                                                                                                                                                 | `apiKeys: { class: "pending-scope", issue: "YAN-363" }`; `tests/unit/tenancy-guard.test.js` fails on any scoped-table repo read without `ctx` or an `Unscoped` suffix                         | Flip `apiKeys` to `{ class: "scoped", scopeColumn: "workspaceId" }`; the guard test then enforces repo discipline for free. Keep the hot-path hash lookup named `…Unscoped` (validation precedes tenancy, like session lookup)                                                                                                                                                                         |
| Key-name validation                      | `src/app/(dashboard)/dashboard/endpoint/endpointLogic.js` (`validateKeyName`)                                                                                           | Blank/oversized/control-char name rejection                                                                                                                                                   | Already used by both keys routes; keep the import as-is (consistent with existing code)                                                                                                                                                                                                                                                                                                                |
| Log redaction                            | `src/lib/db/repos/requestDetailsRepo.js:93-103` (`sanitizeHeaders`), `src/sse/utils/logger.js:114` (`maskKey`)                                                          | Strips `authorization`/`x-api-key`/`token`/`api-key` headers before persisting request details; masked logging on the hot path                                                                | Existing mechanisms already cover request logs. The "never in logs" test scans stored `requestDetails` rows + the log stream for raw keys; extend the `sensitiveKeys` list only if a new header is introduced (it isn't)                                                                                                                                                                               |
| MITM password pattern                    | `src/mitm/manager.js:113-237` (`encryptPassword`/`decryptPassword`, `mitmSudoEncrypted` in settings) + `src/app/api/settings/route.js:29` (`PROTECTED_SETTING_KEYS`)    | Encrypted, response-redacted settings secret                                                                                                                                                  | The MITM internal credential (ADR-0005) stores only its `keyHash` in settings next to `mitmSudoEncrypted`, and its setting key must be added to `PROTECTED_SETTING_KEYS`. `src/shared/services/initializeApp.js` `autoStartMitm` (:207-211, `activeKey?.key` else `ACTIVE.defaultApiKey`) and the restart path in `manager.js` switch to it; `src/mitm/handlers/base.js` (env compare) needs no change |
| Test harnesses                           | `tests/setup/tenancyHarness.js` (`seedTenancy`, `callRoute(handler, path, { as, apiKey })`, `denied`), `tests/setup/isolateDataDir.js`, `tests/helpers/isolatedHome.js` | Two-user cross-workspace negative tests; per-file isolated DB/HOME                                                                                                                            | Cross-workspace key tests use `seedTenancy()` + `callRoute(..., { apiKey: keyA })` verbatim. The legacy-DB migration test follows `tests/unit/db-migration-framework.test.js` against `tests/fixtures/db/v1.0.0.sql`, which already seeds raw key `'sk-th-legacy'` (line 37)                                                                                                                           |
| Backup gating                            | `src/lib/db/migrate.js` + `backup.js`                                                                                                                                   | Pre-migration backup on any pending migration (YAN-352)                                                                                                                                       | Migration 006 automatically runs after the backup; nothing to build. The switch-on-only condition gates the in-place hash (ADR-0005/0009)                                                                                                                                                                                                                                                              |
| Crypto primitives                        | `node:crypto` (`hkdfSync`, `createHmac`, `randomBytes`, `timingSafeEqual`)                                                                                              | ADR-0005 hash: `HMAC-SHA256(HKDF(masterKey, "tokenhop/api-key-hash"), key)`                                                                                                                   | No new dependency — handbook §8 forbids it and ADR-0008 already verified `node:crypto` coverage. Precedent in-repo: `crypto.randomBytes(32)` + `sha256` + `timingSafeEqual` in `src/lib/users/bootstrap.js` (setup token, :47-77)                                                                                                                                                                      |
| `src/lib/db/paths.js`                    | DATA_DIR resolution                                                                                                                                                     | `DATA_DIR` → `~/.tokenhop/` fallback chain                                                                                                                                                    | The master-key loader (new, YAN-363 owns it per spec §4) resolves `DATA_DIR/keys/master` through this module, not by re-deriving paths                                                                                                                                                                                                                                                                 |

## Modularity Design

### Recommended Module Boundaries

```
src/shared/utils/apiKey.js          KEEP legacy format code untouched (switch-off path + legacy acceptance)
src/shared/utils/apiKeyGen.js       NEW — pure, no imports beyond node:crypto: generateApiKey() →
                                    "th_" + 32 base62; apiKeyPrefix(key); allowedModels check helper
                                    if the gateway needs it. Bundle-safe (used from proxy + routes).
src/lib/keys/masterKey.js           NEW — loadMasterKey(): TOKENHOP_MASTER_KEY (base64, 32 B) else
                                    DATA_DIR/keys/master (0600, created on first switch-on). hashKey()
                                    = HKDF-SHA256(master, "tokenhop/api-key-hash", 32). Shared with
                                    YAN-365 (spec §3 finding 10); memoized on globalThis like bootstrap.js
src/lib/keys/apiKeyResolver.js      NEW — resolveApiKey(key) → Principal-ish { workspaceId, userId?,
                                    apiKeyId, scopes } | null, TTL cache + invalidateApiKeyCache().
                                    Imports db; NOT in the proxy bundle.
src/lib/db/migrations/006-api-keys.js  NEW — rebuild + in-place hash, switch-on only, frozen literal DDL style
src/lib/db/repos/apiKeysRepo.js     RESHAPE in place (rowToKey, create/validate/list/update/delete)
src/lib/auth/requireApiKey.js       NEW (or extend requireClientApiKey.js) — one helper used by the
                                    9 gateway call sites: extract → resolve → enforce requireApiKey +
                                    expiresAt + allowedModels → principal or 401
src/app/api/keys/route.js, [id]/route.js  ADD workspaceScope + switch-on create flow (show-once)
src/shared/services/initializeApp.js, src/mitm/manager.js  SWAP auto-start to the internal credential
src/lib/users/session.js            ONE hunk: the marked hook at :176
```

Rationale per boundary: pure generation/format code lives in `src/shared/utils/` (proxy-bundle rule from `principal.js`/`routePolicy.js`: no imports, bundle-safe). Anything touching the DB stays in `src/lib/` behind the `Unscoped`-suffix/ctx discipline that `tenancy-guard.test.js` enforces. Crypto and resolution are separate so `apiKeyGen` is unit-testable with no DB and `resolveApiKey` is unit-testable with the isolated test DB — the same split the codebase already uses for `clientApiKey.js` (pure) vs `requireClientApiKey.js` (DB).

### Shared vs. Feature-Specific Code

| Component                             | Shared or Feature-Specific                 | Rationale                                                                                                          |
| ------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `masterKey.js`                        | Shared                                     | YAN-365 reuses it for the encryption KEK (spec §3 finding 10, ADR-0008); one root of trust                         |
| `apiKeyGen.js` (generate/prefix/hash) | Shared                                     | MITM internal credential uses the same generator (ADR-0005); CLI (YAN-377) will reuse for rotate                   |
| `resolveApiKey` + cache               | Feature-specific (`src/lib/keys/`)         | Only gateway auth + MITM call it; `session.js` gets a one-line hook, not a dependency on the module at import time |
| Migration 006                         | Feature-specific                           | Standard one-off; framework is shared, content is not                                                              |
| `requireApiKey` gateway helper        | Shared within `src/sse/handlers/` + v1beta | Nine identical call sites — the one extraction that clearly passes rule of three                                   |
| MITM internal credential plumbing     | Feature-specific                           | Three call sites inside MITM code only (`initializeApp.js`, `manager.js` start/restart)                            |
| Tenancy/routePolicy/capability wiring | Already shared                             | Zero new code — flip classification, reuse rows                                                                    |

## KISS Assessment

| Area                    | Current Proposal                                          | Simpler Alternative                                                                                                                                                | Trade-off                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hash algorithm          | HMAC-SHA256 over HKDF-derived key (ADR-0005, binding)     | None — decided by ADR; plain SHA-256 was evaluated and rejected in the ADR for the ~31-bit legacy keyspace                                                         | None; keep it one function, not a "hashing service"                                                                                                         |
| Key validation hot path | argon2/bcrypt (typical for API keys elsewhere)            | HMAC + exact-match `WHERE keyHash = ? AND isActive = 1` — identical query shape and cost to today's lookup (ADR-0005 option 3 rejection)                           | Slow KDFs are for human passwords; `th_` keys carry ~190 bits                                                                                               |
| Legacy key acceptance   | Resurrect `parseApiKey`/`verifyApiKeyCrc` on the hot path | Hash legacy keys at migration; after that every format validates through the same single HMAC lookup. `parseApiKey`/`verifyApiKeyCrc` stay dead (never used today) | Legacy rows are flag-nudged for rotation instead of format-checked per request                                                                              |
| Resolution cache        | External LRU/TTL cache dependency                         | Module-local `{ at, value }` TTL cache copied from `session.js:40-53` + explicit invalidate on revoke/delete                                                       | Stale window = TTL; revoke needs the explicit invalidate (already required by the issue)                                                                    |
| `budgetId` column       | Issue says "added later"                                  | Skip the column in migration 006; `rebuildTable` makes a later rebuild cheap                                                                                       | Lose: a second rebuild migration later. Win: no speculative column. Recommend skip (YAGNI), unless the implementer wants one rebuild ever — decision needed |
| MITM credential         | Dedicated `apiKeys` row or new table                      | Settings-stored hash next to `mitmSudoEncrypted`, never an `apiKeys` row (ADR-0005 explicitly)                                                                     | Regenerating it only restarts the MITM process; no lifecycle coupling to user keys                                                                          |
| API surface             | New repo object/class with DI                             | Keep the existing module-function style of `src/lib/db/repos/*.js` (`getAdapter()` inside each fn)                                                                 | Consistency with the codebase beats theoretical testability; the isolated per-file test DB already makes these functions directly testable                  |

## Abstraction vs. Repetition

### Extract (Worth Abstracting)

- **Gateway `requireApiKey` enforcement**: 9 near-identical blocks — `src/sse/handlers/chat.js:119-128`, `embeddings.js:62-70`, `fetch.js:54-62`, `search.js:51-59`, `tts.js:50+`, `stt.js:36+`, `imageGeneration.js:42+`, `videoGeneration.js:61+`, `src/app/api/v1beta/models/[...path]/route.js:211`. Extract one helper beside `src/lib/auth/requireClientApiKey.js` that extracts, resolves, checks `expiresAt`/`allowedModels`, and returns `{ principal } | 401`. This also fixes the issue's gap: `handleChat` doesn't accept the CLI token but `requireClientApiKey.js` does — the helper makes both paths call the same acceptance logic (CLI token first, then key).
- **Key generation + hash**: 3 call sites (route POST, MITM credential, future CLI rotate) → `src/shared/utils/apiKeyGen.js`. Rule of three satisfied on day one.
- **Master-key load + HKDF**: 2 consumers in this project (YAN-363 hash, YAN-365 KEK) but mandated shared by spec §3 finding 10 — extract once, now.

### Repeat (Acceptable Duplication)

- **`dashboardGuard.js` `hasValidApiKey` (:46-50) and `requireClientApiKey.js`**: two thin wrappers over `resolveApiKey` serving different policies (gateway proxy gate vs per-route guard). Keep both; point each at the new resolver. Merging them would couple proxy-bundle code to DB-heavy resolution and break the bundle rule.
- **`withUsage` in `src/app/api/keys/route.js`**: joins usage by raw key today; YAN-370 owns re-keying `usageHistory`/`usageDaily` to `apiKeyId` (ADR-0005 "Usage migration"). YAN-363 makes the minimal join change (id-based) needed to keep listing working; do not pre-build YAN-370's migration.
- **Per-key `validateKeyName` reuse via dashboard import path**: ugly but established; a move would touch unrelated dashboard code. Leave it.

## Interface Design

### Public API Surfaces

```js
// src/shared/utils/apiKeyGen.js — pure, bundle-safe
export function generateApiKey()        // → "th_" + 32 base62 (crypto.randomBytes, rejection sampling)
export function apiKeyPrefix(key)       // → first 7 + "…" + last 4 (ADR-0005 display rule)
export function isTokenhopKey(key)      // startsWith("th_"), length check — display only, never validation

// src/lib/keys/masterKey.js
export async function loadMasterKey()   // TOKENHOP_MASTER_KEY || DATA_DIR/keys/master (0600); memoized on globalThis
export function hashApiKey(rawKey)      // → { keyHash, hashKid } HMAC-SHA256(HKDF(master, "tokenhop/api-key-hash"), key)

// src/lib/keys/apiKeyResolver.js
export async function resolveApiKey(rawKey)
  // → { workspaceId, userId: string|null, apiKeyId, scopes, allowedModels, allowedCombos } | null
  // scopes derived from user-vs-service; null covers unknown/inactive/expired (no oracle between them)
export function invalidateApiKeyCache(apiKeyId /* optional; omit = drop all */)

// src/lib/db/repos/apiKeysRepo.js — same export names, new shapes
validateApiKey(key)  // boolean wrapper over resolveApiKey; keeps dashboardGuard.js:50 and
                     // src/sse/services/auth.js:489 compiling with zero call-site edits
```

Design notes:

- **Boolean `validateApiKey` stays as a wrapper** — the two existing boolean call sites (`src/dashboardGuard.js`, `src/sse/services/auth.js`) don't need principals yet (YAN-368 does). Shortest diff, and the wrapper is 3 lines.
- **Null-not-error for deny**: matches `resolvePrincipal`'s fail-closed posture in `session.js:159-165`; unknown/inactive/expired are indistinguishable (no existence oracle).
- **`hashKid` on every row** (ADR-0005 rotation interaction): old HKDF keys stay loadable until keys rotate away; the loader must support `kid → key` lookup even if only `v1` exists today.
- **No `key` in any response except POST**: `rowToKey` never selects `keyHash`; list/get return `{ id, name, prefix, isActive, legacy, workspaceId, userId, expiresAt, lastUsedAt, createdAt }`.

### Extension Points

- `scopes` in the resolver return is the seam YAN-368 (gateway principal enforcement) and YAN-372 (budget levels by key/user) consume without reshaping this code.
- `allowedModels`/`allowedCombos` empty-means-open leaves YAN-368 free to interpret; YAN-363 only stores and returns them.
- The MITM credential reuses `generateApiKey`/`hashApiKey`, so any future format change is one module.
- `budgetId`: reserved by ADR; when added, it's a nullable column + `rebuildTable`, no interface change.

## Testability Patterns

### Recommended Patterns

- **Pure crypto split**: `apiKeyGen.js`/`hashApiKey` have no DB imports — unit-test like `tests/unit/client-api-key.test.js` (create/validate round-trip, prefix format, tamper rejection) without any fixture.
- **Legacy-DB fixture migration test**: follow `tests/unit/db-migration-framework.test.js` with `tests/fixtures/db/v1.0.0.sql` — it already inserts raw key `'sk-th-legacy'` (line 37). Assert post-migration: raw key still authenticates via `resolveApiKey`, row has `keyHash` + `legacy = 1`, no `key` column, backup was taken (framework already proves backup).
- **Cross-workspace negatives**: `tests/setup/tenancyHarness.js` `seedTenancy()` + `callRoute(handler, "/api/keys", { as: b })` and `{ apiKey: keyOfA }`; assert B can't list/revoke/use A's key. Same shape as `tests/unit/tenancy-isolation.test.js`.
- **No-raw-key scan**: one test serializing every `/api/keys*` response and the `requestDetails`/`usageHistory` rows, asserting no `sk-`/`th_` substrings except the single POST response; log stream asserted via the `console.log` spy pattern from `db-migration-framework.test.js`.
- **Isolation**: per-file isolated `DATA_DIR`/`HOME` is automatic (`tests/setup/`); key tests touching master-key files must still go through `tests/helpers/isolatedHome.js`. Guarded by `tests/unit/test-data-isolation.test.js`.
- **Switch-off regression**: run `tests/unit/require-client-api-key.test.js`, `api-key-rename.test.js`, `api-key-usage.test.js`, `usage-apikey-stats.test.js` unmodified — they are the behavior-identical proof; add no switch-off-specific new tests beyond one assert that raw `GET /api/keys` still returns `key` with the switch off.

### Anti-patterns to Avoid

- **Env read at module load**: `src/shared/utils/apiKey.js:3` reads `API_KEY_SECRET` at import time, which blocks per-test override. New `masterKey.js` must read env lazily inside `loadMasterKey()` and expose a test reset, or tests can't rotate the master key between cases.
- **Testing through HTTP for hash logic**: hash/prefix are pure — don't route them through `callRoute`; direct imports keep the suite fast.
- **A "cacheable" global without invalidation test**: the revoke-must-invalidate property needs an explicit test (create → resolve → revoke → resolve → null within the same process and within the TTL).
- **Mocking the adapter**: the repos are written against real SQLite via `getAdapter()`; the existing pattern is real isolated DBs, not mocks. Follow it — a mock would re-test the mock.

## Build vs. Depend

| Need                   | Build Custom                                                                            | Use Library                                                               | Recommendation      | Rationale                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------- |
| HMAC/HKDF/random       | ~15 lines on `node:crypto` (`hkdfSync`, `createHmac`, `randomBytes`, `timingSafeEqual`) | `jose` is installed but is JWT-oriented; pulling it for HMAC adds nothing | Build (node:crypto) | ADR-0008 already verified availability; handbook §8 forbids new deps                                       |
| Password-style hashing | n/a                                                                                     | argon2/bcrypt — new native dep                                            | Neither             | ADR-0005 option 3 rejected: hot-path cost, native dep, unnecessary at 190 bits                             |
| Base62 generation      | ~10 lines rejection sampling from `randomBytes`                                         | nanoid (already in tree? verify at implement time — do not add if absent) | Build               | 32 chars from a fixed alphabet is trivial; a dep for this fails the "few lines" rung                       |
| Cache                  | module-local TTL + invalidate (copy `session.js` idiom)                                 | lru-cache / node-cache                                                    | Build               | One map, one TTL; a dep buys eviction policies we don't need                                               |
| Key-prefix masking UI  | existing `maskKey` in `endpointLogic.js:221` + `ApiKeysCard.js`                         | n/a                                                                       | Reuse               | Display rule changes to `prefix` column; `maskKey` usage sites switch to the stored prefix                 |
| Migration framework    | existing `rebuildTable`/`backfill`                                                      | any migration tool (knex etc.)                                            | Reuse               | The framework is exactly built for this (UNIQUE-on-keyHash rebuild); a tool would be a category error here |

## Critical Test Boundaries (Ownership Checklist for Implementation)

1. **Migration correctness** (switch on): raw key → hashed, `legacy=1`, Default-workspace service key, name kept, uniqueness on `keyHash`, backup taken, `PRAGMA foreign_key_check` passes. Boundary: `006` + `rebuildTable` + `v1.0.0.sql` fixture.
2. **Legacy acceptance**: pre-migration raw key authenticates post-migration; `sk-` creation is never offered post-switch.
3. **Cross-workspace**: B cannot list/revoke/use A's key (harness `seedTenancy`/`callRoute`); service keys resolve to workspace, not user.
4. **Lifecycle**: user key revoked on user disable/delete/leave; service key survives; `expiresAt` enforced at resolution, not just at creation.
5. **Secret hygiene**: raw key only in POST response; never in DB rows, usage rows, request details, or logs (scan test).
6. **Switch off**: raw storage, `GET /api/keys` shape, MITM auto-start, and all four existing key test files unchanged and green.
7. **MITM**: auto-start works with zero `apiKeys` rows using the internal credential; `base.js` untouched.
8. **Local no-key**: `requireApiKey=false` maps to owner+Default (not `local-no-key`) and is refused when `multiUserActive` unless admin opts in — new route-level test with the switch on.

## Open Questions

1. **`budgetId` now or later?** Issue says later; ADR reshape lists it. Skipping honors YAGNI but forces a second `rebuildTable` later. Cheap either way — needs one decision before writing 006.
2. **Usage re-keying boundary**: ADR-0005 assigns `usageHistory.apiKey → apiKeyId` migration to YAN-370, but YAN-363's test list includes "no raw key in any response". Confirm YAN-363 only stops _writing_ raw keys and fixes the `withUsage` join minimally; historical rows are YAN-370's.
3. **MITM credential storage key name** and whether it lives in `settings.data` (needs `PROTECTED_SETTING_KEYS`) vs `_meta` — ADR says settings; confirm no settings-export leak (`src/lib/db/configExport.js`) before choosing.
4. **Scopes derivation for service keys**: `gateway.use` only, or workspace-role-derived? Issue names the shape, not the values — smallest safe answer is a fixed `["gateway.use"]` for v1.1.0.
