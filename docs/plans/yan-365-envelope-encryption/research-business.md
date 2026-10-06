# YAN-365 Envelope Encryption — Business Research

## Executive Summary

Protect provider and instance credentials against SQLite DB, backup and export leaks without changing pristine single-user installs. Encryption starts only on explicit multi-user enablement; once established, encryption and key validation remain mandatory even when that switch is later off. Lost KEK means lost credentials, not permission to regenerate keys or write plaintext.

Sources read: full GH #233 body/comments through `gh issue view 233 --json title,body,labels,state,comments`; main-checkout `docs/users/README.md`, `spec.md`, and accepted `adr/0008-encryption-at-rest.md`; current worktree persistence, master-key, startup and MITM code. Live Linear YAN-365 description retrieved 2026-10-06 (`updatedAt: 2026-10-06T07:19:37.996Z`). No validation commands run; parent owns validation.

**Source reconciliation:** GH mirror omits Linear's approved “Design decisions (YAN-350)” appendix. That appendix explicitly binds YAN-365 to ADR-0008, reuses YAN-363's loader, and specifies AAD `connectionId|workspaceId`. Earlier issue text specifies stronger `table|rowId|workspaceId|field`; do not silently present that as approved. Approved ADR governs existing connection envelope compatibility; stronger field binding needs an explicit decision. Linear and GH core checklist still include provider-node secrets, bounded cache, workspace DEK rotation, CLI + admin KEK rotation, and fail-fast missing-key handling. These requirements are not removed by the narrower ADR coverage list.

Scope ownership conflicts remain: ADR assigns CLI command to YAN-377 and full export/import integration to YAN-375; live issue explicitly requests both now. Parent should record delivery boundary before planning, not drop checklist items. Recommended boundary: YAN-365 delivers encryption-safe operational seams and minimum CLI/admin and transfer support; later issues extend general CLI UX and user-aware export coverage.

## User Stories

- Existing single-user operator upgrades binary/image with switch off: no master-key generation, DEK creation, credential rewrite, new reachable encryption routes, or changed provider behavior.
- Instance owner enables multi-user: credentials migrate after verified backup; existing OAuth refresh, SSO, API-key providers and MITM continue working. Operator receives key-backup/key-loss warning before irreversible activation.
- Workspace member uses own provider connection: authorized runtime reads decrypt transparently; other workspace members cannot read, use, swap, or overwrite it.
- Instance owner rotates KEK through CLI or admin API: all DEKs rewrap, provider ciphertext remains byte-identical, authentication and refresh keep working.
- Authorized workspace operator rotates workspace DEK: all secrets owned by that workspace re-encrypt atomically; other workspaces remain unchanged.
- Workspace/user deletion removes credentials and DEKs together and invalidates caches; deleted workspace cannot recover through live instance state.
- Operator exports/restores: output contains ciphertext and wrapped DEKs, never KEK or plaintext credentials; wrong/missing KEK produces clear error before destructive import.

## Business Rules

### Activation and compatibility

- Built-in default stays off until YAN-380. `isMultiUserEnabled()` remains sole switch reader; new user-visible routes use `requireMultiUser()`.
- Distinguish **pristine legacy** from **established encrypted** storage through durable, strictly validated state. Switch is permission to activate, not authority to downgrade security.
- Pristine off state stays unchanged. Established encrypted state always decrypts through trusted keys, encrypts every secret write, and fails closed on missing keys, even with switch off.
- New workspaces and existing workspace-owned rows use their actual workspace DEKs. Only legacy unowned rows backfill into Default. Do not encrypt all existing owned rows under Default merely because issue shorthand says “existing rows under Default DEK.”
- Mixed plaintext/encrypted reads are allowed only during controlled transition or explicitly validated legacy import; malformed envelopes never count as plaintext. Completed activation cannot silently accept new plaintext secret writes.
- Downgrade after irreversible migration unsupported; restore protected pre-migration backup instead (ADR-0009). Never modify production data during research/validation.

### Key custody and encrypted coverage

- Reuse `src/lib/security/masterKey.js`: env has precedence, canonical base64 exactly 32 bytes; fallback raw 32-byte `DATA_DIR/keys/master`, Unix mode 0600, private keys directory. KEK never enters DB, exports, API bodies, logs, or audit rows.
- AES-256-GCM; fresh random nonce for every encryption/wrapping operation; random 32-byte DEK per workspace. Strict versioned envelope `{v, kid, iv, ct, tag}` validation; unknown versions, missing `kid`, invalid lengths and authentication failures are errors.
- Wrapped DEK authenticates `workspaceId|kid` per ADR. Connection fields authenticate approved `connectionId|workspaceId`; field/table domain binding is recommended pending decision below. Node/settings AAD must bind stable row and owner identity, not mutable labels.
- Cover connection `accessToken`, `refreshToken`, `idToken`, `apiKey`, cookie/session credentials, and nested `providerSpecificData` secrets for every provider, not only `category: oauth`. Cover secret-bearing provider-node fields too. Keep searchable non-secret metadata plaintext.
- Cover instance `oidcClientSecret`, `samlPrivateKey`, `samlDecryptionKey`, `samlSigningKey`, `mitmSudoEncrypted`; MITM migrates from machine-derived encryption to Default DEK. No double encryption or legacy-machine fallback after completed migration.
- Bcrypt password hashes, keyed gateway API-key hashes, usage and request details are not new encryption targets. Existing redaction/leak guards still apply; encryption does not make logging tokens acceptable.
- ADR places instance settings secrets under Default DEK. Therefore Default deletion cannot destroy SSO/MITM implicitly: protect Default deletion or establish dedicated instance key domain through approved decision.
- Bounded decrypt cache clears on workspace deletion, user-driven personal-workspace deletion, import replacement, KEK/DEK rotation and shutdown. Bound entries and lifetime; never expose cache contents through management APIs.

### Authorization and operational safety

- Owner owns encryption-key rotation per handbook role model; an “admin API” is an administrative endpoint, not automatic permission for every instance `admin`. Workspace rotation capability needs explicit role decision; recommend workspace owner plus instance owner, not member/viewer.
- Instance admins manage metadata but cannot use/decrypt other users' personal credentials through app APIs (ADR-0002). Compromised host/operator remains outside threat model because unattended refresh needs live keys.
- Refresh persists new access/refresh tokens together inside existing connection update transaction. Failures preserve last usable ciphertext; no partially rotated pair.
- KEK rotation must preserve gateway-key validation: YAN-363 derives `apiKeys.keyHash` HMAC key from this same master. Rewrapping only workspace DEKs and replacing master breaks every stored HMAC; original API-key bytes cannot be recovered from hashes. Do not ship that rotation behavior.
- DEK rotation re-encrypts every secret in workspace, including Default-owned settings when rotating Default, before replacing active key reference. Atomic transaction plus durable flush; failure keeps old usable state.
- Export/import must retain row IDs, workspace IDs, envelope bytes, `kid` references and full key graph. AAD makes flattening all workspaces into Default invalid. Reject duplicate/missing/orphan key references and wrong-root imports before wiping any table.
- Backup/export without separately preserved KEK is not a restore path. Optional passphrase-wrapped exports remain hardening follow-up, not required here.

### Crypto-shredding claim limits

Deleting live `workspaceKeys` plus caches destroys live decryptability. It does **not** make a historical backup cryptographically unrecoverable when that backup includes its wrapped DEK and operator still has same KEK. ADR's stronger claim conflicts with its export/backup design. Pre-activation backups can also contain plaintext, and SQLite free pages/WAL may retain old plaintext after logical migration.

Required secure recommendation: document this boundary honestly; define historical-backup retention/destruction policy and retire plaintext activation backups when recovery window ends. Do not claim retroactive backup shredding from deleting current DB row. Genuine historical-copy shredding needs a different key-custody/revocation design and approval, not an extra DELETE.

## Workflows

1. **First enable:** resolve switch and obtain exclusive DATA_DIR writer ownership; bootstrap owner/Default; reuse YAN-363 master; verify protected backup; inventory fields and workspace owners; create/wrap DEKs and migrate secrets in transaction; verify all envelopes and ownership; checkpoint/flush; publish durable encryption state; only then allow requests and background refresh.
2. **Restart:** read durable state before normal repo consumers. Off + pristine skips activation without key creation. Encrypted state requires existing matching key regardless of switch. Missing/corrupt key leaves readiness closed and reports recovery instructions; never auto-generate replacement.
3. **KEK rotation:** authenticate owner/local trusted CLI; quiesce writers; validate old/new key custody and gateway HMAC strategy; stage crash-recoverable publication; rewrap every DEK; durably commit coherent state; publish new root; invalidate caches; prove restart and provider/API-key continuity. Env-managed root requires explicit operator deployment procedure; API cannot permanently change environment.
4. **Workspace DEK rotation:** authorize target workspace; lock/drain refresh writers; decrypt/validate old values; generate new DEK/kid; re-encrypt all target-owned values in same atomic operation; commit/flush; invalidate caches. Authentication failure aborts whole rotation, not “skip bad field.”
5. **Deletion:** authorize workspace deletion or personal-user deletion; remove credential rows and key rows in same transaction; evict decrypted keys/secrets before any new access; verify background tasks cannot recreate removed key. Protect Default while instance settings depend on it.
6. **Transfer:** export raw stored envelopes and wrapped DEKs without repo-level plaintext reconstruction; preflight version, ownership, key graph and KEK authentication; import opaque envelope bytes and preserved identities atomically. Same KEK succeeds; missing/wrong KEK leaves live DB unchanged. Legacy plaintext import into encrypted instance must be rejected or separately encrypt before commit, never downgrade state.

## Domain Model

| Concept               | Contract                                                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KEK/root              | Instance-managed external 32-byte key with durable expected identity; shared loader with gateway HMAC subsystem.                                                                               |
| `workspaceKeys`       | ADR fields `workspaceId, kid, wrappedDek, createdAt`; FK/cascade and tenancy classification required. Key-history/active selection schema needed only if approved rotation design requires it. |
| DEK                   | Workspace-owned random 32-byte key; raw bytes only in bounded runtime state.                                                                                                                   |
| Secret envelope       | Versioned authenticated ciphertext plus key ID; contextual binding prevents unauthorized row/workspace swaps.                                                                                  |
| Encryption state      | Durable activation/version/root metadata distinguishing legacy, transition and established state; inconsistent combinations reject. Exact marker names not yet designed.                       |
| Instance secret owner | Default workspace DEK per ADR, with stable settings row identity and protected lifecycle.                                                                                                      |
| Principal/capability  | Instance owner for KEK rotation; membership checked before workspace secret access and proposed workspace rotation. No caller-supplied key material accepted by HTTP.                          |
| Backup/export         | Complete ciphertext/key graph but no KEK; recoverability depends on separate key custody.                                                                                                      |

## Existing Codebase Integration

- `src/lib/security/masterKey.js`: existing strict loader and `deriveApiKeyHashKey()`; reuse, do not duplicate root creation. Current API supports initialization/validation, not rotation publication.
- `src/lib/db/activateGatewayKeys.js`, `apiKeyState.js`, `startupReadiness.js`: established pattern for off+legacy no-op, durable markers, exclusive startup, validated protected backup, sticky readiness and sql.js/native flush. Current hashed restarts already require matching master even when switch off.
- `src/lib/db/repos/connectionsRepo.js`, `nodesRepo.js`: scoped/unscoped paths and JSON mapping; encrypt serialization boundary and authorize before plaintext delivery. Connection update owns existing refresh transaction. Node creation currently stores metadata only, but update accepts extra JSON: inventory secret storage/callers rather than assuming no node secrets.
- `src/lib/db/repos/settingsRepo.js`, `src/lib/settingsConfigDoc.js`, `src/mitm/manager.js`: instance secret serialization/redaction, legacy `encryptPassword`/`decryptPassword`, `globalThis.__mitmSudoPassword`, and swallowed MITM load/save failures. Do not convert integrity/key failure to null and silently continue plaintext persistence.
- `src/lib/db/repos/workspacesRepo.js`, `usersRepo.js`: shared deletion and separate personal-workspace deletion. `src/lib/db/helpers/gatewayKeyTransfer.js` also deletes workspaces during import; key lifecycle/cache invalidation must cover all three.
- `src/lib/db/index.js`, `helpers/gatewayKeyTransfer.js`, `configExport.js`, `backup.js`: exports currently reconstruct flattened data; gateway-key v2 format already preserves identity graph/security metadata. Encryption must extend that protected transfer contract, not bolt a DEK list onto lossy legacy shape. Full user-aware export is YAN-375.
- `src/lib/db/schema.js`, `migrations/index.js`: registry currently through `012-invitations`; `workspaceKeys` absent. Schema migrations are idempotent and backup-gated; secret activation must not become an unconditional schema migration while switch off.
- `cli/cli.js`: launcher commands include `data migrate`, no key rotation command. Coordinate CLI subcommand owner with YAN-377; no assumed existing `keys rotate` implementation.
- Existing test families `tests/unit/gateway-key-{crypto,activation,startup-integration,transfer}.test.js`, `db-import-backup.test.js`, `settings-secret-leaks.test.js`, `antigravity-mitm-credential.test.js` provide compatibility seams for parent validation.

## Success Criteria

Parent acceptance checklist; all required unless explicit source-ownership decision is recorded:

- [ ] No new dependencies; Node crypto only; shared strict master loader reused. No secret material in logs, API responses or audit events.
- [ ] Pristine switch-off fixtures unchanged: no KEK generation, no DEKs, no encryption migration; new routes hidden; built-in default remains off.
- [ ] Established encrypted restart and every subsequent write stay protected with switch off. Missing/wrong/corrupt root never creates replacement or falls back to plaintext.
- [ ] Verified protected backup precedes credential mutation. Legacy fixture migration idempotent; mixed transition reads valid; owned rows use correct workspace DEK; migration failure leaves recoverable prior state.
- [ ] All provider connection/token/cookie/nested secrets, node secrets and named OIDC/SAML/MITM instance secrets encrypted. Metadata remains usable. MITM legacy re-keying and unattended refresh work.
- [ ] Round-trip and independent nonce checks pass. Tamper, row/workspace swap, invalid version/key references fail authentication with clear non-secret errors. Add field/table swap negative checks if stronger AAD approved.
- [ ] Plaintext scan covers logical DB and physical DB/WAL after migration, with explicit handling of retired pages and backups. No residual plaintext credential accidentally included in current export.
- [ ] CLI/admin KEK rotation rewraps every DEK, leaves field ciphertext byte-identical, preserves gateway HMAC validation, and survives restart/failure without mismatched key/file state.
- [ ] Workspace DEK rotation replaces all target secret ciphertext atomically; other workspaces unchanged; concurrent refresh/delete/import cannot mix generations.
- [ ] Shared and personal-workspace deletion remove DEKs/credentials together and clear bounded cache. Historical-backup limitation documented instead of false retrospective-shredding claim.
- [ ] Export/import/backups carry complete encrypted key graph; same root restores, wrong/missing root rejects before mutation, unknown/orphan keys reject, plaintext imports cannot downgrade encrypted state. Config-only export preserves existing secret redaction.
- [ ] Cross-workspace negative access/write tests, one-user regression, tenancy classification and handbook §8 pass. Parent runs `npm run lint`, `npm test` with switch off/on, `npm run build`, `npm run lint:brand`, security/self review and required PR/CI evidence. Research lane does not certify those results.

## Open Questions

1. **AAD decision:** accepted connection binding is `connectionId|workspaceId`; earlier checklist is stronger. Recommend approved revised format binding table, stable row ID, workspace ID and canonical field path, with domain/version separation for DEK wrapping. Prevents connection/settings/node and same-row field swaps. Record ADR amendment before changing approved format; never silently mix interpretations under one version.
2. **KEK vs gateway HMAC:** true new-master rotation cannot recompute existing hashes without original keys. Recommend preserve existing HMAC derivation key as a separately domain-wrapped stable key under new KEK, retaining compatibility and no plaintext gateway keys; requires ADR-0005/root-validation/transfer update. Alternative requires explicit client-key reissue/re-enrollment and breaks promised continuity. Merely updating `hashKid` is invalid.
3. **Missing-key product mode:** ADR permits shell startup with unreadable connections; checklist says fail fast; current YAN-363 sticky readiness already rejects missing shared master. Recommend fail-fast readiness for normal traffic/background writers, with distinct authenticated/local recovery diagnostics if designed later. Never serve wrong/partial decrypted state. Record this interpretation against ADR's “instance starts” wording.
4. **Backup shredding/integrity:** ADR claim impossible for backup containing wrapped DEK plus surviving KEK. Recommend live-state shredding guarantee and explicit historical-copy retention limits; obtain approval if retroactive erasure is mandatory. Keep initial recovery snapshot protected and warn plaintext; schedule deliberate operator retirement, not silent auto-deletion.
5. **Default/instance lifecycle:** instance SSO and sudo depend on Default DEK. Recommend forbid deleting Default while it owns instance secrets; rotating Default includes those fields. Dedicated instance key domain is cleaner only if approved, not assumed by implementation.
6. **Rotation durability and env roots:** DB transaction cannot atomically replace external file or deployed env. Recommend documented recoverable staged rotation with retained old root until new root/DB proof is durable; env mode requires explicit new-root installation and rollback procedure. Block rotation until gateway HMAC continuity design is settled.
7. **Delivery ownership:** live issue requests CLI/admin operations and transfer safety now; ADR allocates general CLI/export work to YAN-377/YAN-375. Parent must record narrow present deliverables and follow-ups, including workspace rotation API/capability and validation—not mark checklist done based on future issues.
8. **Secret inventory ceiling:** explicit list does not name proxy URL passwords, secrets embedded in custom headers/URLs or host files. Recommend encrypt every secret-bearing connection/node value, including nested unknown credentials, and fail review if allowlist omits existing providers. Proxy pools/host files remain separately inventoried; do not claim universal instance-secret protection beyond named scope.
