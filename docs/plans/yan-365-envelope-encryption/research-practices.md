# YAN-365 practices lane — envelope encryption at rest (per-workspace DEKs)

Scope: GH #233 checklist only. ADR-0008 accepted (main docs/users/adr/0008-encryption-at-rest.md).
ADO ceilings included below still meet every checklist item. Child of YAN-350
design; sibling lanes own users-data-model, tenancy migration. This lane owns
crypto + key module, per-workspace DEKs, field encryption seams,
migration shape, CLI/admin rotation seam, test plan.

Read by validation lane: issue state, checklist coverage, regression seams.

## Executive Summary

- Reuse `src/lib/security/masterKey.js` (`loadMasterKey`, `masterKeyId`) as KEK
  source. No new key-file format; follow its fail-closed conventions.
- One new module: `src/lib/security/envelopeCrypto.js` (encrypt/decrypt field
  - wrap/unwrap DEK, Node `crypto` only). One new table: `workspaceKeys`.
    Encrypt at repo seam (`rowToConn`/`connToRow` in `connectionsRepo.js`,
    same pattern in `nodesRepo.js`, SSO secret fields in `settingsRepo.js`).
- Switch-gated (`isMultiUserEnabled()`): switch off = byte-identical plaintext
  behavior. Migration idempotent, plaintext-tolerant reads, backup-first.
- Keep tests hermetic: `tests/vitest.config.js` isolates `DATA_DIR`/`HOME`;
  route tests through `tests/helpers/isolatedHome.js`.
- Open questions at end (4) block final API shape, not overall approach.

## Existing Reusable Code

Reuse first; do not reinvent.

| Need                              | Existing code                                                                                                                                                                                                                                  | Reuse                                                                                                                                                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KEK load/create                   | `src/lib/security/masterKey.js` `loadMasterKey({create})`, `decodeStrictEnv`, `masterKeyId`, 0600/symlink/O_NOFOLLOW guards                                                                                                                    | KEK = this module's key. No new env/file logic                                                                                                                                                                               |
| API-key hash derivation precedent | `deriveApiKeyHashKey` (HKDF) in same file; callers `src/lib/db/repos/apiKeysRepo.js`, `cliToolSettingsRepo.js`, `usageRepo.js`                                                                                                                 | Mirror HKDF separation: different `info` string for DEK-wrap vs field keys (domain separation), not new derivation code                                                                                                      |
| Connection read/write seam        | `src/lib/db/repos/connectionsRepo.js`: `rowToConn`/`connToRow`, `upsert`, `updateInTx` (transactional, owns OAuth refresh race, line 334-352), scoped twins `listConnections/getConnection/createConnection/updateConnection/deleteConnection` | Encrypt/decrypt inside `rowToConn`/`connToRow` only; refresh path (`updateProviderConnectionUnscoped` → `updateInTx`) stays untouched                                                                                        |
| Node read/write seam              | `src/lib/db/repos/nodesRepo.js`: `rowToNode`/`nodeToRow`, `upsert`, `updateInTx`                                                                                                                                                               | Same envelope hook as connections                                                                                                                                                                                            |
| Workspace delete seam             | `src/lib/db/repos/workspacesRepo.js` `deleteWorkspace` (line 85): plain `DELETE FROM workspaces WHERE id=?`                                                                                                                                    | Add DEK-row delete in same transaction (crypto-shredding); FK `ON DELETE CASCADE` as backstop (see §4)                                                                                                                       |
| Migration runner                  | `src/lib/db/migrate.js` (per-migration transaction, version stamp, row-count asserts) + `src/lib/db/migrations/helpers.js` (`tableHasColumn`, `backfill`, `rebuildTable`)                                                                      | New migration `013-workspace-keys.js` (next free number; 012-invitations exists) creates `workspaceKeys`, no rebuilds                                                                                                        |
| Migration precedent               | `src/lib/db/migrations/005-connection-ownership.js` (additive columns, idempotent `tableHasColumn` guard), `hashGatewayKeys.js` (master-key assertion, fail-closed)                                                                            | Same idempotent shape                                                                                                                                                                                                        |
| Backup before destructive work    | `src/lib/db/backup.js` (`makeProtectedBackupDir`, `prepareProtectedBackupVerifier`, 0700/0600 perms) used by `importDb` pre-import backup                                                                                                      | Encryption migration calls same helpers; nothing new                                                                                                                                                                         |
| Transaction pattern               | `db.transaction(() => …)` sync closures in `connectionsRepo.js`, `aliasRepo.js`, `activateGatewayKeys.js`, `index.js`                                                                                                                          | KEK rotation rewraps DEKs inside one `db.transaction`; field re-encrypt (per-DEK rotation) batches per workspace in transactions                                                                                             |
| Settings secrets inventory        | `src/lib/settingsConfigDoc.js` `SECRET_SETTING_KEYS` (lines 60-74): `oidcClientSecret`, `samlPrivateKey`, `samlDecryptionKey`, `samlSigningKey`, `mitmSudoEncrypted`                                                                           | Authoritative covered-field list for settings side                                                                                                                                                                           |
| Settings read/write seam          | `src/lib/db/repos/settingsRepo.js` `getSettings`/`updateSettings`/`exportSettings` (line 161+)                                                                                                                                                 | Encrypt values of `SECRET_SETTING_KEYS` subset at this seam, not in callers                                                                                                                                                  |
| Switch gate                       | `src/lib/users/featureSwitch.js` `isMultiUserEnabled()` / `requireMultiUser()` (404 when off)                                                                                                                                                  | Every user-visible behavior gated; switch off = today's code path                                                                                                                                                            |
| MITM current crypto               | `src/mitm/manager.js` `encryptPassword`/`decryptPassword` (lines 273-293), `deriveKey` machine-id + `"9router-mitm-pwd"` salt (262-271), storage `mitmSudoEncrypted` via `_updateSettings` (334-355)                                           | Retire `deriveKey`/`encryptPassword`/`decryptPassword`; route through DEK module; migration decrypts legacy format once then re-encrypts                                                                                     |
| Export/import seam                | `src/lib/db/index.js` `exportDb` (272+) / `importDb` (355+, wipes tables, `importDb` never decrypts per ADR)                                                                                                                                   | Export carries ciphertext + wrapped DEKs opaque; import moves envelopes as strings; `workspaceKeys` wipe/insert added here (owned by YAN-375 per ADR — this lane only defines envelope-string format so import stays opaque) |
| Admin auth precedent              | `src/app/api/settings/database/route.js`: CLI token OR `x-9r-password` dashboard-password header, audit via `src/lib/users/audit.js`; routePolicy `alwaysProtected` + `multiUserOnly` flags                                                    | Rotation admin API follows same gate; new route gets a `routePolicy.js` row (route-policy test fails otherwise)                                                                                                              |
| CLI command precedent             | `cli/src/cli/commands/{dataMigrate,xaiVideo}.js` dispatched from `cli/cli.js`; `requireShared` for shared paths                                                                                                                                | `tokenhop keys rotate` follows same shape (owned by YAN-377; this lane defines only the rewrap function it calls)                                                                                                            |
| Audit seam                        | `connectionsRepo.js` `createConnection` audits identity fields only, never credentials (YAN-367 comment)                                                                                                                                       | Rotation/deletion audit same allow-list; never log plaintext, envelopes, or DEKs                                                                                                                                             |
| Test isolation (mandatory)        | `tests/vitest.config.js` moves `HOME`/`DATA_DIR` to temp; `tests/helpers/isolatedHome.js` throws when not isolated; `tests/unit/test-data-isolation.test.js` guards                                                                            | All crypto tests use temp `DATA_DIR`; never touch real `~/.tokenhop`                                                                                                                                                         |
| Test precedents                   | `tests/unit/gateway-key-crypto.test.js`, `gateway-key-migration.test.js`, `gateway-key-transfer.test.js`, `multi-user-switch.test.js`, `db-migration-chain.test.js`                                                                            | Mirror their fixtures for round-trip, tamper, migration-idempotence, switch off/on                                                                                                                                           |

Secret-field inventory for `providerConnections.data` (per provider registry
entry): `accessToken`, `refreshToken`, `idToken`, `apiKey`, cookies,
`providerSpecificData` secrets. Non-secret metadata (names, plan tier) stays
plaintext for queries. Exact per-provider secret list lives in users-data-model
lane; this lane consumes it as a `SECRET_FIELDS` set — one shared constant,
not per-repo copies.

## Modularity Design

Before (today):

```
route/handler → connectionsRepo.rowToConn/connToRow (plaintext JSON blob)
              → nodesRepo.rowToNode/nodeToRow (plaintext)
              → settingsRepo.getSettings/updateSettings (plaintext incl. SSO secrets)
              → mitm/manager.js encryptPassword (machine-id key, separate scheme)
masterKey.js (KEK-capable) → only apiKeys hashing callers
```

After (proposed, 2 new files + hooks at existing seams):

```
src/lib/security/envelopeCrypto.js   NEW: encryptField/decryptField,
                                     wrapDek/unwrapDek, isEnvelope(),
                                     bounded DEK cache + clearWorkspace(id)
src/lib/security/connectionSecrets.js NEW?: SECRET_FIELDS set + pick/merge
                                     helpers (only if 3rd use appears; else
                                     co-locate in envelopeCrypto.js — see §5)
src/lib/db/migrations/013-workspace-keys.js  NEW: workspaceKeys table
connectionsRepo.rowToConn/connToRow  HOOK: decrypt/encrypt secret fields
nodesRepo.rowToNode/nodeToRow        HOOK: same
settingsRepo.getSettings/updateSettings HOOK: SSO-secret subset
workspacesRepo.deleteWorkspace       HOOK: delete workspaceKeys row in-tx
mitm/manager.js                      HOOK: replace deriveKey/encrypt/decrypt
                                     with DEK calls; delete old fns
masterKey.js                         REUSE unchanged (KEK source)
exportDb/importDb                    CARRY envelopes opaque (+workspaceKeys
                                     wipe/insert — YAN-375 owns)
`tokenhop keys rotate` + admin API   CALL rewrapAllDeks() (YAN-377 owns CLI/API;
                                     this lane owns the function)
```

Boundaries:

- `envelopeCrypto.js` never touches DB or repos (pure crypto + in-memory
  cache). Takes `dek: Buffer` and AAD strings as args. Testable without SQLite.
- Repos never touch KEK bytes. They call `getWorkspaceDek(workspaceId)`
  (loads + unwraps + caches) then `encryptField/dectyptField`. KEK stays inside
  security layer.
- `workspaceKeys` table: `(workspaceId TEXT PK, kid TEXT, wrappedDek TEXT,
createdAt TEXT)`. Wrapped DEK stored as same envelope JSON shape.
- Envelope format (ADR): `{v:1, kid, iv, ct, tag}` base64 strings. AAD for
  fields per issue: `table|rowId|workspaceId|field`. AAD for DEK wrap per ADR:
  `workspaceId|kid`. (Issue text says `connectionId|workspaceId` for fields;
  ADR-0008 Decision says `connectionId|workspaceId` — either way AAD binds
  row+workspace. Reconcile to issue's 4-part form in implementation; note in
  Q1.)
- Mixed plaintext/encrypted reads: `isEnvelope(value)` → decrypt; else if
  switch on → treat as legacy plaintext (migration path); else → return as-is.
  Never write plaintext when switch on.

## KISS Assessment

- No factory, no provider interface, no `CryptoService` class. Plain exported
  functions. One implementation of AES-256-GCM exists (`node:crypto`); an
  interface with one implementation is unrequested abstraction.
- No new config file. KEK source = env or existing `DATA_DIR/keys/master`
  via `loadMasterKey({create:true})`. No key-rotation scheduler, no background
  jobs — rotation is an explicit CLI/admin call.
- No per-field key versions, no key hierarchy deeper than KEK→DEK. Issue asks
  exactly two levels; deeper nesting pays nothing.
- DEK cache: a `Map` with size cap (e.g. 100 entries, LRU-ish or FIFO evict)
  - `clearWorkspace(id)` on delete. Not an LRU library, not TTL logic. Ceiling:
    unbounded cache leaks DEKs across workspace deletes (violates shredding);
    no cache at all re-unwraps per row (fine for correctness, slower). Bounded
    map is the minimum meeting both.
- `workspaceKeys` FK: `workspaceId REFERENCES workspaces(id) ON DELETE
CASCADE` as backstop + explicit delete in `deleteWorkspace` transaction.
  Explicit delete is the readable path; CASCADE covers races. Both, because
  shredding must not depend on one code path.
- Migration encrypts existing rows under Default DEK in one migration `up()`
  using `backfill`-style row loop. No separate backfill job, no phased rollout
  — idempotence (`isEnvelope` skip) covers crash re-runs.
- MITM: delete `deriveKey`/`encryptPassword`/`decryptPassword` after migration
  covers `mitmSudoEncrypted`. Keep a one-shot legacy-decrypt helper inside the
  migration only, not as exported API. No dual-support period beyond migration.
- `ponytail:` passphrase-wrapped export (issue: covered in hardening issue, not
  here). Export carries ciphertext + wrapped DEKs; restore requires same KEK.
  Add when hardening issue lands.

## Abstraction vs Repetition

- Extract now (3+ uses, same shape): field encrypt/decrypt at
  connections+nodes+settings seams → one `encryptSecretFields(obj, {aad})` /
  `decryptSecretFields(obj, {aad})` pair in `envelopeCrypto.js` driven by a
  `SECRET_FIELDS` set. Rule of three met on day one (three repo seams).
- Leave duplicated: the two-line `isEnvelope ? decrypt : passthrough` call at
  each `rowToX` site. A shared "decrypting row mapper" wrapper saves 2 lines
  per site and hides control flow — not worth it.
- Leave duplicated: per-repo AAD string construction (`table|rowId|
workspaceId|field`). One format function `aad(table,rowId,ws,field)` is fine
  (one line); do not build an AAD builder object.
- Do not extract: `connectionSecrets.js` as separate module until a third
  consumer needs `SECRET_FIELDS` beyond envelopeCrypto + one repo import.
  Start co-located; split when settings seam + MITM both import it (third use).
- Do not abstract: KEK rotation vs DEK rotation share only `randomBytes(32)`.
  Two small functions, not a `rotateKey(kind)` dispatcher.

## Interface Design

```js
// src/lib/security/envelopeCrypto.js (proposed)
export function isEnvelope(v)            // v?.v===1 && strings kid/iv/ct/tag
export function encryptField(plaintext, dek, { aad })     // → envelope obj
export function decryptField(env, dek, { aad })           // → string; throws INTEGRITY error
export function wrapDek(dek, kek, { workspaceId, kid })   // → envelope obj
export function unwrapDek(env, kek, { workspaceId })      // → Buffer(32)
export async function getWorkspaceDek(workspaceId)        // cached, unwraps via KEK
export function clearWorkspaceDek(workspaceId)            // call on workspace delete
export async function rewrapAllDeks(oldKek, newKek)       // KEK rotation; field ct untouched
export async function rotateWorkspaceDek(workspaceId)     // fresh DEK + re-encrypt fields
```

- Errors: fail fast, typed codes (`ENCRYPTION_KEK_MISSING`,
  `ENCRYPTION_INTEGRITY`, `ENCRYPTION_UNREADABLE`). Missing KEK throws clear
  error, never silently plaintext (checklist item).
- `decryptField` failure mode per ADR test impact: connections report
  unreadable, no crash, no partial decryption. Repo catches integrity errors
  per-row and surfaces `{ unreadable: true }` marker — exact marker shape is
  users-data-model lane's call; this lane requires only "throw, don't return
  garbage."
- `getWorkspaceDek` creates DEK lazily on first use per workspace (random 32B,
  wrap, insert row) inside caller's transaction where possible; standalone
  otherwise. Lazy creation avoids a workspace-provisioning hook in another lane.
- Rotation seam for YAN-377: `rewrapAllDeks` is O(workspaces). CLI/API layers
  own prompting, locking, audit. `rotateWorkspaceDek` re-encrypts that
  workspace's fields; runs per-workspace transactions, not one giant txn.

## Testability Patterns

Patterns helping:

- Pure crypto functions (`encryptField`/`decryptField`/`wrapDek`/`unwrapDek`)
  need no DB — unit-test with static KEK/DEK buffers.
- `isEnvelope` makes mixed-state tests trivial: feed plaintext, envelope, and
  tampered envelope through same `rowToConn` path.
- Existing `db.transaction` seams let refresh-path test wrap
  `updateProviderConnectionUnscoped` and assert rotation still merges correctly
  on encrypted rows.
- Migration test: legacy-plaintext fixture DB → run `013` → assert decrypts +
  re-run idempotent + scan asserts no plaintext secret remains (checklist scan
  test = `SELECT data FROM providerConnections` contains no known secret
  substring outside envelopes).

Checklist → test file map (all under `tests/unit/`, hermetic `DATA_DIR`):

| Checklist item               | Test                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| round-trip                   | `envelope-roundtrip.test.js` (pure) + repo-level write/read                                                          |
| AAD tamper + row swap fail   | same file: flip `rowId`/`workspaceId`/field in AAD, swap two rows' envelopes; expect integrity throw                 |
| KEK rotation                 | `envelope-rotation.test.js`: rewrap, field ct byte-identical, decrypt works with new KEK, fails with old             |
| missing KEK fails fast       | `loadMasterKey` without env/file `{create:false}` throws; repo read throws `KEK_MISSING`, never plaintext            |
| migration fixture            | `envelope-migration.test.js`: legacy fixture → migrate → decrypt OK, idempotent re-run                               |
| refresh path works           | extend `background-token-refresh.test.js` pattern: rotate refresh token on encrypted row inside `updateInTx`         |
| no plaintext after migration | scan test in migration file: every secret substring absent outside envelopes                                         |
| switch-off regression        | `multi-user-switch.test.js` pattern: switch off → no `workspaceKeys` rows, fields plaintext, byte-identical behavior |
| workspace delete shreds      | delete workspace → `workspaceKeys` row gone → old ct undecryptable even with KEK                                     |

Anti-patterns to avoid:

- No live-provider tests for crypto (no `*.real.test.js`); secrets are fake.
- No real `HOME`/`DATA_DIR` — `isolatedHome.js` throws otherwise.
- No asserting exact ciphertext bytes (random nonce); assert round-trip +
  envelope shape + failure modes.

## Build vs Depend

- `node:crypto` only (AES-256-GCM, `randomBytes`, HKDF via existing
  `deriveApiKeyHashKey` pattern). Zero new dependencies — issue + ADR + handbook
  §8 all require this. No `jose`, no `libsodium-wrappers`, no SQLCipher.
- Rationale: AES-GCM + HKDF cover envelope fully; sodium adds wasm/native
  weight for no threat-model gain; SQLCipher is native + no per-workspace
  destruction (ADR rejected both).
- Reuse `uuid` (already dep) for `kid` values if needed; else
  `randomBytes(8).hex` — one line, no new dep either way.

## Open Questions

1. AAD canonical form: issue says `table|rowId|workspaceId|field`, ADR Decision
   says `connectionId|workspaceId`. Recommend issue's 4-part form (binds field
   name too; strictly stronger). Needs validation-lane sign-off; one-line change.
2. Settings SSO secrets have no `rowId`/`workspaceId` (instance-scoped). AAD
   proposal: `settings|global|default|<field>`. Confirm with validation owner.
3. `kid` for KEK rotation history: `masterKeyId(kek)` (first16 hex, existing
   helper) as envelope `kid`. Old-KEK fallback on read — yes (one previous) or
   no (fail unreadable until rewrap completes)? Recommend no fallback: rotation
   is atomic in-tx, fallback adds silent-decrypt risk. Confirm.
4. `tokenhop keys rotate` per-workspace DEK rotation (issue line: "DEKs
   themselves are rotated per workspace") — same command with flag, or separate
   admin API call? Recommend `keys rotate --workspace <id>` flag + admin API
   param, one function each. YAN-377 owns; note dependency.
