# Plan: YAN-365 Envelope Encryption of Credentials at Rest

## Summary

Encrypt provider/node/SSO/MITM secret leaves with workspace DEKs, wrapped by existing master KEK. Ship backup-gated activation, atomic refresh persistence, live DEK destruction, crash-recoverable KEK/file publication, per-workspace rotation, owner-only CLI/admin operations and encrypted snapshot restore. Preserve gateway hash keys and established protection regardless of rollout switch; never-enabled switch-off installs remain unchanged.

## User Story

As an instance owner, I want credentials encrypted and safely rotatable/restorable, so leaked DB copies expose no covered secrets and key operations never invalidate existing gateway clients or destroy recoverable live data.

Additional outcomes: workspace members cannot swap ciphertext across rows/fields/workspaces; OAuth refresh remains durable; owners with env-managed roots get refusal plus safe conversion guidance; single-user installs gain no key duty until activation.

## Problem → Solution

Current SQLite JSON stores secrets, gateway raw readers bypass repos, and master-derived HMAC hashes cannot survive changing master. Use one strict field codec and sync storage seam; wrap the existing **derived hash key**, distinguish frozen hash identity from current KEK identity, preflight restore before any backup/wipe, and publish file/DB rotation through durable recovery states rather than pretend SQLite can transact filesystem rename.

## Metadata

- **Complexity**: XL (small crypto implementation; high-risk cross-system persistence integration).
- **Source PRD**: `docs/plans/yan-365-envelope-encryption/feature-spec.md` (GH #233 / Linear YAN-365).
- **PRD Phase**: M2 credentials encryption; full issue checklist, not later-issue deferrals.
- **Estimated Files**: approximately 70 potential source/test paths; edit only confirmed seams, not every reviewed caller.
- **Binding decisions**: `docs/plans/yan-365-envelope-encryption/decisions.md` D1–D12; these override stale researcher proposals.
- **Evidence owner**: Parent. Implementation lanes write/run targeted tests; Parent owns final sign-off, PR, review, merge and tracker lifecycle.
- **Execution directory**: `/home/yandy/Projects/github.com/tokenhop/tokenhop-yan-365`.
- **Branch / base**: `feat/yan-365-envelope-encryption`, `origin/master` at `896a77f7`. Existing branch/worktree reused by every task. No new worktree, session move, child branch or per-task worktree annotations.
- **Dependencies**: root + tests installed; dependency diff currently empty. Do not reinstall or add dependencies.
- **Authorization**: execution already authorized through delivery; no plan approval wait.

## Batches

Tasks within a batch run concurrently only under exclusive ownership below. All tasks share existing checkout; batches run in order. Tests lane authors integration tests in B2 against fixed B1 interfaces; expected red results there are not passing evidence.

| Batch | Tasks              | Depends On         | Parallel Width |
| ----- | ------------------ | ------------------ | -------------- |
| B1    | 1.1                | none               | 1              |
| B2    | 2.1, 2.2, 2.3, 2.4 | 1.1                | 4              |
| B3    | 3.1                | 2.1, 2.2, 2.3, 2.4 | 1              |
| B4    | 4.1                | 3.1                | 1              |
| B5    | 5.1                | 4.1                | 1              |
| B6    | 6.1                | 5.1                | 1              |
| B7    | 7.1                | 6.1                | 1              |

- **Total tasks**: 10.
- **Total batches**: 7.
- **Max parallel width**: 4.
- **Owners**: F foundation; R provider runtime; S settings/MITM; O shared operations; T integration tests; Parent validation/delivery.
- **Conflict rule**: one writer per file in each batch. B2 T exclusively owns new activation/lifecycle tests and transfer/import tests; R/S/O own distinct existing targeted tests. B3+ O may extend T's files only after T completes. Parent assigns review fixes after concurrent lanes stop.
- **No partial activation rollout**: do not enable new startup path or rotate production fixtures before all nine hash-consumer paths, codec seams and v3 transfer are integrated. Batches are execution order, not separately releasable PRs.

## UX Design

### Before

```text
Stored credentials: readable SQLite JSON
Backup/export: credentials travel in plaintext
Key rotation: no command/API
Legacy MITM sudo: machine-derived cipher
```

### After

```text
First enable: private verified backup, encrypt, cleanup, readiness
keys rotate [--workspace ID] [--port PORT] [--yes]
Confirmation (default No), verified receipt, key-backup reminder
Env KEK rotate: 409 + same-key file-conversion guidance
Restore: root/key-graph proof before backup or wipe
```

### Interaction Changes

| Touchpoint         | Before                  | After                                      | Notes                                                                                        |
| ------------------ | ----------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Activation         | no key duty             | startup path/kid/counts + backup warning   | automatic; protected plaintext backup deliberately retained                                  |
| KEK / DEK rotation | absent                  | CLI and two owner APIs                     | no dashboard UI; `--yes` only optional confirmation bypass                                   |
| Env root           | no rotation contract    | `409 KEK_ENV_MANAGED` before mutation      | workspace DEK rotation remains available                                                     |
| Missing/wrong root | plaintext boot          | sticky readiness rejection                 | no serve, no new root; restore matching root/backup                                          |
| Per-row integrity  | opaque provider failure | uniform typed credential-use failure       | metadata lists still work; no new badge/UI                                                   |
| Default deletion   | not protected           | `409 DEFAULT_WORKSPACE_PROTECTED` always   | same-transaction guard                                                                       |
| Export/restore     | raw config snapshot     | v3 opaque field envelopes and wrapped keys | key never included; same-root restore; legacy rejection on encrypted instance                |
| Rotation receipt   | absent                  | new kid/counts; back up new master         | previous backups require old key kept **offline by operator**; server retains no retired key |

Warnings and refusal guidance use normal clear language. Do not claim “Nothing was changed” after uncertain commit/publication. No exit-code-78 protocol, recovery-only dashboard, typed-name deletion UI, progress SSE, status endpoint or backup acknowledgment added. D12 supersedes those UX/recommendations proposals.

## Mandatory Reading

| Priority | File                                                                                 | Lines                     | Why                                                 |
| -------- | ------------------------------------------------------------------------------------ | ------------------------- | --------------------------------------------------- |
| P0       | `CLAUDE.md`                                                                          | all                       | JS ESM, test isolation, module boundaries           |
| P0       | `docs/ARCHITECTURE.md`                                                               | 134–154, 246–276, 467–480 | SQLite, refresh and auth                            |
| P0       | `docs/plans/yan-365-envelope-encryption/decisions.md`                                | all                       | accepted D1–D12 incl. AAD vectors                   |
| P0       | `docs/plans/yan-365-envelope-encryption/verification.md`                             | all                       | C1–C10 and parent evidence contract                 |
| P0       | `docs/plans/yan-365-envelope-encryption/feature-spec.md`                             | all                       | full issue scope                                    |
| P0       | `docs/prps/plans/.prp-research/yan-365-envelope-encryption/security-researcher.md`   | all                       | R1–R20/G1–G20 completeness gaps                     |
| P0       | `docs/prps/plans/.prp-research/yan-365-envelope-encryption/tech-designer.md`         | all                       | ownership and interface seams                       |
| P1       | `docs/prps/plans/.prp-research/yan-365-envelope-encryption/api-researcher.md`        | all                       | authenticated crypto/fs contracts                   |
| P1       | `docs/prps/plans/.prp-research/yan-365-envelope-encryption/business-analyzer.md`     | all                       | US1–US12, A1–A25 backstop                           |
| P1       | `docs/prps/plans/.prp-research/yan-365-envelope-encryption/practices-researcher.md`  | all                       | reuse, naming, isolated fixtures                    |
| P1       | `docs/prps/plans/.prp-research/yan-365-envelope-encryption/ux-researcher.md`         | all                       | operator copy; D12 overrides proposals              |
| P1       | `docs/prps/plans/.prp-research/yan-365-envelope-encryption/recommendations-agent.md` | all                       | delivery sequence; discard retired-key/UI proposals |
| P0       | `src/lib/security/masterKey.js`                                                      | 19–218                    | KEK loader and HKDF                                 |
| P0       | `src/lib/db/startupReadiness.js`                                                     | all                       | sticky readiness before timers                      |
| P0       | `src/lib/db/activateGatewayKeys.js`                                                  | 143–303                   | verified backup, flush, root assumptions            |
| P0       | `src/lib/db/helpers/gatewayKeyTransfer.js`                                           | 204–260, 689–1092         | v2 proof and transactional apply                    |
| P0       | `src/lib/db/adapters/sqljsAdapter.js`                                                | 26–79, 129–161            | delayed persistence vs throwing flush               |
| P0       | `src/lib/db/repos/connectionsRepo.js`                                                | all                       | codecs, dedup, atomic refresh merge                 |
| P0       | `src/lib/db/repos/settingsRepo.js`                                                   | 113–232, 321–325          | raw vs runtime vs export                            |
| P1       | `src/lib/auth/gatewayResources.js`                                                   | 28–72                     | raw gateway decrypt bypass                          |
| P1       | `src/mitm/manager.js`                                                                | 260–358                   | CJS legacy cipher and hooks                         |
| P1       | `tests/setup/tenancyHarness.js`                                                      | all                       | A/B/shared fixtures                                 |
| P1       | `tests/helpers/isolatedHome.js`                                                      | all                       | destructive test safety                             |
| P1       | `RELEASING.md`                                                                       | all                       | read-only branching/release policy                  |
| P1       | `.github/pull_request_template.md`                                                   | all                       | required PR sections                                |

Main-checkout approved handbook/ADRs already researched: `/home/yandy/Projects/github.com/tokenhop/tokenhop/docs/users/README.md`, `spec.md`, `adr/0005-api-keys.md`, `adr/0008-encryption-at-rest.md`. D1–D12 record amendments locally; do not edit main checkout. Full GH #233 already read; dependency status Parent-owned.

## External Documentation

| Topic                       | Source                                                                                                | Key Takeaway                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| GCM primitives/tag length   | <https://nodejs.org/docs/latest-v24.x/api/crypto.html#crypto_createcipheriv_algorithm_key_iv_options> | explicit `authTagLength:16`, key32/IV12; no alternate cipher        |
| AAD / partial plaintext     | <https://nodejs.org/docs/latest-v24.x/api/crypto.html#decipher_setaad_buffer_options>                 | AAD before update; buffer output until authenticated final succeeds |
| Tag verification            | <https://nodejs.org/docs/latest-v24.x/api/crypto.html#decipher_setauthtag_buffer_encoding>            | missing/tampered tag throws; uniform safe error                     |
| CSPRNG / HKDF               | <https://nodejs.org/docs/latest-v24.x/api/crypto.html#crypto_randombytes_size_callback>               | random keys/nonces; HKDF return converted with Buffer.from          |
| Exclusive create / symlinks | <https://nodejs.org/docs/latest-v24.x/api/fs.html#fileopenflags>                                      | `wx`, O_NOFOLLOW, strict size/modes; no unproven overwrite          |
| Publish / durability        | <https://nodejs.org/docs/latest-v24.x/api/fs.html#filehandlesync>                                     | synced stage + directory; rename replace only after durable DB      |
| Live plaintext cleanup      | <https://www.sqlite.org/wal.html> and <https://www.sqlite.org/lang_vacuum.html>                       | checked TRUNCATE, live VACUUM, checkpoint again, cleanup marker     |
| Storage threat model        | <https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html>               | KEK separate from DB; no host/operator protection claim             |
| Rewrap / erasure limits     | <https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html>                      | rewrap before retirement; old backups still need old keys           |

API research verified these contracts; no new library research or dependencies required. Cite D1 for exact UTF-8 AAD vectors rather than duplicate incompatible strings.

## Patterns to Mirror

### NAMING_CONVENTION

```js
// SOURCE: src/lib/db/helpers/metaStore.js:18
export function getMetaSync(adapter, key, fallback = null) {
```

`*Sync(db,...)` helpers are transaction-safe; scoped APIs remain ctx-first and bypass twins explicitly `*Unscoped`. Use `envelope.js` name from accepted spec, not practices lane's alternative filename. No singleton factory/framework.

### ERROR_HANDLING

```js
// SOURCE: src/lib/db/activateGatewayKeys.js:28-29
function fail(code, message) {
  throw Object.assign(new Error(`[gateway-key-activation] ${message}`), { code });
}
```

Use typed `DECRYPT_FAILED`, `KEY_MISSING`/`KEY_MISMATCH`, `KEK_ENV_MANAGED`, `DEFAULT_WORKSPACE_PROTECTED`; no key/IV/tag/token interpolation. Crypto parser/tag/AAD errors share safe public code/message. Established key errors never return original input, null/default secret or plaintext.

### LOGGING_PATTERN

```js
// SOURCE: src/sse/services/tokenRefresh.js:199-202
log.info("TOKEN_REFRESH", "Credentials updated in localDb", {
  connectionId,
  success: !!result,
});
```

Audit actor/operation/kids/counts/result only. No field ciphertext/wraps/key bytes in logs/audit/rotation HTTP. Raw full-DB download intentionally carries opaque envelopes, not plaintext key material.

### REPOSITORY_PATTERN

```js
// SOURCE: src/lib/db/repos/connectionsRepo.js:334-338
const db = await getAdapter();
return db.transaction(() =>
  updateInTx(db, db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]), data),
);
```

Preserve sync callback. Prepare filesystem/root before callback; current row, PSD delta merge, DEK lookup/encryption and SQL remain inside. Caller envelope objects rejected; mode `migration` trusted internal only.

### SERVICE_PATTERN

```js
// SOURCE: src/lib/db/startupReadiness.js:63-66
await acquire(hooks.dataDir ?? DATA_DIR);
const db = await openDb();
await activate(db);
state.ready = true;
```

One startup owner, cycle-free storage helpers; failed promise remains sticky. Maintenance after startup needs admission poisoning too: resolved startup promise alone cannot close an already-serving process.

### TEST_STRUCTURE

```js
// SOURCE: tests/unit/gateway-key-activation.test.js:10-12
import { activateGatewayKeys } from "@/lib/db/activateGatewayKeys.js";
import { createSqlJsAdapter } from "@/lib/db/adapters/sqljsAdapter.js";
import { runMigrationOnce } from "@/lib/db/migrate.js";
```

Use installed Vitest and real isolated adapters, `seedTenancy`, `assertIsolatedHome`. Tests first; no checked-in binary DB, live providers or testing framework additions.

### Fixed integration contracts

| Seam            | Contract fixed in B1 before parallel work                                                                                                                                                                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure crypto     | `buildAad({table,rowId,workspaceId,field})`, `encryptBytes(key,kid,plain,aad)`, `decryptBytes(key,envelope,aad)`; strict exact `{v,kid,iv,ct,tag}`, canonical base64, max decoded secret/ct 64 KiB, encoded bound before allocation; random IV12, explicit tag16; plaintext only after final        |
| State           | `readCredentialEncryptionState(db)` sync, returns legacy/encrypted + kekKid + cleanupPending + pendingRotation; half/corrupt marker throws; unexpected key rows/envelopes without coherent state not legacy                                                                                         |
| Storage         | `prepareCredentialContext(db,root)` memory-only; `decodeCredentialRowSync(db,row,ctx,{mode})`, `encodeCredentialRowSync(db,row,ctx)`, `ensureWorkspaceDekSync(db,workspaceId,ctx)`, `clearCredentialCache(db,workspaceId?)`; mode runtime/metadata/migration, no caller-controlled migration bypass |
| DEK cache       | DEKs only, cap128 + TTL, adapter/workspace/kid/wrapped-generation keyed; every hit verifies live row; no orphan rollback cache; Buffer zero best effort                                                                                                                                             |
| Hash continuity | `getApiKeyHashKey(db,{root?})` async facade / `resolveApiKeyHashKeySync(db,root)` sync proof; immutable original hash identity, current `credentialsKekKid`; preserve **derived key**, never old master                                                                                             |
| Settings        | `getSettings({secretMode:'metadata'})` non-secret/presence-aware without root; trusted default runtime decrypts; `getMultiUserEnabledSettingRaw()` narrow boolean; `exportSettings()` raw opaque (minus local verifier)                                                                             |
| Maintenance     | `runCredentialMaintenanceSync(db,fn)`, `assertCredentialOperationAllowed(db)`, `poisonCredentialMaintenance(db,error)`; synchronous lexical privilege, no public bypass flag; poison blocks raw adapter mutations and credential admission until restart                                            |
| Activation      | `activateCredentialEncryption(db,{enabled,beforeServing,root?})`; trusted startup-only options; separate additive schema vs irreversible activation                                                                                                                                                 |
| Operations      | `recoverKeyRotation(db)`, `rotateKek(db)`, `rotateWorkspaceDek(db,workspaceId)`; async preparation, then non-yielding sync commit/publication critical section                                                                                                                                      |
| MITM CJS        | `initDbHooks(getSettings,updateSettings,isEncryptionEstablished)` optional third callback; explicit mode, not secret-string shape; legacy math extracted side-effect-free                                                                                                                           |
| Snapshot        | formatVersion3, `credentialEncryption:{version:1,kekKid,apiKeyHashKeyWrapped}`, raw `workspaceKeys`; existing v1/v2 unencrypted semantics retained                                                                                                                                                  |

No crypto/state/storage helper imports DB barrel, driver, featureSwitch, session, owner bootstrap or readiness. Outer repo/startup facade owns async root loading; recheck live generation after awaits. Pure codec uses only Node crypto. Shared D10 allow-list drives both encryption and redaction.

---

## Files to Change

Paths below are exclusive by batch; untouched review-only callers stay out. Rows marked CREATE are new.

| File                                                  | Action | Justification                                                      |
| ----------------------------------------------------- | ------ | ------------------------------------------------------------------ |
| `src/lib/security/envelope.js`                        | CREATE | F 1.1 pure AES-GCM codec, D1 builder, D10 allow-list               |
| `src/lib/db/credentialEncryptionState.js`             | CREATE | F 1.1 strict marker/state reader                                   |
| `src/lib/db/helpers/credentialStorage.js`             | CREATE | F 1.1 sync row codec, DEK cache/wrap helpers                       |
| `src/lib/db/migrations/013-workspace-keys.js`         | CREATE | F 1.1 additive key table only                                      |
| `src/lib/db/schema.js`                                | UPDATE | F 1.1 `workspaceKeys` in TABLES                                    |
| `src/lib/db/migrations/index.js`                      | UPDATE | F 1.1 register next migration                                      |
| `src/lib/db/tenancy.js`                               | UPDATE | F 1.1 classify new scoped table                                    |
| `tests/unit/envelope-crypto.test.js`                  | CREATE | F 1.1 C2 vectors/tamper/swap/oracle tests                          |
| `tests/unit/db-migration-chain.test.js`               | UPDATE | F 1.1 assert chain/shape and order after 002/003                   |
| `tests/unit/tenancy-guard.test.js`                    | UPDATE | F 1.1 only if classification assertion needs explicit addition     |
| `src/lib/db/repos/connectionsRepo.js`                 | UPDATE | R 2.1 encrypted insert/update/read/dedup                           |
| `src/lib/db/repos/nodesRepo.js`                       | UPDATE | R 2.1 node secret leaves                                           |
| `src/lib/auth/gatewayResources.js`                    | UPDATE | R 2.1 decrypt raw principal/unscoped paths                         |
| `src/lib/users/workspaceScope.js`                     | UPDATE | R 2.1 shared metadata redaction                                    |
| `src/sse/services/tokenRefresh.js`                    | UPDATE | R 2.1 minted `apiKey`, durable failure propagation                 |
| `src/app/api/providers/[id]/test/testUtils.js`        | UPDATE | R 2.1 delta refresh writes                                         |
| `src/sse/services/quotaSnapshotSync.js`               | UPDATE | R 2.1 stale PSD writer, only if confirmed                          |
| `src/sse/services/auth.js`                            | UPDATE | R 2.1 refresh/clear callback seam, only if confirmed               |
| `src/sse/handlers/chat.js`                            | UPDATE | R 2.1 refresh delta if stale PSD assembled                         |
| `src/sse/handlers/videoGeneration.js`                 | UPDATE | R 2.1 refresh delta if stale PSD assembled                         |
| `src/sse/handlers/fetch.js`                           | UPDATE | R 2.1 refresh delta if stale PSD assembled                         |
| `src/sse/handlers/search.js`                          | UPDATE | R 2.1 refresh delta if stale PSD assembled                         |
| `src/sse/handlers/imageGeneration.js`                 | UPDATE | R 2.1 refresh delta if stale PSD assembled                         |
| `src/sse/handlers/embeddings.js`                      | UPDATE | R 2.1 refresh delta if stale PSD assembled                         |
| `src/app/api/providers/route.js`                      | UPDATE | R 2.1 metadata-mode response only if needed                        |
| `src/app/api/providers/[id]/route.js`                 | UPDATE | R 2.1 metadata-mode response only if needed                        |
| `src/app/api/provider-nodes/route.js`                 | UPDATE | R 2.1 metadata-mode response only if needed                        |
| `src/app/api/provider-nodes/[id]/route.js`            | UPDATE | R 2.1 metadata-mode response only if needed                        |
| `tests/unit/token-refresh-generic.test.js`            | UPDATE | R 2.1 C8 refresh unit cases                                        |
| `tests/unit/connection-ownership.test.js`             | UPDATE | R 2.1 scoped/encrypted repo cases                                  |
| `src/lib/db/repos/settingsRepo.js`                    | UPDATE | S 2.2 runtime/metadata/raw settings modes                          |
| `src/lib/users/featureSwitch.js`                      | UPDATE | S 2.2 narrow switch read, no decrypt cycle                         |
| `src/lib/db/configExport.js`                          | UPDATE | S 2.2 opaque settings preservation; portable doc secret-free       |
| `src/lib/db/repos/combosRepo.js`                      | UPDATE | S 2.2 opaque raw settings writer                                   |
| `src/lib/db/repos/workspaceSettingsRepo.js`           | UPDATE | S 2.2 opaque raw settings writer                                   |
| `src/lib/savingsMilestones.js`                        | UPDATE | S 2.2 opaque raw settings writer                                   |
| `src/lib/users/bootstrap.js`                          | UPDATE | S 2.2 secret presence without root                                 |
| `src/lib/users/ssoProvisioning.js`                    | UPDATE | S 2.2 metadata settings mode                                       |
| `src/lib/users/invitationAccept.js`                   | UPDATE | S 2.2 metadata settings mode                                       |
| `src/lib/auth/gatewayAuth.js`                         | UPDATE | S 2.2 metadata settings mode                                       |
| `src/app/api/settings/route.js`                       | UPDATE | S 2.2 redacted configured flags; secrets never returned            |
| `src/app/api/settings/validateSettings.js`            | UPDATE | S 2.2 lockout presence without exposure                            |
| `src/lib/auth/oidc.js`                                | UPDATE | S 2.2 trusted runtime secret read                                  |
| `src/app/api/auth/oidc/test/route.js`                 | UPDATE | S 2.2 trusted runtime secret read                                  |
| `src/mitm/manager.js`                                 | UPDATE | S 2.2 established sudo path, explicit errors                       |
| `src/mitm/legacyPasswordCrypto.cjs`                   | CREATE | S 2.2 extract existing strict legacy decrypt                       |
| `src/shared/services/initializeApp.js`                | UPDATE | S 2.2 inject encryption-state callback                             |
| `src/app/api/cli-tools/antigravity-mitm/route.js`     | UPDATE | S 2.2 inject encryption-state callback                             |
| `src/app/api/tunnel/tailscale-install/route.js`       | UPDATE | S 2.2 inject encryption-state callback                             |
| `src/lib/tunnel/tailscale/manager.js`                 | UPDATE | S 2.2 inject encryption-state callback                             |
| `tests/unit/settings-secret-leaks.test.js`            | UPDATE | S 2.2 raw writer/redaction cases                                   |
| `tests/unit/antigravity-mitm-credential.test.js`      | UPDATE | S 2.2 MITM legacy/established cases                                |
| `src/lib/security/apiKeyHashKey.js`                   | CREATE | O 2.3 single stable hash-key getter                                |
| `src/lib/db/credentialMaintenance.js`                 | CREATE | O 2.3 maintenance admission and poisoning                          |
| `src/lib/security/masterKey.js`                       | UPDATE | O 2.3/4.1 safe sync root primitives; loader semantics retained     |
| `src/lib/db/driver.js`                                | UPDATE | O 2.3 adapter mutation admission                                   |
| `src/lib/db/activateGatewayKeys.js`                   | UPDATE | O 2.3 root check by current KEK + unwrap                           |
| `src/lib/auth/apiKeyPrincipal.js`                     | UPDATE | O 2.3 hash path 1                                                  |
| `src/lib/users/apiKeyManagement.js`                   | UPDATE | O 2.3 hash path 2                                                  |
| `src/lib/db/repos/cliToolSettingsRepo.js`             | UPDATE | O 2.3 hash path 3                                                  |
| `src/lib/db/repos/usageRepo.js`                       | UPDATE | O 2.3 hash path 4                                                  |
| `src/app/api/cli-tools/codex-settings/route.js`       | UPDATE | O 2.3 hash path 5                                                  |
| `tests/unit/api-key-hash-key.test.js`                 | CREATE | O 2.3 hash getter and admission unit cases                         |
| `tests/unit/credential-encryption-activation.test.js` | CREATE | T 2.4 then O C1/C3/C4/C10                                          |
| `tests/unit/credential-encryption-lifecycle.test.js`  | CREATE | T 2.4 then O C5–C8                                                 |
| `tests/unit/gateway-key-transfer.test.js`             | UPDATE | T 2.4 then O C9                                                    |
| `tests/unit/db-import-backup.test.js`                 | UPDATE | T 2.4 then O C4                                                    |
| `src/lib/db/activateCredentialEncryption.js`          | CREATE | O 3.1 backup-gated activation and cleanup                          |
| `src/lib/db/migrations/encryptCredentials.js`         | CREATE | O 3.1 sync pure activation helper, not registered schema migration |
| `src/lib/db/startupReadiness.js`                      | UPDATE | O 3.1/4.1 recovery/root/activation ordering                        |
| `src/lib/db/backup.js`                                | UPDATE | O 3.1 private protected prefixes                                   |
| `src/lib/db/migrate.js`                               | UPDATE | O 3.1 reject legacy JSON import under encrypted marker             |
| `src/lib/db/repos/workspacesRepo.js`                  | UPDATE | O 3.1 Default guard and post-commit eviction                       |
| `src/lib/db/repos/usersRepo.js`                       | UPDATE | O 3.1 personal deletion eviction and opaque password mirror        |
| `src/lib/security/keyRotation.js`                     | CREATE | O 4.1 KEK/DEK rotation and recovery                                |
| `src/lib/db/index.js`                                 | UPDATE | O 5.1 v3 export/import and root proof path 7                       |
| `src/lib/db/helpers/gatewayKeyTransfer.js`            | UPDATE | O 5.1 hash paths 8–9, v3 preflight/apply                           |
| `src/app/api/settings/keys/rotate/route.js`           | CREATE | O 6.1 owner KEK route                                              |
| `src/app/api/workspaces/[id]/keys/rotate/route.js`    | CREATE | O 6.1 owner DEK route                                              |
| `src/lib/auth/routePolicy.js`                         | UPDATE | O 6.1 deny-by-default policy rows                                  |
| `tests/unit/route-policy.test.js`                     | UPDATE | O 6.1 new route policy assertions                                  |
| `cli/cli.js`                                          | UPDATE | O 6.1 early `keys rotate` dispatch/help                            |
| `cli/src/cli/api/client.js`                           | UPDATE | O 6.1 two loopback requests                                        |
| `cli/src/cli/commands/keysRotate.js`                  | CREATE | O 6.1 strict flags/confirmation/output                             |

Review-only: `src/lib/db/migrations/002-cursor-refresh-backfill.js`, `003-pin-saml-issuer.js` (immutable shipped), `src/lib/oauth/providers/index.js`, quota pollers and `src/lib/settingsConfigDoc.js`. If review finds needed edit, Parent assigns it to existing lane in a later batch; never concurrent surprise writes. Package manifests/locks, `RELEASING.md` and `CHANGELOG.md` remain unchanged.

## NOT Building

- New dependencies, SQLCipher, keychain/KMS, alternate ciphers or crypto framework/factory.
- Encryption for proxy pools, URL userinfo, passwords/hashes, API-key hashes, MITM verifier, JWT/env secrets, usage or request tables (D10 discovery documented only).
- Old/retired/escrow master file or old master in DB/backup after successful rotation (D12).
- Env-managed two-key rotation protocol (D9 deferred).
- `--dry-run`, `--json`, dashboard acknowledgment, key status, new UI, progress events or locked-connection badge.
- Passphrase-wrapped export, user-aware transfer breadth beyond encrypted secret state (YAN-375), broader CLI user/key/auth UX (YAN-377), docs ownership (YAN-379).
- Release/version/tag/changelog work; no `RELEASING.md` or `CHANGELOG.md` edits.
- Proactive cleanup/rewrite of historical backups/exports/filesystem snapshots, or claims of retroactive crypto-shredding.

---

## Step-by-Step Tasks

All tasks use existing worktree and branch; no task creates/moves worktrees. Before editing, owner reads named file and confirms exclusive scope. Expected-red tests are allowed only inside the same authoring task; batch handoff requires owned target tests green except T's explicitly pending integration tests.

### Task 1.1: Freeze crypto, state and schema contracts — Depends on [none]

- **BATCH**: B1
- **OWNER / WRITE SCOPE**: F. Exclusive: `src/lib/security/envelope.js`, `src/lib/db/credentialEncryptionState.js`, `src/lib/db/helpers/credentialStorage.js`, `src/lib/db/migrations/013-workspace-keys.js`, `src/lib/db/schema.js`, `src/lib/db/migrations/index.js`, `src/lib/db/tenancy.js`, `tests/unit/envelope-crypto.test.js`, `tests/unit/db-migration-chain.test.js`, `tests/unit/tenancy-guard.test.js`.
- **ACTION**: Write C2/schema tests first, then implement only foundation interfaces in Fixed integration contracts.
- **MIRROR**: ERROR_HANDLING, NAMING_CONVENTION, TEST_STRUCTURE; `masterKey.js` strict decode/modes; `apiKeyState.js` paired-marker parser.
- **IMPLEMENT**: Exact D1 vectors/hashes and negative components; D10 allow-list (connections, nested PSD, nodes, five settings) shared with metadata redaction; envelope validation before decode/alloc; GCM only. Migration 013 creates empty `workspaceKeys(workspaceId PK FK CASCADE, kid, wrappedDek, createdAt)` and confirms slot 013 still free. State parser: absent legacy, complete encrypted, cleanup/pending rotation; partial/corrupt throws. Storage helpers sync/adapter-passed; migration mode trusted-internal only; runtime rejects plaintext or caller envelopes; metadata never decrypts.
- **IMPORTS**: `node:crypto`; storage may import pure codec/state/meta/json helpers only.
- **GOTCHA**: Do not import driver/barrel/featureSwitch/readiness. Do not alter global forgiving `parseJson`; strict parser only for credential blobs. No `await` in helpers used by transactions. Additive schema must not activate encryption or create rows when switch off.
- **VALIDATE**: `cd tests && npx vitest run -c vitest.config.js unit/envelope-crypto.test.js unit/db-migration-chain.test.js unit/tenancy-guard.test.js`; assert six D1 strings and SHA-256, each component/tamper/swap fails uniformly, 64 KiB bounds, no plaintext before `final`, no package diff.

### Task 2.1: Integrate provider runtime repos and gateway reads — Depends on [1.1]

- **BATCH**: B2
- **OWNER / WRITE SCOPE**: R. Exclusive: connection/node repos, `gatewayResources.js`, `workspaceScope.js`, `tokenRefresh.js`, provider test utility, confirmed refresh writers `quotaSnapshotSync.js`, `sse/services/auth.js`, six SSE handlers, four provider/node response routes, `token-refresh-generic.test.js`, `connection-ownership.test.js`.
- **ACTION**: Write encrypted repo/refresh/gateway tests, then route every connection/node credential read/write through B1 storage helpers.
- **MIRROR**: REPOSITORY_PATTERN; existing `createInTx`/`updateInTx`; security R7/R9/R13/R19.
- **IMPLEMENT**: Async public wrappers prepare context before sync transactions. `rowToConn/rowToNode`, `upsert`, `createInTx`, `updateInTx`, `deleteInTx` stay synchronous with explicit context. Decrypt current row inside update, merge plaintext patch and explicit null clears, then encrypt. Merge PSD with live siblings, not stale snapshot; never persist caller-supplied envelope objects. OAuth dedup/relogin sees decrypted identity metadata. `gatewayResources` decrypts both principal workspace and allowed unscoped legacy path after SQL selection. Responses use metadata mode with full D10 redaction; one corrupt envelope does not break metadata list. Persist minted `apiKey`; typed integrity/storage failures propagate and refresh does not report durable success.
- **IMPORTS**: B1 storage/state/codec interfaces; root loader only at async facade; no codec in `open-sse` executors.
- **GOTCHA**: A returned Promise from `db.transaction` callback releases savepoint early. Do not add non-null principal fallback that bypasses hashed principal requirement. Do not edit transfer/startup/hash files.
- **VALIDATE**: `cd tests && npx vitest run -c vitest.config.js unit/token-refresh-generic.test.js unit/connection-ownership.test.js unit/background-token-refresh.test.js unit/tenancy-isolation.test.js`; include pair/minted-key/nested Copilot/Kiro refresh, stale queued PSD, raw gateway decrypt, cross-workspace denial and zero-write failure.

### Task 2.2: Integrate settings, SSO, switch and MITM seams — Depends on [1.1]

- **BATCH**: B2
- **OWNER / WRITE SCOPE**: S. Exclusive: settings repo/switch, `configExport.js`, `combosRepo.js`, `workspaceSettingsRepo.js`, `savingsMilestones.js`, non-secret consumers (`bootstrap`, `ssoProvisioning`, `invitationAccept`, `gatewayAuth`), settings route/validator, OIDC runtime/test, MITM manager and new legacy CJS helper, four MITM injection callers, `settings-secret-leaks.test.js`, `antigravity-mitm-credential.test.js`.
- **ACTION**: Write raw-writer and settings mode tests, then separate raw opaque storage from trusted runtime decryption.
- **MIRROR**: REPOSITORY_PATTERN; SERVICE_PATTERN; `settingsRepo.readRaw`/`exportSettings`; security R6/R8/R18.
- **IMPLEMENT**: Add narrow raw multi-user boolean; switch remains sole env/setting reader. Metadata settings mode exposes non-secrets and safe configured booleans without root. Trusted runtime decrypts five Default-coordinate settings. Raw writers preserve exact envelope values, including settings merge/combo transform, combos rename, workspace settings removal, savings acknowledgement, config apply; O-owned users/transfer/migrate writers covered later. Settings responses keep secrets redacted. MITM optional third hook detects established mode explicitly; established save/load uses repo encryption; integrity/persistence failure propagates. Extract legacy decrypt math into side-effect-free CJS helper; activation imports helper, never manager.
- **IMPORTS**: B1 interfaces, existing `SECRET_SETTING_KEYS`, CJS `require` for MITM helper.
- **GOTCHA**: `readRaw` never decrypts. Do not detect MITM format by colons. Legacy null/corruption cannot become empty password. No secret in OIDC test response/error.
- **VALIDATE**: `cd tests && npx vitest run -c vitest.config.js unit/settings-secret-leaks.test.js unit/antigravity-mitm-credential.test.js unit/multi-user-switch.test.js`; plus temporary local review that each listed writer has opaque-envelope assertion.

### Task 2.3: Centralize hash-key continuity and maintenance admission — Depends on [1.1]

- **BATCH**: B2
- **OWNER / WRITE SCOPE**: O. Exclusive: new `apiKeyHashKey.js`, `credentialMaintenance.js`, `api-key-hash-key.test.js`; edits `masterKey.js`, `driver.js`, `activateGatewayKeys.js`, `apiKeyPrincipal.js`, `apiKeyManagement.js`, `cliToolSettingsRepo.js`, `usageRepo.js`, codex-settings route.
- **ACTION**: Write getter/admission tests, then move hash consumers 1–6 to stable getter and add maintenance poisoning seam.
- **MIRROR**: Hash continuity and Maintenance contracts; `activateGatewayKeys` verified root pattern; security R1–R5/G3/G4.
- **IMPLEMENT**: Getter preserves pre-encryption HKDF behavior, but encrypted state verifies current KEK kid and unwraps wrapped derived key with frozen hash-kid AAD. Never rehash/derive from rotated KEK. Hash ledger: (1) principal, (2) management, (3) CLI tool references, (4) usage identity, (5) codex settings, (6) activateGatewayKeys backup digest/root/verify. Paths 7–9 reserved for 5.1. Keep `hashGatewayKeys.js` inert original-master pre-encryption derive; assert unavailable on encrypted marker. Add adapter mutation admission: synchronous maintenance callback only; poison blocks raw writes/credential use until restart; no request bypass flag.
- **IMPORTS**: masterKey loader/HKDF, B1 state/storage; driver imports admission helper, helper never imports driver.
- **GOTCHA**: File handle loaded before rename must not become accepted current root after generation changes. Do not rewrite `apiKeysHashKid`/row `hashKid`.
- **VALIDATE**: `cd tests && npx vitest run -c vitest.config.js unit/api-key-hash-key.test.js unit/gateway-key-principal.test.js unit/gateway-key-management.test.js unit/gateway-key-presets.test.js unit/gateway-key-usage-identity.test.js unit/gateway-key-codex-config.test.js unit/gateway-key-activation.test.js`.

### Task 2.4: Author activation, lifecycle and transfer integration tests — Depends on [1.1]

- **BATCH**: B2
- **OWNER / WRITE SCOPE**: T. Exclusive: `credential-encryption-activation.test.js`, `credential-encryption-lifecycle.test.js`, `gateway-key-transfer.test.js`, `db-import-backup.test.js`.
- **ACTION**: Encode C1/C3/C4/C5–C10 and G1–G20 as executable failing/pending-to-green integration tests against B1 contracts.
- **MIRROR**: TEST_STRUCTURE, `gateway-key-activation.test.js`, `gateway-key-established-security.test.js`, `tenancyHarness`.
- **IMPLEMENT**: Fixtures cover never-enabled off, legacy mixed ownership/NULL row, every D10 sentinel, legacy MITM ok/corrupt, on→off established, missing/wrong/corrupt root, crash after commit pre-cleanup, all nine hash paths, Default deletion/no secrets, cache resurrection, rotation file/DB boundaries native+sql.js, env refusal, wrong-root import, v3 export/import, legacy rejection, no backup on rejection, no retired key file.
- **IMPORTS**: installed Vitest, Node fs/crypto/child process, real adapters, test helpers.
- **GOTCHA**: Never real HOME/DATA_DIR; assert isolated before destructive fixture. Integration tests stay red/pending until owning implementation; do not add to `known-fails.txt` or use skip-only completion.
- **VALIDATE**: Static check: tests compile/load and red failures point only at intentionally unimplemented B3–B6 behavior; Parent records expected-red list for O.

### Task 3.1: Activate encryption, cleanup and lifecycle safety — Depends on [2.1, 2.2, 2.3, 2.4]

- **BATCH**: B3
- **OWNER / WRITE SCOPE**: O. Exclusive: activation file, pure activation helper, `startupReadiness.js`, `backup.js`, `migrate.js`, `workspacesRepo.js`, `usersRepo.js`; may edit T activation/lifecycle tests now.
- **ACTION**: Implement first irreversible activation and live lifecycle guarantees, then make activation/lifecycle tests green.
- **MIRROR**: SERVICE_PATTERN; `activateGatewayKeys` protected backup/flush; security R10/R11/R15/R17/R20.
- **IMPLEMENT**: Startup order: lock/schema → pending rotation recovery stub fail-closed → strict state/root prep for established → raw switch → bootstrap → gateway activation → envelope activation. Never-enabled off creates no root/backup/DEK/marker. First activation pre-resolves root/verifier/legacy helper, creates verified private backup, then one sync transaction: adopt ownerless, DEKs per owning workspace, encrypt D10, MITM rekey, wrap derived hash key, marker+cleanup-pending. Strict flush, checked TRUNCATE, live VACUUM, TRUNCATE, durable cleanup clear; restart finishes pending cleanup before readiness. Reject legacy JSON import under marker. Default delete always 409 in same transaction; post-commit cache purge for deleted shared/personal workspaces.
- **IMPORTS**: B1–B2 seams; lazy startup imports only; MITM legacy helper not manager.
- **GOTCHA**: Do not claim zero mutation after uncertain commit. Existing-envelope rerun must authenticate unchanged envelopes. Startup failure stays sticky before timers. Never create replacement KEK.
- **VALIDATE**: `cd tests && npx vitest run -c vitest.config.js unit/credential-encryption-activation.test.js unit/gateway-key-startup.test.js unit/gateway-key-startup-integration.test.js unit/gateway-key-established-security.test.js`.

### Task 4.1: Implement crash-safe KEK and DEK rotation — Depends on [3.1]

- **BATCH**: B4
- **OWNER / WRITE SCOPE**: O. Exclusive: `keyRotation.js`, `masterKey.js`, `credentialMaintenance.js`, `startupReadiness.js`, lifecycle test.
- **ACTION**: Implement service and restart recovery without route exposure.
- **MIRROR**: SERVICE_PATTERN; masterKey fs safety; external publish/durability rows; D9/D12.
- **IMPLEMENT**: Env-managed KEK check first: `409 KEK_ENV_MANAGED`, no stage/backup/DB/marker. File rotation: preflight state/root/wraps; private protected backup; enter one sync non-yielding maintenance critical section. Create fixed `keys/master.next` exclusively (0600, no link), fsync file/dir; rewrap every DEK + derived hash key and write pending `{oldKid,newKid}` marker in one transaction; durable flush/checkpoint; rename stage over master only after durable commit; fsync dir; verify; clear pending durably; clear caches. Recovery uses DB marker first, authenticates stage/master, promotes only matching kid, deletes stage only after proof; uncertain failures poison and retain stage. DEK rotation re-encrypts target fields, and Default also five settings secrets.
- **IMPORTS**: B1 codec/storage, hash getter, adapter durability helpers.
- **GOTCHA**: No retired/escrow/old master file after success. Never infer commit from stage alone. No `finally` cleanup that deletes last valid root. Env set during pending file recovery fails closed.
- **VALIDATE**: `cd tests && npx vitest run -c vitest.config.js unit/credential-encryption-lifecycle.test.js unit/api-key-hash-key.test.js`; crash matrix child kills at staged/committed/renamed/finalized boundaries on native and sql.js.

### Task 5.1: Add encrypted transfer and remaining hash proof paths — Depends on [4.1]

- **BATCH**: B5
- **OWNER / WRITE SCOPE**: O. Exclusive: `src/lib/db/index.js`, `gatewayKeyTransfer.js`, `backup.js`, transfer/import tests.
- **ACTION**: Implement v3 opaque ciphertext export/import and move hash paths 7–9 to stable proof.
- **MIRROR**: existing v2 preflight → private backup → one transaction; security G7/G8.
- **IMPLEMENT**: Export raw SQL/raw settings, never decrypting repos; deny pending rotation/cleanup/poison. v3 adds `credentialEncryption` and exact `workspaceKeys`. Preflight before backup: v3 required on encrypted destination, current root kid, hash unwrap, every DEK unwrap, refs/duplicates/orphans, strict envelopes and same-root field authentication. Apply after verified backup in one transaction: identity/workspaces, key rows, exact envelopes, marker; preserve IDs and bytes. Paths: (7) index trusted root proof, (8) transfer v3 root proof, (9) legacy-to-hashed conversion before encryption only. Legacy v1/v2 plaintext on encrypted instance rejects before backup/wipe. Clear credential/hash/API/pricing/MITM caches post-commit; strict flush.
- **IMPORTS**: B1 state/storage, hash getter, existing protected backup verifier.
- **GOTCHA**: v3 restore cannot activate encryption on a never-enabled instance; destination must already have same root. Apply never materializes plaintext. Portable config export stays secret-free.
- **VALIDATE**: `cd tests && npx vitest run -c vitest.config.js unit/gateway-key-transfer.test.js unit/db-import-backup.test.js unit/credential-encryption-lifecycle.test.js`.

### Task 6.1: Expose owner-only rotation APIs and CLI — Depends on [5.1]

- **BATCH**: B6
- **OWNER / WRITE SCOPE**: O. Exclusive: two new route files, route policy and test, CLI dispatcher/client/command, lifecycle test.
- **ACTION**: Wire existing rotation service to authenticated transports.
- **MIRROR**: route policy capability rows, `requireMultiUser`, CLI `auth setup-token` pattern.
- **IMPLEMENT**: Routes accept only POST with empty bounded object body; reject override fields. Switch-off 404, unauth 401, non-owner 403, env 409 guidance, maintenance 409 `LOCKED`, unavailable 503 typed codes; route policy `multiUserOnly`, `alwaysProtected`, `instance.keys.rotate`; handler rechecks owner. CLI: `tokenhop keys rotate [--workspace <id>] [--port <port>] [--yes]`, early dispatch, strict validation; default prompt No; decline sends no request; `--yes` sends once. Output kids/counts and backup reminders only.
- **IMPORTS**: rotation service, principal/capability helpers, existing CLI API client.
- **GOTCHA**: No `--dry-run`, `--json`, root/path/env overrides, dashboard UI or local DB access from CLI. Audit/log no key material.
- **VALIDATE**: `cd tests && npx vitest run -c vitest.config.js unit/route-policy.test.js unit/credential-encryption-lifecycle.test.js unit/gateway-key-cli.test.js`; `npm run cli:pack` only if CLI packaging includes changed file and leave generated pack artifact uncommitted.

### Task 7.1: Parent validation, adversarial review and delivery — Depends on [6.1]

- **BATCH**: B7
- **OWNER / WRITE SCOPE**: Parent. Review fixes dispatched only to prior owner with explicit nonoverlap; no release/changelog edits.
- **ACTION**: Run final evidence, mandatory pre-PR adversarial/security review, PR lifecycle, merge and tracker completion.
- **MIRROR**: `verification.md` sections 4–7, `.github/pull_request_template.md`, `RELEASING.md` trunk rules.
- **IMPLEMENT**: Grep ledgers: all crypto calls only in envelope module except legacy MITM extraction; nine hash paths; settings raw writers; `gatewayResources` both paths; credential SQL writers; no awaits in transactions; no plaintext fallback. Run validation commands. Perform adversarial/security review over crash publication, import atomicity, root ID split, on/off fail-closed, circular imports and secret exposure; fix all real findings and rerun affected tests. Open PR titled `feat(security): envelope encryption of credentials at rest (per-workspace DEKs)` with `Closes YAN-365`, Decisions, Isolation matrix, Verification evidence and D7/D9/D10 limits. After PR, wait first CodeRabbit pass, address actionable findings, rebase/CI green, squash merge, delete branch and existing worktree only after merge, move Linear YAN-365 Done with PR, merge commit and summary.
- **IMPORTS**: none.
- **GOTCHA**: Do not run unisolated vitest. Do not edit `RELEASING.md`/`CHANGELOG.md`, add deps, flip switch default or skip review after CI. Cleanup only after successful merge.
- **VALIDATE**: all Validation Commands green; PR and CI evidence recorded; merged commit and Linear Done comment confirmed.

---

## Testing Strategy

### Unit Tests

| Claim        | Test / owner                                       | Input                                                                        | Expected Output                                                                   | Edge Case? |
| ------------ | -------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------- |
| C2           | `envelope-crypto.test.js` / F                      | six frozen AAD vectors, each tag/IV/ct/coordinate/field swap                 | exact hashes; uniform safe failures; no partial plaintext                         | yes        |
| Schema       | migration-chain / F                                | old and already-current schema                                               | idempotent 013, correct TABLES and FK/classification                              | yes        |
| Hash seam    | `api-key-hash-key.test.js` / O                     | original vs wrapped key, generation race, poison                             | same HMAC, stale root rejected, raw writes denied                                 | yes        |
| C8           | token-refresh-generic + connection-ownership / R   | pair + minted key + nested delta, stale PSD                                  | one sync merge/write, siblings survive, failure reported                          | yes        |
| Settings     | settings-secret-leaks / S                          | all raw writer families with envelopes                                       | exact secret envelope bytes retained; responses redact                            | yes        |
| MITM         | antigravity-mitm-credential / S                    | valid/corrupt machine cipher; active hook                                    | strict once-only rekey or typed abort; no double cipher                           | yes        |
| C1/C3/C4/C10 | credential-encryption-activation / T then O        | Default/personal/shared/NULL fixture, off/on, missing key, crash pre-cleanup | correct ownership, one activation, no live plaintext, no regenerate               | yes        |
| C5/C6/C7     | credential-encryption-lifecycle / T then O         | KEK/DEK rotation, delete/cache, env root                                     | hash/field bytes unchanged for KEK; scoped DEK changes incl. settings; Default409 | yes        |
| C4/C9        | gateway-key-transfer + db-import-backup / T then O | post-rotation v3 and hostile wrong-root/plaintext/corrupt payloads           | exact restore or zero mutation **and no backup dir**                              | yes        |
| Route/CLI    | route-policy + lifecycle / O                       | no auth/admin/owner/remote CLI/off/decline/yes                               | owner-only; decline zero request; dropped flags rejected                          | yes        |

Claim integration tests seed fake unique sentinel per D10 leaf. Scan current main DB, `-wal` when present, post-activation backup and exported JSON; do not require old protected recovery backups to be clean. Assert those old copies remain plaintext/private, documenting D7. Never log sentinel/key material on assertion failure outside isolated test output.

Native and sql.js child-process crash tests restart with independent disk reopen, not only `vi.resetModules` or in-memory instance reuse. Child inherits isolated HOME/DATA_DIR and explicit fake key env. Kill boundaries: stage synced; DB commit synced; rename before finalization; finalized; activation committed before VACUUM. Every test asserts marker/key-file pairing, readiness and gateway authentication; no environment/provider network access. Use installed Node SQLite/native/sql.js only; if a small child entry helper is necessary, Parent assigns new helper to O after B2, no concurrent tests file mutation.

### Coverage ledger: nine hash consumer/proof paths

| Path | Exact file / baseline lines                           | Required post-rotation check                                                                                                 |
| ---- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| H1   | `src/lib/auth/apiKeyPrincipal.js:62–68`               | same raw `th_` and `sk-` authenticate                                                                                        |
| H2   | `src/lib/users/apiKeyManagement.js:185–186`           | new issuance uses stable key; existing metadata eligible                                                                     |
| H3   | `src/lib/db/repos/cliToolSettingsRepo.js:42–43`       | key reference matches same row                                                                                               |
| H4   | `src/lib/db/repos/usageRepo.js:397–398`               | key identity attribution unchanged                                                                                           |
| H5   | `src/app/api/cli-tools/codex-settings/route.js:48–49` | presented-key config lookup matches                                                                                          |
| H6   | `src/lib/db/activateGatewayKeys.js:163,200,266`       | restart proof by current KEK + unwrap; original backup digest only before activation                                         |
| H7   | `src/lib/db/index.js:379–390`                         | trusted import root proof uses current KEK identity                                                                          |
| H8   | `src/lib/db/helpers/gatewayKeyTransfer.js:704–715`    | v3 proof unwraps; v2 old semantics not silently redefined                                                                    |
| H9   | `src/lib/db/helpers/gatewayKeyTransfer.js:771–799`    | legacy-to-hashed path uses original hash key only in supported unencrypted mode; encrypted legacy rejected before derivation |

Also audit direct HKDF in `src/lib/db/migrations/hashGatewayKeys.js:60`: original-master migration is intentionally pre-encryption only, not tenth post-rotation consumer. Tests assert it never runs with encrypted marker. `apiKeysRepo` frozen-hashKid JOIN remains unchanged and resolves after rotation. No “all consumers” claim from principal-only test.

### Coverage ledger: raw settings writers

| Writer                                               | Treatment / test                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| settingsRepo `updateSettings`                        | encrypt supplied secret delta; preserve other envelopes           |
| settingsRepo `updateComboStrategies`                 | raw merge, exact envelope equality                                |
| usersRepo password mirror                            | raw settings merge in owner password transaction; exact equality  |
| workspaceSettingsRepo `removeLegacyPasswordUnscoped` | remove password only, raw rest unchanged                          |
| combosRepo `moveComboStrategy`                       | raw map rename; no secret transform                               |
| savingsMilestones `claimSavingsMilestone`            | raw ack merge; exact equality                                     |
| configExport `applyConfig`                           | portable allow-listed config only; preserves live wraps           |
| gatewayKeyTransfer preserve/apply                    | v3 exact ciphertext/settings; local verifier preserved separately |
| index import legacy apply                            | impossible on encrypted instance; reject before backup/wipe       |
| migrate legacy main seed                             | impossible under encrypted/ambiguous marker; guard before seed    |

Historical 002 Cursor / 003 SAML raw migrations never replay on established storage; ordering assertion not rewriting shipped migration. Settings metadata mode serves policy readers without key, but D3 startup still blocks actual request serving when root unavailable; security lane G16 does not override that.

### Edge Cases Checklist

- [ ] Empty/null/absent secret semantics remain; no encrypting metadata/whole PSD.
- [ ] Hostile envelope lookalike, unknown kid, invalid base64/length, oversized secret/ct fail safely.
- [ ] Row/field/workspace/table/wrap swaps fail; no unknown field accepted from HTTP/import.
- [ ] Foreign workspace membership/principal cannot decrypt cache-selected data.
- [ ] Refresh racing DEK rotate/import/delete cannot persist stale envelope or report failed save as success.
- [ ] KEK env refusal includes no backup/stage/marker/file mutation; DEK env rotation works.
- [ ] Half marker/missing root never generates master; on→off established writes stay encrypted.
- [ ] Backup failure/corrupt legacy sudo abort before irreversible mutation; protected snapshot usable.
- [ ] Native/sql.js flush, checkpoint, rename and fsync failures retain recovery state and reject readiness.
- [ ] Default deletion denied with no secrets too; personal user deletion evicts all workspace DEKs.
- [ ] Metadata listing survives corrupt row; actual use throws uniform error.
- [ ] No old-root key-bearing artifact after successful rotation; prior backups need operator-held offline key.

## Validation Commands

Commands here run from existing worktree unless subshell selects `tests/`. Apply environment hygiene before any task test command. Root/tests dependencies already installed; no setup reinstall.

### Static Analysis

```bash
unset TOKENHOP_MASTER_KEY TOKENHOP_TEST_TMP_PARENT TOKENHOP_TEST_REAL_PROJECT RUN_REAL RUN_E2E
npm run lint
npm run lint:brand
```

EXPECT: zero lint/brand errors. Plain JavaScript, no TypeScript compiler. No docs/brand translation changes or new dependency diff.

### Unit Tests

```bash
(cd tests && TOKENHOP_MULTI_USER=off npx vitest run -c vitest.config.js unit/envelope-crypto.test.js unit/api-key-hash-key.test.js unit/credential-encryption-activation.test.js unit/credential-encryption-lifecycle.test.js unit/gateway-key-transfer.test.js unit/db-import-backup.test.js)
(cd tests && TOKENHOP_MULTI_USER=on npx vitest run -c vitest.config.js unit/envelope-crypto.test.js unit/api-key-hash-key.test.js unit/credential-encryption-activation.test.js unit/credential-encryption-lifecycle.test.js unit/gateway-key-transfer.test.js unit/db-import-backup.test.js)
```

EXPECT: C1–C10 green in both switch states, native/sql.js crash fixtures included. No skips replacing required evidence.

Adjacent regressions after seams stabilize:

```bash
(cd tests && npx vitest run -c vitest.config.js unit/gateway-key-established-security.test.js unit/gateway-key-activation.test.js unit/gateway-key-startup-integration.test.js unit/tenancy-guard.test.js unit/tenancy-isolation.test.js unit/settings-secret-leaks.test.js unit/background-token-refresh.test.js unit/token-refresh-generic.test.js unit/antigravity-mitm-credential.test.js unit/connection-ownership.test.js unit/db-migration-chain.test.js unit/route-policy.test.js unit/test-data-isolation.test.js)
```

### Full Test Suite

```bash
TOKENHOP_MULTI_USER=off npm test
TOKENHOP_MULTI_USER=on npm test
npm run build
npm run lint:brand
git diff origin/master -- package.json package-lock.json tests/package.json tests/package-lock.json cli/package.json cli/package-lock.json
```

EXPECT: baseline gate green both modes, build succeeds, dependency diff empty. No YAN-365 additions to `known-fails.txt`. Parent reruns full gate once on final rebased head; rerun changed targeted tests after fixes and full gate when change/rebase invalidates evidence.

### Database Validation

```bash
(cd tests && npx vitest run -c vitest.config.js unit/db-migration-chain.test.js unit/tenancy-guard.test.js unit/credential-encryption-activation.test.js unit/credential-encryption-lifecycle.test.js unit/gateway-key-transfer.test.js unit/db-import-backup.test.js)
```

EXPECT: additive 013, FK/key graph coherent, Default protection, exact restore, no live plaintext sentinels, missing/wrong root zero mutation/no generated file. Every destructive fixture asserts isolated HOME; no real DATA_DIR query.

### Browser Validation

N/A — no dashboard surface added (D12). API/CLI real HTTP rehearsal uses throwaway fixture DATA_DIR and fake providers only. Keep server bind loopback; do not use operator keys or `.env.local` secrets. Use verified app CLI port syntax (`npm run dev -- --port 20128`), not assume `PORT` overrides `next dev --port`.

### Manual Validation

1. Parent creates isolated fixture under `/tmp/opencode`, seeds fake owner/workspaces/SSO/MITM/provider/gateway keys, and starts loopback-only runtime; must never reuse real HOME/DATA_DIR.
2. Exercise owner APIs and CLI KEK rotation, restart, same gateway key auth; Default workspace DEK rotation and SSO/MITM fake-secret read; env-managed KEK refusal/DEK success.
3. Download v3, restore same-root, compare IDs/raw envelopes/keyHashes; reject wrong root/legacy with no backup/wipe. Record HTTP and CLI transcripts without key material.
4. Delete non-Default workspace and verify live DEK unavailable; Default deletion denied. Inspect raw sentinel scan evidence from tests.
5. Stop fixture runtime and remove only guarded isolated fixture. Parent records final evidence in PR, not claims from mocks alone.

## Acceptance Criteria

- [ ] Node crypto only, no new dependencies; strict AES-GCM v1 envelopes and exact D1 vectors (A1–A4/C2).
- [ ] All D10 secret leaves encrypted at rest; gateway raw runtime reads decrypt; full metadata redaction; no sentinel in live DB/WAL/post-activation snapshot (A6/A23/C1).
- [ ] Bounded DEK-only cache live-row checks, workspace/user delete purge, Default always409 (A5/A17/C7).
- [ ] Sync live-row refresh merge persists pair/minted API-key/nested secrets; failures reported, no stale-snapshot overwrite (A7/C8).
- [ ] Idempotent own-workspace activation after verified protected backup; NULL rows adopted only; strict legacy MITM once-only decrypt; corrupt sudo aborts (A8–A10/A21/C3).
- [ ] Missing/wrong/corrupt KEK/marker closes readiness, never regenerates or plaintext-falls-back; established off still protected; pristine off unchanged (A11/A22/C4/C10).
- [ ] KEK rotation rewraps DEKs + stable derived hash key, raw fields/keyHashes/hashKid unchanged; all nine consumer/proof paths work after restart (A13/C5).
- [ ] Staged fsync + durable DB commit + rename + finalize/recovery verified native/sql.js at every crash boundary; no retired root after success (A14/D12/C5).
- [ ] Per-workspace DEK rotation works incl. Default instance secrets and env root; other workspaces unchanged (A16/C6).
- [ ] CLI and admin rotations owner-only server-side, hidden off, strict body/flags, envKEK409 guidance/no mutation; no secret over HTTP/log/audit (A12/A15/C5/C6).
- [ ] v3 encrypted export contains wraps/state/original IDs; same-root atomic restore works; wrong root/plaintext/malformed graph rejected before backup/wipe; v1/v2 unencrypted compatibility unchanged (A19/A20/C4/C9).
- [ ] D7 live-only shredding/historical-copy limits, D9 refusal, D10 plaintext proxy discovery, D12 old-backup key duty stated in PR/doc handoff (A18/A24).
- [ ] Lint, safe tests both modes, build, brand, empty dependency diff, pre-PR adversarial/security review and CI all green (A25).
- [ ] First CodeRabbit review addressed before merge; squash merge/cleanup/Linear Done evidence confirmed.

## Completion Checklist

- [ ] Every task has ACTION/IMPLEMENT/MIRROR/VALIDATE and dependency assignment; B2 write scopes do not overlap.
- [ ] Interfaces fixed in B1; no speculative abstractions or driver-level encryption.
- [ ] Nine hash ledger entries explicitly exercised; do not confuse root identity with hash identity.
- [ ] Ten raw settings writer families exercised or proven unreachable on encrypted storage; opaque envelope equality preserved.
- [ ] No await in credential transaction or root publication critical section; no stale root accepted after async preparation.
- [ ] Missing root/partial marker/flush uncertainty poisons serving and raw write admission; pending recovery not silently cleared.
- [ ] Adversarial self-review and security-specialist review before PR; real findings fixed with affected regression evidence.
- [ ] Parent follows PR template; title exact; `Closes YAN-365`; Decisions/Isolation matrix/Verification evidence; D7/D9/D10/D12 limits recorded.
- [ ] After PR, first CodeRabbit pass only as required review gate; fix or justified reply-and-resolve actionable findings; no repeated speculative review loops.
- [ ] CI green on rebased head (three brands × two switch test modes, builds/CLI/lint checks); no known-fails allowance.
- [ ] Squash merge to master, delete branch/remove existing worktree after merge, Linear Done + PR/commit/summary.
- [ ] Hand off D1–D12 amendments to maintainer for main-checkout ADRs and YAN-379 docs; no main-checkout/release/changelog edits here.

## Risks

| Risk                                                       | Likelihood               | Impact                     | Mitigation                                                                                                                                                           |
| ---------------------------------------------------------- | ------------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critical: root rotation breaks hashes/import/startup proof | high without D6          | gateway outage             | nine-path ledger, stable wrapped derived key, split IDs, v3 proof, C5                                                                                                |
| Critical: DB commit and file publication diverge           | low per event            | unrecoverable secrets      | sync durable stage/commit/rename, DB-first recovery, no retired-key fallback, child matrix                                                                           |
| Critical: failed sql.js flush later persists via timer     | medium on I/O fault      | uncertain root state       | no rename before strict flush, admission poison, keep stage/pending, stop unsafe serving/writers and restart recovery; delayed save cannot reopen readiness          |
| Critical: restore wipes before authentication              | medium without preflight | data loss                  | complete immutable preflight plan before backup/wipe, verified backup, one apply transaction, flush before success; failed durable flush poisons, no retry as legacy |
| High: raw gateway input remains envelope object            | high without seam        | bad bearer/secret leak     | central codec after SQL filtering, principal/unscoped tests                                                                                                          |
| High: PSD stale sibling merge or metadata decrypt throws   | medium                   | token loss/availability    | delta-only refresh, live sync merge, metadata raw redaction, C8                                                                                                      |
| High: settings writer strips/double-wraps                  | medium                   | SSO/MITM loss              | exact-envelope ledger, raw writer mode, no generic decrypt-write                                                                                                     |
| High: circular import or pre-auth decrypt dependency       | medium                   | startup failure            | raw switch/metadata modes, cycle-free helpers, prepared root before bootstrap                                                                                        |
| High: root regeneration/downgrade after switch off         | medium                   | loss/leak                  | strict durable marker even off, expectedKid no-create, C4/C10 file assertion                                                                                         |
| High: cache key survives delete/import/rollback            | medium                   | live shred bypass          | live row/generation hit checks, bounded eviction, after-commit purge                                                                                                 |
| High: partial cleanup leaves plaintext pages               | high without D7          | DB leak                    | pending cleanup + live VACUUM/TRUNCATE twice, native/sql.js post-commit crash and byte scans                                                                         |
| High: MITM decrypt failure silently clears                 | medium                   | secret loss                | strict side-effect-free legacy decode, typed abort/usable backup                                                                                                     |
| High: operator expects old backup shredding                | high without warning     | false protection           | D7 copy limits, D12 offline old key duty; never auto-clean historical files                                                                                          |
| Medium: node/import secret field omitted                   | medium                   | leak                       | D10 fixtures incl. auth headers, full writer review; no whole-PSD encryption                                                                                         |
| Medium: env root file publish ignored                      | high without D9          | outage on restart          | env409 before stage, safe same-key conversion guidance; DEK allowed                                                                                                  |
| Medium: Unix/Windows durability differs                    | platform dependent       | failed power-loss recovery | preserve private mode/platform rules; fsync failures fail closed; supported-platform tests/docs, no stronger Windows guarantee claimed                               |

## Notes

### B2 review carry-overs (must not be dropped)

- **B3 blocker (3.1):** `importDb` (`src/lib/db/index.js` connection/node `INSERT OR REPLACE`) and the legacy JSON importer (`src/lib/db/migrate.js`) write plaintext and drop `workspaceId` on an established DB. They must reject any payload without a v3 credential section when `readCredentialEncryptionState(db).storage === "encrypted"`, before backup or wipe.
- **B5 blocker (5.1):** `gatewayKeyTransfer.js` connection/node writers have the same raw shape; the v3 path must go through the trusted migration codec.
- **B3/B4/B5:** any adapter they create outside the driver must get maintenance admission (now auto-installed on poison). Rotation callbacks must not start floating promises. No `.raw` adapter access on request paths.
- **PR notes:** untyped errors in `tokenRefresh.updateProviderCredentials` still return `false` (typed ones propagate); list responses gain a `configured` array of dotted paths; `gateway-key-migration.test.js` has one pre-existing `node:sqlite` failure on Node 24 that also fails on clean `master`.

Seven backstop files confirmed present and read before synthesis. Primary mapping: API external docs, business stories/acceptance, technical tasks/ownership, UX existing operator surfaces, security risks/coverage gotchas, practices reuse/tests, recommendations delivery. Deduplicated findings once per relevant section. D1–D12 override stale snippets: no old-master retention, no dry-run/JSON/UI, startup fails closed, Default always protected, no env auto-KEK rotation. No remaining implementation decision waits on user approval.

Minimum architecture remains one codec, one sync storage helper/state reader, one activation helper, one rotation service and one stable hash getter. O deliberately serializes shared files/tests; a separate B2 test writer gives TDD integration coverage without racing app writers. Batches are shortest safe graph given cross-cutting irreversible state; no per-task PRs or worktrees. Existing large files receive minimal seams rather than unrelated cleanup; new files stay approximately 500 lines or less.

**Import all-or-nothing**: preflight is pure and frozen, backup/verify/apply have no yielding gap, inserts and state share one transaction; pre-commit failure restores live state automatically. Post-commit flush uncertainty is not success: poison, retain verified backup, block serving, reopen disk independently on restart; never wipe again or downgrade. This is distinct from filesystem KEK recovery and must not be hidden by a generic catch.

**Maintenance admission**: a resolved startup promise cannot unresolve after runtime error. Admission helper therefore gates credential use and raw adapter mutations when poisoned; stop serving/timers or terminate safely if inability to fence adapter internal delayed flush/close prevents reliable quiescence. Do not rely on shutdown flushers, which are best effort. All successful publication operations are non-yielding after async preparation; revalidate root generation and live rows at critical-section entry.

**Honest threat model**: encrypted DB/post-activation backups protect covered credentials when KEK absent; root/live process/operator compromise does not. Historical backups carrying wrapped DEKs remain decryptable with matching historical KEK. Proxy pool/userinfo credentials outside D10 remain plaintext; record discovery and follow-up only if confirmed. No universal erasure of V8 strings, in-flight provider tokens, swap or filesystem snapshots promised.

Planning confidence: high for module seams and accepted scope; conditional for native/sql.js crash/cleanup correctness until child-process evidence passes. Parent must not replace those tests with successful in-memory roundtrip claims.
