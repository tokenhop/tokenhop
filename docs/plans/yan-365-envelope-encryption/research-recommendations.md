# YAN-365 — Envelope Encryption at Rest: Recommendations

Research lane: recommendations. GH #233 / Linear YAN-365. Grounded at worktree HEAD `896a77f7` (master after invitations #776). ADR-0008 accepted 2026-10-02 (YAN-350). Other research files may still be in flight; this file does not depend on them.

## Executive Summary

Both blockers are merged at this HEAD: YAN-361 (connection/node ownership, migrations 004/005, scoped repos) and YAN-363 (hashed gateway keys plus the shared master-key loader `src/lib/security/masterKey.js` — strict `TOKENHOP_MASTER_KEY`/`DATA_DIR/keys/master` handling, `loadMasterKey({create, expectedKid})`, kid, HKDF; reuse it, spec decision 52). The work is therefore mostly additive: a node-crypto envelope module, a `workspaceKeys` table, encryption at the two repo JSON chokepoints, a switch-gated idempotent migration with a protected pre-migration backup, crypto-shredding on workspace delete, and rotation. The two hard parts are (a) the bypass risk — `providerConnections.data`/`providerNodes.data` are read by raw SQL outside the repos (`exportDb`, `gatewayKeyTransfer`, `gatewayResources`) — and (b) lane overlaps: export/import parity is YAN-375, rotate CLI is YAN-377 per ADR-0008, docs are YAN-379. Follow the YAN-363 durable-latch precedent so established encryption survives a switch-off without ever decrypting.

## Implementation Recommendations

Scoped phases, each landable behind the switch (handbook §5; CI matrix `TOKENHOP_MULTI_USER` already exists in `.github/workflows/ci.yml`).

### Phase 1 — Crypto module (no behavior change; ships anytime)

- `src/lib/security/envelope.js`, node:crypto only: `wrapDek(kek, dek, {workspaceId, kid})` / `unwrapDek` (AES-256-GCM, AAD `workspaceId|kid`), `encryptField(dek, plaintext, aad)` / `decryptField` (AES-256-GCM, random 12-byte nonce), envelope `{v:1, kid, iv, ct, tag}` (base64). `isEnvelope(value)` shape probe for mixed plaintext/ciphertext reads.
- Bounded decrypt cache (Map, fixed cap, e.g. LRU by `workspaceId` → DEK only — cache DEKs, never plaintext fields; plaintext never cached) with `clearWorkspace(workspaceId)`. DEK cache is the useful one; field-level caching buys nothing.
- Missing/corrupt KEK fails fast via `loadMasterKey` (already throws `[master-key] ...`); never fall back to plaintext write.
- AAD: **decided — `table|rowId|workspaceId|field`** (issue #233 superset; also covers nodes and settings rows, where a `connectionId|workspaceId` AAD doesn't exist). Substituting any component fails authentication.

### Phase 2 — Schema (additive, inert while off)

- Migration `013-workspace-keys.js` (next version after 012-invitations): `workspaceKeys(workspaceId TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE, kid TEXT NOT NULL, wrappedDek TEXT NOT NULL, createdAt TEXT NOT NULL)`, mirroring the frozen-DDL style of `012-invitations.js`. Add the matching `TABLES.workspaceKeys` in `src/lib/db/schema.js`.
- Classify it or the guard fails: `TABLE_CLASSES.workspaceKeys = { class: "scoped", scopeColumn: "workspaceId" }` in `src/lib/db/tenancy.js` (`tests/unit/tenancy-guard.test.js` fails on any unclassified table).

### Phase 3 — Repo chokepoints (the core)

- `src/lib/db/repos/connectionsRepo.js`: encrypt in `connToRow` (secret fields inside the `rest` JSON blob), decrypt in `rowToConn`. `nodesRepo.js`: same in `nodeToRow`/`rowToNode`. These two functions are the single encode/decode point for all repo traffic.
- Gate by switch + durable marker (Phase 5): `isMultiUserEnabled()` off → byte-identical plaintext JSON today. On → envelopes for secret fields only; non-secret metadata (`displayName`, `email`, `testStatus`, `providerSpecificData.chatgptPlanType`, …) stays queryable plaintext.
- Mixed-state read: `isEnvelope(x)` → decrypt; else pass through plaintext (transition correctness, issue requirement).
- Refresh path: `updateProviderConnectionUnscoped` wraps `updateInTx` in `db.transaction`. node:crypto is synchronous, so encrypt inside the same transaction with zero awaits — rotation stays atomic exactly as the issue demands (`connectionsRepo.js:334-350`).
- Secret-field allowlist per provider: derive from the OAuth provider registry (`src/lib/oauth/providers/`) — `accessToken`, `refreshToken`, `idToken`, `apiKey`, plus per-provider `providerSpecificData` secrets (cookies etc.). Keep the list in one frozen export; over-encrypting breaks non-secret consumers (`SortableConnectionRow`, quota probes) and under-encrypting fails the plaintext scan.
- Raw-SQL bypass points that must decrypt or stay envelope-opaque:
  - `src/lib/auth/gatewayResources.js` `decodeRow` — gateway reads connections/nodes directly; decrypt here or route through repos.
  - `src/lib/db/index.js` `exportDb` (line ~272) — spreads `parseJson(r.data)`; with encryption it emits envelopes (ciphertext export, correct per ADR).
  - `src/lib/db/helpers/gatewayKeyTransfer.js` — v2 snapshot export/apply moves `data` as opaque JSON (envelopes survive untouched) and its `assertNoSecretFields` sees no raw secret names once values are envelopes; verify, don't assume.

### Phase 4 — Settings + MITM re-key

- Encrypt `oidcClientSecret`, `samlPrivateKey`, `samlDecryptionKey`, `samlSigningKey` (all in `DEFAULT_SETTINGS`, `settingsRepo.js`) under the Default workspace DEK. These already sit in `SECRET_SETTING_KEYS` (`src/lib/settingsConfigDoc.js:64`), so config-export redaction keeps working.
- `mitmSudoEncrypted`: replace machine-id-derived key (`ENCRYPT_SALT = "9router-mitm-pwd"`, `encryptPassword`/`decryptPassword` at `src/mitm/manager.js:273-292`) with Default-DEK encryption. Keep a legacy decrypt fallback for pre-migration values until the migration rewrites them; retire the salt path after (ADR follow-up).
- `settings` is class `instance` in tenancy — Default workspace DEK is the right key; do not mint a per-setting key.

### Phase 5 — Migration (switch-on only, backup-gated, irreversible)

- Runs once, only when `isMultiUserEnabled()`; mirror `activateGatewayKeys.js`: pre-mutation **protected** backup (`makeProtectedBackupDir`, exempt from newest-3 prune), validated snapshot before any write, then a single transaction: create/ensure DEK per workspace (Default DEK for legacy NULL-`workspaceId` rows), wrap under KEK, rewrite secret fields, stamp a durable `_meta` marker (e.g. `credentialsEncryptedVersion`) as the one-way latch and idempotency guard.
- Re-run safe: rows already envelopes are skipped (`isEnvelope`), `workspaceKeys` upserted not duplicated.
- Wire into `src/lib/db/startupReadiness.js` `defaultActivation` after `ensureOwnerBootstrap` + `activateGatewayKeys`, before serving (sticky reject on failure, same contract).
- **Latch semantics (critical, user requirement):** once the marker is written, `TOKENHOP_MULTI_USER=off` must NOT decrypt anything — reads still decrypt, writes still encrypt, missing KEK still fails closed. This is exactly the YAN-363 durable-security latch (`tests/unit/gateway-key-established-security.test.js` precedent). "Off = exactly today" applies only to never-enabled instances.

### Phase 6 — Crypto-shredding

- `workspacesRepo.deleteWorkspace` (raw `DELETE FROM workspaces`) already relies on FK cascade; `workspaceKeys.workspaceId REFERENCES workspaces(id) ON DELETE CASCADE` gives DEK destruction for free — but only where `PRAGMA foreign_keys=ON` holds (`migrate.js` re-enables it; verify the driver keeps it on for the running adapter, else add an explicit `DELETE FROM workspaceKeys WHERE workspaceId = ?`).
- User deletion → personal workspace deletion path must hit the same cascade. Clear the DEK cache for the workspace (`clearWorkspace`).

### Phase 7 — Rotation (scope-split, see Key Decisions)

- Ship the primitive here: `rotateKek(kekNew)` = new KEK, rewrap every `workspaceKeys.wrappedDek` in one transaction (O(workspaces), field ciphertext untouched, byte-identical — ADR). Per-DEK rotation = fresh DEK + re-encrypt that workspace's fields; defer (Improvement Ideas).
- **KEK rotation MUST preserve the YAN-363 API-key hash key.** `deriveApiKeyHashKey(master)` (`masterKey.js`) feeds `apiKeys.keyHash`, and `activateGatewayKeys.js:200` plus `loadMasterKey({expectedKid: _meta.apiKeysHashKid})` fail closed on any KEK mismatch — a KEK rotated without pinning `hashKid` either bricks API-key verification (wrong root fails closed at restart) or silently invalidates every stored hash. Raw API keys are not stored post-activation, so hashes cannot be recomputed under a new root. Therefore the hash key must be preserved, not re-derived: on rotation, derive the hash key from the OLD master once, store it wrapped under the NEW KEK (own row, e.g. `workspaceKeys`-style `instanceKeys` or `_meta` envelope; never plaintext), and have `loadMasterKey`/`activateGatewayKeys` obtain the hash key from that wrapped value while `_meta.apiKeysHashKid` keeps naming the hash-key id (decoupled from the KEK id). Changes needed in `activateGatewayKeys.js:264-266` and the `importDb` root proof (`db/index.js` `loadMasterKey` kid check). Add a test: rotate KEK → previously issued gateway key still authenticates after restart.
- Admin API surface minimal; the `tokenhop keys rotate` CLI is ADR-assigned to YAN-377.

### Phase 8 — Tests (minimal, all app-relevant; issue's list)

Write against existing harnesses: `tests/setup/tenancyHarness.js`, `tests/unit/gateway-key-activation.test.js` (backup-gated migration pattern), `tests/unit/background-token-refresh.test.js` (refresh path).

1. Round-trip: write via repo → DB row holds envelopes, plaintext absent from the DB file; read returns plaintext.
2. AAD tamper + row swap: swap `rowId`/`workspaceId` between envelopes → integrity failure, never wrong plaintext.
3. KEK rotation: rewrap; field ciphertext bytes unchanged; decrypt still works.
4. Missing KEK: fail fast with clear `[master-key]` error; never a silent plaintext write.
5. Migration fixture: legacy plaintext DB → encrypted once; second run is a no-op (idempotent); requires backup-present precondition.
6. Refresh path: token rotation inside `updateProviderConnectionUnscoped` transaction still works on encrypted rows.
7. Plaintext scan: post-migration DB file (and WAL) contains no known secret substrings.
8. Switch-off regression: off + never-enabled → no `workspaceKeys` rows, `data` byte-identical plaintext, behavior unchanged (CI matrix already runs both states).
9. Latch (established encryption after disable): marker set + `TOKENHOP_MULTI_USER=off` → still encrypts writes, decrypts reads, no plaintext regression.
10. Workspace delete: `workspaceKeys` row gone + DEK cache cleared; backup ciphertext undecryptable (missing DEK) even with the KEK.
11. Rotate vs API-key hashes: rotate KEK, restart → previously issued gateway key still authenticates; `_meta.apiKeysHashKid` consistent; `importDb` root proof still passes.
12. Default workspace guard: deleting the Default workspace is refused (or instance secrets survive under the instance DEK); Default DEK rotation leaves `oidcClientSecret`/SAML/`mitmSudoEncrypted` decryptable.
13. AAD: each of `table`, `rowId`, `workspaceId`, `field` substituted individually fails authentication.

## Improvement Ideas (defer nonrequired)

- Per-DEK rotation UX (workspace-scoped re-encrypt) — rewrap-only satisfies the issue; defer field re-encryption.
- Passphrase-wrapped export — explicitly the hardening issue, not here.
- `disabledModels` export drop fix — YAN-375 owns it.
- Field-level plaintext-in-memory TTL cache beyond DEK cache — marginal win, real leak risk.
- Auto KEK backup reminder surfacing in UI beyond the enable-time doc string — YAN-379 scope.
- Key-checks (kid pinning per row) beyond envelope `kid` — envelope already carries `kid`; per-row KEK history can wait for rotation history needs.

## Risk Assessment

| Risk                                                                        | Severity            | Grounding / mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| KEK loss = total credential loss, no recovery                               | Critical, by design | Documented at enable + YAN-379; Docker must persist `DATA_DIR/keys/master` or set `TOKENHOP_MASTER_KEY`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Raw-SQL readers bypass repo encryption                                      | High                | `gatewayResources.js:57-70`, `db/index.js:280-296` (`exportDb`), `gatewayKeyTransfer.js:223-258,969-996` — enumerate and cover each in Phase 3 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `importDb` legacy wipe list doesn't know `workspaceKeys`                    | High                | `db/index.js:455-461` — stale DEKs survive import into a wiped DB; coordinate with YAN-375, or add the wipe + reject-here guard                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Rotation/refresh transaction broken by async crypto                         | Medium              | node:crypto is sync; forbid awaits between `updateInTx` encrypt and commit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Over/under-encryption of `providerSpecificData`                             | Medium              | single frozen allowlist; plaintext-scan test is the backstop                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Mixed plaintext/ciphertext misread                                          | Medium              | `isEnvelope` probe + migration fixture test; re-encryption of already-encrypted rows skipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| MITM portability regression                                                 | Medium              | machine-id key currently travels with cli-data-migrate; DEK-bound value breaks cross-instance restore — keep legacy `decryptPassword` fallback until migration rewrites                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| FK cascade off at runtime → no shredding                                    | Medium              | verify driver `PRAGMA foreign_keys`; else explicit DELETE in `deleteWorkspace`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Switch-off decrypts established data                                        | Critical if missed  | durable `_meta` latch (Phase 5); test #9                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Plaintext lingers in WAL/backups post-migration                             | Medium              | scan test includes WAL; pre-migration protected backup intentionally keeps plaintext (manual-retention contract, `backup.js` header)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Cache holds DEKs for deleted workspaces                                     | Low                 | `clearWorkspace` on delete; bounded cache                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **KEK rotation breaks YAN-363 API-key hashes**                              | Critical            | `deriveApiKeyHashKey` HKDFs from the master; `activateGatewayKeys.js:200,264-266` and `importDb` require `kid === _meta.apiKeysHashKid`. Rotating the KEK without preserving the hash key bricks startup or invalidates all gateway keys; raw keys are gone so hashes can't be recomputed. Mitigation: persist the hash key wrapped under the new KEK, decouple hash-key id from KEK id (Phase 7); test "gateway key still authenticates after rotate + restart"                                                                                                                                                                                                                                                               |
| **Default workspace deletion / Default DEK rotation hits instance secrets** | High                | Instance secrets (`oidcClientSecret`, SAML keys, `mitmSudoEncrypted`) are encrypted under the Default workspace DEK (Phase 4). Default is a _shared_ workspace (`bootstrap.js:150-151`) and `deleteWorkspace` (`workspacesRepo.js:85`) only blocks `personal` kind — deleting Default cascades `workspaceKeys` and permanently destroys SSO/SAML/MITM secrets. Per-DEK rotation of Default must re-encrypt settings secrets in the same transaction. Mitigation: refuse to delete the workspace whose id is `_meta.defaultWorkspaceId`; or put instance secrets under a dedicated instance DEK (cleaner, see Key Decisions #7)                                                                                                 |
| **Crypto-shred cannot erase old backups, WAL, or pre-activation plaintext** | High                | Shredding the DEK only protects ciphertext. Plaintext copies persist in: protected pre-migration backup (`backup.js` `PROTECTED_BACKUP_PREFIX`, never auto-pruned, raw by design), `pre-import-*` backups, newest-3 safety backups taken pre-migration, `gateway-key-activation-*` backups, un-checkpointed `-wal`/`-shm` and freed SQLite pages (`wal_checkpoint(TRUNCATE)` in adapters shrinks WAL but doesn't zero freed pages — consider `VACUUM`/`secure_delete` after migration), prior `exportDb` JSON files. Must be documented honestly (YAN-379): shredding applies to post-encryption data only; add a post-migration instruction/CLI hint to delete or re-encrypt retained plaintext backups. Do not claim erasure |

## Alternative Approaches

- **Whole-DB encryption (SQLCipher)** — rejected by ADR-0008: new native dependency (handbook §8 forbids), no per-workspace shredding, same KEK problem.
- **Single instance-wide field key** — rejected: no crypto-shredding per workspace; rotation is O(rows).
- **OS keychain KEK** — rejected: headless/Docker targets; 0600 file equivalent for the threat model.
- **Separate ciphertext columns per secret field** — rejected vs in-JSON envelopes: schema churn across providers, breaks `data` JSON consumers; envelope-in-place keeps row shape stable.
- **Encrypt in adapters/driver layer** — rejected: repo chokepoints (`rowToConn`/`connToRow`, `nodeToRow`/`rowToNode`) are fewer and typed; driver layer can't know field sensitivity or workspace AAD.

## Task Breakdown Preview

1. `src/lib/security/envelope.js` — wrap/unwrap/encrypt/decrypt/isEnvelope + bounded DEK cache (Phase 1). Unit tests 1-4.
2. Migration `013-workspace-keys.js` + `TABLES.workspaceKeys` + tenancy classification (Phase 2).
3. `connectionsRepo`/`nodesRepo` chokepoint encrypt/decrypt + secret-field allowlist + mixed-state read (Phase 3). Tests 1, 2, 6.
4. Cover raw-SQL readers: `gatewayResources.decodeRow` decrypt; `exportDb` envelope carry; `gatewayKeyTransfer` opacity check (Phase 3).
5. Settings secrets + MITM re-key with legacy fallback (Phase 4).
6. Backup-gated idempotent migration + `_meta` latch + `startupReadiness` wiring (Phase 5). Tests 5, 7, 9.
7. Shredding: FK cascade verify/explicit delete + cache clear (Phase 6). Test 10.
8. KEK rewrap primitive + minimal admin API (Phase 7). Test 3.
9. Switch-off regression suite + CI both states (Phase 8). Test 8.

## Key Decisions Needed

1. **Rotation scope split:** issue #233 lists `tokenhop keys rotate` (CLI + admin API) in YAN-365 scope, but ADR-0008 assigns the CLI to YAN-377. Recommend: YAN-365 ships the rewrap primitive + admin API hook, YAN-377 ships the CLI command. Confirm with maintainer.
2. **Latch semantics on switch-off:** confirm "established encryption remains protected after disable" = YAN-363-style durable marker (reads/writes stay encrypted even with `TOKENHOP_MULTI_USER=off`; missing KEK fails closed). This slightly amends "off = exactly today" for previously-enabled instances.
3. **AAD shape (decided):** `table|rowId|workspaceId|field` per issue #233. ADR-0008's `connectionId|workspaceId` is superseded; update the ADR text to match.
4. **`workspaceKeys` in export/import:** YAN-375 owns transfer parity, but `importDb`'s legacy wipe path silently keeps stale DEKs. Decide: minimal guard in YAN-365 (wipe/reject on import when the latch is set) vs full carry in YAN-375.
5. **Secret-field allowlist home:** frozen export in `envelope.js` vs provider registry metadata. Recommend registry-derived single frozen list.
6. **DEK cache bound:** cap value (e.g. 256 workspaces) and eviction policy.
7. **Instance-secret key home:** Default workspace DEK (ADR-0008, but couples SSO/SAML/MITM secrets to deletable/rotatable Default) vs a dedicated instance DEK row. Recommend: guard Default deletion at minimum; prefer the instance DEK if ADR amendment is acceptable.
8. **Hash-key preservation mechanism:** wrapped hash key persisted under the new KEK (recommended) vs retaining the old KEK as a permanent hash root. Needed before Phase 7 can ship.
9. **Shred claim scope:** confirm docs wording limits crypto-shredding to post-encryption ciphertext; decide whether to run `VACUUM`/`secure_delete` after the migration.

## Open Questions

- Does the running adapter keep `PRAGMA foreign_keys=ON` (driver.js) so `ON DELETE CASCADE` shreds `workspaceKeys`, or is an explicit DELETE required?
- Which `providerNodes.data` fields are secrets (per node type)? Node registry field inventory needed before the allowlist freezes.
- Does the v2 hashed snapshot's `assertNoSecretFields` need updating once `data` carries envelopes (values, not field names, change)?
- Migration ordering vs YAN-375: if 375 lands first, does the encryption migration run before or after a transfer-format bump?
- Should the pre-encryption protected backup use a new prefix (e.g. `credential-encryption-`) distinct from `gateway-key-activation-` for its manual-retention contract?
- Refresh-worker behavior during the migration transaction on a live instance: does `backgroundTokenRefresh` need a readiness gate until the migration commits?

## Relevant Files

- `src/lib/security/masterKey.js` — KEK loader to reuse (YAN-363)
- `src/lib/db/repos/connectionsRepo.js` / `nodesRepo.js` — encrypt/decrypt chokepoints; refresh transaction
- `src/lib/db/schema.js`, `src/lib/db/migrations/` — `workspaceKeys` DDL (next: 013)
- `src/lib/db/tenancy.js` — table classification (guard test dependency)
- `src/lib/db/startupReadiness.js`, `src/lib/db/activateGatewayKeys.js` — switch-gated startup + backup-gated irreversible-migration precedent
- `src/lib/db/index.js` (`exportDb`/`importDb`), `src/lib/db/helpers/gatewayKeyTransfer.js` — raw-SQL readers/writers, transfer parity (YAN-375 boundary)
- `src/lib/auth/gatewayResources.js` — gateway raw reads of connections/nodes
- `src/lib/db/backup.js` — protected pre-mutation backup pattern
- `src/lib/settingsConfigDoc.js` (`SECRET_SETTING_KEYS`), `src/lib/db/repos/settingsRepo.js` — settings secrets
- `src/mitm/manager.js` — legacy machine-id encryption to retire
- `src/lib/users/featureSwitch.js` — the only switch reader
- `tests/setup/tenancyHarness.js`, `tests/unit/gateway-key-activation.test.js`, `tests/unit/gateway-key-established-security.test.js` — test patterns to extend
- ADR: `docs/users/adr/0008-encryption-at-rest.md`; spec decisions 8, 9, 10, 52 (`docs/users/spec.md`); handbook §5/§8 (`docs/users/README.md`)
