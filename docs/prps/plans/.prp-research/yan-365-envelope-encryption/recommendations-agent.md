# Recommendations — YAN-365 Envelope Encryption (GH #233)

Lane: recommendations. Writes one file: `docs/prps/plans/.prp-research/yan-365-envelope-encryption/recommendations-agent.md`.
Parent session owns validation and final evidence. Reads all seven `research-*.md` files under `docs/plans/yan-365-envelope-encryption/` (this directory holds the durable record for the accepted decisions; main-checkout ADRs are gitignored). Grounds every recommendation in those files and live code paths in this worktree.

This file is a recommendation, not a plan. It maps what to build, where, and how to verify. It does not edit application code.

---

## Executive Summary

- The seven research lanes converge on one implementation: reuse `src/lib/security/masterKey.js` (KEK load/create, fail-closed), add `src/lib/security/envelope.js` (AES-256-GCM, AAD `v1|table|rowId|workspaceId|field`), hook encrypt/decrypt into the two repo JSON seams (`connectionsRepo.rowToConn/connToRow`, `nodesRepo.rowToNode/nodeToRow`), encrypt the five settings secrets in `settingsRepo`, add `workspaceKeys` (migration 013), run a backup-gated one-time migration, and expose rotation through CLI + owner-only admin API.
- The accepted decisions (`decisions.md`) supersede the stale ADR-0008 and GH #233 wording: switch-on activation is irreversible; established encryption survives `TOKENHOP_MULTI_USER=off`; KEK rotation preserves the YAN-363 API-key hash key by wrapping the derived key under the new KEK (never the old master); Default workspace is undeletable (D5); env-managed KEK rotation is refused with a manual conversion path (D9).
- Scope is defined by the GH #233 checklist, not the ADR deferrals. This file resolves the two remaining split calls:
  - **Rotation is YAN-365 scope.** Ship the rewrap core plus the CLI (`tokenhop keys rotate`, `--workspace <id>`) and the two owner-only admin API routes. YAN-377 keeps broader user/key/auth-recovery CLI UX.
  - **Transfer is YAN-365 scope.** Ship the versioned ciphertext/wrapped-key snapshot, strict preflight, and opaque restore. YAN-375 keeps user-aware export breadth (preferences, `disabledModels`, other new tables).
- Verification is already specified in `verification.md` as claims C1–C10 plus the adjacent-regression set and final gate. This file re-uses those claims as the merge gate and adds the final-release sequence: adversarial review → fix → CodeRabbit → CI green → squash merge → Linear Done.
- No new dependencies. Node `crypto` only. No app edits from this lane.

---

## Discovery Tables (Notes, NOT Building)

| #   | Discovery                                                                                                                                                                                                                                                                                                                                                                        | Source                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| N1  | `src/lib/security/masterKey.js` already loads the KEK with strict 32-byte validation, `0600`/`0700` fail-closed checks, symlink/O_NOFOLLOW guards, and `deriveApiKeyHashKey` (HKDF). Reuse it verbatim; do not invent a second loader.                                                                                                                                           | research-security.md §0; research-practices.md table row 1                            |
| N2  | Repo seams are the only safe encrypt points: `connectionsRepo.rowToConn`/`connToRow` and `nodesRepo.rowToNode`/`nodeToRow`. Raw-SQL readers (`gatewayResources.js:39-71`, `exportDb`, `gatewayKeyTransfer.js`) must either decrypt via the same codec or move envelopes opaquely.                                                                                                | research-technical.md §"Architecture Design"                                          |
| N3  | `updateProviderConnectionUnscoped` wraps `updateInTx` in `db.transaction`; the callback is synchronous. Node `crypto` is synchronous, so refresh stays atomic exactly as today. No `await` inside credential transactions.                                                                                                                                                       | research-technical.md §"Refresh mutation map"; verification.md C8                     |
| N4  | The multi-user switch (`isMultiUserEnabled()` in `src/lib/users/featureSwitch.js`) gates first activation and route visibility. The durable `_meta` marker (`credentialsEncryptedVersion`, `credentialsKekKid`) governs storage after activation. Off+never-enabled = byte-identical plaintext; on-then-off = encryption stays on.                                               | decisions.md D4; verification.md C10                                                  |
| N5  | The pre-migration backup is **not** a purge target. `makeProtectedBackupDir`/`prepareProtectedBackupVerifier` create the protected snapshot; after activation the cleanup step is `wal_checkpoint(TRUNCATE)` + `VACUUM` (or equivalent rebuild) with a restart-completion marker. Old backups/exports/snapshots remain plaintext by design and are documented.                   | decisions.md D7; research-security.md §Data Protection                                |
| N6  | `workspaceKeys` must be classified in `src/lib/db/tenancy.js` (`scoped`, `scopeColumn: "workspaceId"`); `tests/unit/tenancy-guard.test.js` fails on any unclassified table.                                                                                                                                                                                                      | research-practices.md table; verification.md §3                                       |
| N7  | `tokenhop keys rotate` and the admin API are owner-only, 404 while the switch is off on a never-enabled instance, and 409-refused when the KEK comes from `TOKENHOP_MASTER_KEY` (env-managed). Rotation rewraps DEKs only, O(workspaces), field ciphertext untouched.                                                                                                            | decisions.md D8, D9; research-ux.md §2.2, §2.3                                        |
| N8  | Per-workspace DEK rotation re-encrypts that workspace's fields under a fresh DEK in one transaction. Default DEK rotation additionally re-encrypts the instance secrets (`oidcClientSecret`, three SAML keys, `mitmSudoEncrypted`) in the same transaction.                                                                                                                      | decisions.md D5, D8; verification.md C6                                               |
| N9  | The YAN-363 API-key hash key is derived from the master (`deriveApiKeyHashKey`). KEK rotation must preserve it: store the derived 32-byte key wrapped under the new KEK as `_meta.apiKeyHashKeyWrapped`; freeze `_meta.apiKeysHashKid`/`apiKeys.hashKid` as the hash-key identity and add `_meta.credentialsKekKid` as the current KEK identity. One getter serves every caller. | decisions.md D6; research-technical.md §"Gateway HMAC continuity during KEK rotation" |
| N10 | MITM sudo password uses a legacy machine-id-derived key (`ENCRYPT_SALT = "9router-mitm-pwd"`). Migration decrypts the legacy `ivHex:tagHex:ctHex` value strictly once and stores the sudo plaintext under the Default DEK. On failure, activation aborts with a typed error; never silently null it.                                                                             | decisions.md D11; research-security.md §CRITICAL 1                                    |

---

## Implementation Recommendations

The implementation lanes below are sequenced by dependency. Each lane owns its files and its claims from `verification.md`. The parent session owns the final evidence gate.

### Lane 1 — Crypto module and schema (foundation)

Owns: `src/lib/security/envelope.js`, `src/lib/db/migrations/013-workspace-keys.js`, `src/lib/db/schema.js` (add `TABLES.workspaceKeys`), `src/lib/db/tenancy.js` classification.

- One module, pure crypto, no DB imports: `isEnvelope`, `encryptField`, `decryptField`, `wrapDek`, `unwrapDek`, `buildAad`, `aadDekWrap`, `aadHashKeyWrap`, `aadSettingsWrap`. Constants: `KEY_LEN = 32`, `IV_LEN = 12`, `TAG_LEN = 16`, `authTagLength: 16`, `randomBytes` per encryption.
- AAD is the exact string `v1|table|rowId|workspaceId|field`; the six test vectors and negative vectors are in `decisions.md` D1.
- Envelope is `{v:1, kid, iv, ct, tag}` with canonical base64 and strict type/length/size validation before decrypt. `kid` is not part of the AAD.
- Migration 013: `workspaceKeys(workspaceId TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE, kid TEXT NOT NULL, wrappedDek TEXT NOT NULL, createdAt TEXT NOT NULL)`. Migration is additive and idempotent (mirror `012-invitations.js` style). Add to `MIGRATIONS` and assert `latestVersion()` increments.
- Classification: `TABLE_CLASSES.workspaceKeys = { class: "scoped", scopeColumn: "workspaceId" }`.
- Bounded DEK cache: cache unwrapped DEKs only, keyed by `(workspaceId, kid)`, hard cap (e.g. 128 entries) with FIFO eviction, live-row check on every hit, zero Buffer on eviction. `clearWorkspace(workspaceId)` is called on delete, rotation, and import.
- Claims: C2 (envelope-crypto.test.js).

### Lane 2 — Activation and startup (the irreversible gate)

Owns: `src/lib/db/activateCredentialEncryption.js` (new), `src/lib/db/startupReadiness.js` (extend `defaultActivation`), `src/lib/db/migrate.js` (no change, just migration 013 wiring), protected backup helpers.

- Activation runs only when `isMultiUserEnabled()` and the durable marker is absent. Order: after `ensureOwnerBootstrap({throwOnError:true})` and after `activateGatewayKeys`, before any request handling or background timers. A rejection is sticky (existing `startupReadiness` contract).
- Steps: resolve Default workspace → adopt ownerless rows into Default (existing `adoptOwnerlessRowsUnscoped`) → protected backup → single sync transaction: create/ensure DEK per workspace, wrap API-key hash key under KEK (`_meta.apiKeyHashKeyWrapped`), encrypt every covered field, migrate settings secrets, re-key MITM sudo once (legacy decrypt → re-encrypt), write `_meta.credentialsEncryptedVersion` + `credentialsKekKid` + cleanup-pending marker.
- Cleanup after commit: checked `wal_checkpoint(TRUNCATE)` plus `VACUUM` (or rebuild) so freelist/WAL pages lose old plaintext. Crash before cleanup is fine: restart reads the cleanup-pending marker and finishes before readiness.
- Claims: C1, C3, C10, startup-reject half of C4.

### Lane 3 — Connection/node repo seams

Owns: `src/lib/db/repos/connectionsRepo.js`, `src/lib/db/repos/nodesRepo.js`, `src/lib/auth/gatewayResources.js`, `src/sse/services/tokenRefresh.js`, `src/app/api/providers/[id]/test/testUtils.js`.

- Encrypt/decrypt only inside `rowToConn`/`connToRow` and `rowToNode`/`nodeToRow`. The `SECRET_FIELDS` allow-list is one frozen export in `envelope.js` (decisions.md D10).
- `rowToConn`/`connToRow` stay synchronous; they take the DEK as an argument prepared by the async wrapper before `db.transaction`.
- `gatewayResources.decodeRow` must decrypt after principal/workspace SQL filtering; it uses the same codec.
- `tokenRefresh.js` must persist a minted `apiKey` encrypted, and must report persistence/integrity failures instead of swallowing them (current bug noted in `research-technical.md`).
- `testUtils.js` must not overwrite sibling PSD secrets from a stale snapshot; merge inside the repo transaction.
- Metadata-only responses (list/detail) must redact all covered leaves, not just the five nested keys `workspaceScope.redactConnection` currently strips. One unreadable secret must not fail the whole list (minimal raw metadata reader).
- Claims: C1 (sentinel scan through repos), C8 (refresh atomicity).

### Lane 4 — Settings, SSO, MITM

Owns: `src/lib/db/repos/settingsRepo.js`, `src/lib/users/featureSwitch.js` (narrow raw read), `src/mitm/manager.js` (legacy crypto removal), `src/lib/users/workspaceScope.js` (redaction).

- `getSettings()` returns decrypted covered fields for trusted internal callers; `readRaw()` stays raw for export/state lookup. `updateSettings` encrypts only supplied secret updates inside its existing transaction.
- `featureSwitch.js` must not decrypt all settings before keys are initialized: add a narrow raw read of `multiUserEnabled` used only by the switch. Do not import featureSwitch from crypto helpers (cycle).
- SSO (`oidc.js`, `/api/auth/oidc/test`) expects string secrets and `.trim()` — decrypted strings satisfy that. SAML keys are encrypted if present; do not invent SAML consumers.
- MITM: after activation, `manager.js` stores sudo plaintext only through the repo seam and returns sudo plaintext for the manager; the legacy `deriveKey`/`encryptPassword`/`decryptPassword` functions are deleted. Clear `globalThis.__mitmSudoPassword` on import/restore. The activated path must not double-decrypt.
- Claims: C1 (settings sentinels), C3 (MITM legacy re-key), C6 (Default DEK rotation keeps OIDC/MITM working).

### Lane 5 — Workspace deletion and cache

Owns: `src/lib/db/repos/workspacesRepo.js`, `src/lib/db/repos/usersRepo.js` (personal-workspace deletion path).

- `deleteWorkspace` must be transactional: inside one `db.transaction`, read `_meta.defaultWorkspaceId`; if target is Default, throw `409 DEFAULT_WORKSPACE_PROTECTED` with zero mutation (D5). Otherwise delete the workspace (FK cascade drops `workspaceKeys`), then evict the DEK cache synchronously.
- Personal workspace deletion (`usersRepo.deleteUserUnscoped`) must follow the same eviction path. Default is `kind = 'shared'`, so it never hits this path, but assert anyway.
- Claims: C7 (cache eviction, Default protection).

### Lane 6 — Transfer (export/import/backup)

Owns: `src/lib/db/index.js` (`exportDb`/`importDb`), `src/lib/db/helpers/gatewayKeyTransfer.js`, `src/lib/db/backup.js` (protected prefixes).

- Export carries envelopes and wrapped DEKs as opaque strings; no plaintext. The v2 snapshot format gets a new version that adds `credentialsKekKid` plus the wrapped hash key.
- Preflight validates snapshot format, KEK kid, wrapped-key authentication, and ownership/FK graph **before** any backup or destructive transaction. Wrong/missing KEK = zero mutation.
- Import restores `workspaceKeys` rows after workspaces and before credential rows in the same transaction; envelopes are copied opaquely (never decrypted/re-encrypted). A plaintext legacy payload is rejected on an encrypted instance (D8).
- `backupDbLite` copies every table except `requestDetails`; `workspaceKeys` is automatically included. Add the new protected prefix for pre-encryption/pre-rotation backups so the newest-3 prune does not delete them.
- Claims: C4 (transfer zero-mutation), C9 (export/import round-trip).

### Lane 7 — Rotation core (KEK + DEK)

Owns: `src/lib/security/masterKey.js` (add `getApiKeyHashKey` getter and rotation helpers), `src/lib/db/rotateCredentialKeys.js` (new), `src/lib/db/activateGatewayKeys.js` (root check update), the six derive callers listed in `research-technical.md` §"Gateway HMAC continuity".

- `getApiKeyHashKey(db)`: if `_meta.apiKeyHashKeyWrapped` exists, unwrap it with the current KEK and return the derived hash key; else legacy `deriveApiKeyHashKey(loadMasterKey({expectedKid: hashKid}))`. Cache the Buffer per kid generation; clear on rotation/import. Every existing direct-derive caller switches to this getter.
- KEK rotation: staged file → durable DB rewrap → atomic rename → finalize. In one sync transaction: unwrap every `workspaceKeys.wrappedDek` with the old KEK, rewrap with the new KEK, rewrap the API-key hash key, update `_meta.credentialsKekKid`, commit. Field ciphertext and `apiKeys.keyHash` bytes are byte-identical. Old KEK file is retained one generation as `master.old-<kid>-<date>` (0600).
- Env-managed KEK: refuse with `409 KEK_ENV_MANAGED`, zero mutation, and the D9 guidance text (stop server, provision same key as file, remove env, restart, verify, then rotate). Never generate a different file key for the conversion.
- Per-workspace DEK rotation: fresh DEK, re-encrypt all covered fields for that workspace with the same AAD, replace the `workspaceKeys` row, evict cache. Default DEK rotation also re-encrypts the instance secrets in the same transaction. Refresh writes racing rotation must not leave mixed generations (serialize).
- Claims: C5 (KEK rotation + restart auth), C6 (Default DEK rotation).

### Lane 8 — Rotation API and CLI

Owns: new routes `POST /api/settings/keys/rotate` and `POST /api/workspaces/[id]/keys/rotate`, `routePolicy.js` rows, `cli/cli.js` dispatch, `cli/src/cli/commands/keysRotate.js`, CLI API client.

- Owner-only, `alwaysProtected`, `multiUserOnly`. 404 while the switch is off on a never-enabled instance. 409 `KEK_ENV_MANAGED` for env-sourced KEK. No key material in request or response (counts and kids only).
- CLI follows the `authSetupToken`/`dataMigrate` pattern: loopback request to the running server, authenticated CLI token, no second writer process. `--dry-run`, `--yes`, `--json`. Progress per workspace with verification counts.
- UX copy per `research-ux.md` §2.2: plan → confirm → rewrap → verify → backup reminder. Audit event `keys.rotate` with actor, old/new kid, counts, result; never any key material.
- Claims: C5 (route 404/refusal cases), C6 (DEK rotation route).

---

## Non-overlap Map (YAN-365 vs later issues)

| Concern                                                                                    | YAN-365 (this issue)                                               | YAN-375                                                                     | YAN-377                                          |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------ |
| Crypto module, `workspaceKeys`, migration, repo seams, settings/MITM, cache, Default guard | Owns fully                                                         | —                                                                           | —                                                |
| KEK rotation core + CLI + admin API                                                        | Owns fully (per-workspace DEK rotation included; **not** deferred) | —                                                                           | Broader user/key/auth-recovery CLI UX            |
| Export/import of envelopes + wrapped keys + marker + wrapped hash key                      | Owns fully (strict preflight, opaque restore)                      | User-aware export breadth (preferences, `disabledModels`, other new tables) | —                                                |
| `importDb` wipe list addition for `workspaceKeys`                                          | Owns (must not silently drop DEKs)                                 | —                                                                           | —                                                |
| Backup protected prefixes                                                                  | Owns (new pre-encryption/pre-rotation prefixes)                    | —                                                                           | —                                                |
| Docs                                                                                       | —                                                                  | —                                                                           | YAN-379 (key backup, key loss, operator wording) |

The boundary is encryption state vs. user data. If a new table appears in the snapshot that is not encryption state, YAN-375 owns it.

---

## Risk Assessment (Notes)

| Risk                                                 | Severity            | Mitigation grounded in                                                                                        |
| ---------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------- |
| KEK loss = all credentials unrecoverable             | Critical, by design | D3 fail-closed; D9 guidance; YAN-379 docs; startup E1/E2 copy                                                 |
| KEK rotation breaks YAN-363 API-key hashes           | Critical            | D6: derived hash key wrapped under new KEK; `apiKeysHashKid` frozen; one getter; C5 test                      |
| Default workspace deletion destroys instance secrets | High                | D5: `409 DEFAULT_WORKSPACE_PROTECTED` unconditionally, zero mutation, in-transaction check; C7 test           |
| Default DEK rotation orphans instance secrets        | High                | D5: Default DEK rotation re-encrypts settings secrets in the same transaction; C6 test                        |
| Crypto-shredding cannot erase old backups/WAL        | High                | D7: cleanup covers live DB only; old copies documented, not cleaned; PR states the limit                      |
| Raw-SQL readers bypass encryption                    | High                | Lane 3/6 explicit list: `gatewayResources`, `exportDb`, `gatewayKeyTransfer`; C1 sentinel scan catches misses |
| Mixed plaintext/ciphertext misread                   | Medium              | `isEnvelope` strict validator; C3 mixed fixture; activation idempotent                                        |
| Refresh transaction broken by async crypto           | Medium              | Sync crypto only inside `db.transaction`; C8 test                                                             |
| Over/under-encryption of `providerSpecificData`      | Medium              | One frozen allow-list (D10); C1 sentinel scan; C2 allow-list negative vectors                                 |
| MITM portability regression                          | Medium              | D11: legacy decrypt once, abort on failure; C3 test                                                           |
| Cache holds DEKs for deleted workspaces              | Low                 | Live-row check + `clearWorkspace` on delete/rotation/import; C7 test                                          |

---

## Alternative Approaches (Notes)

| Alternative                                 | Status   | Why rejected                                                                                                                                    |
| ------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Whole-DB SQLCipher                          | Rejected | Native dependency (handbook §8); no per-workspace shredding; same KEK problem.                                                                  |
| One instance-wide field key                 | Rejected | No per-workspace blast radius; rotation is O(rows); deletion cannot crypto-destroy.                                                             |
| OS keychain (secret-service/Keychain)       | Rejected | Headless/Docker targets; 0600 file is equivalent for the threat model.                                                                          |
| Envelope in separate ciphertext columns     | Rejected | Schema churn per provider; breaks JSON `data` consumers; envelope-in-place keeps row shape stable.                                              |
| Encrypt in adapter/driver layer             | Rejected | Repo seams are fewer and typed; driver cannot know field sensitivity or workspace AAD.                                                          |
| Defer per-workspace DEK rotation to YAN-377 | Rejected | GH #233 checklist governs; issue text says "DEKs themselves are rotated per workspace". Ship in YAN-365.                                        |
| Defer CLI rotation to YAN-377               | Rejected | Same checklist governs; CLI is the operator-facing surface for the same core. Ship minimal `tokenhop keys rotate` here; YAN-377 extends CLI UX. |
| Defer transfer snapshot to YAN-375          | Rejected | Checklist item "exports contain ciphertext plus the wrapped DEKs" is YAN-365 scope. YAN-375 adds breadth, not the encryption snapshot.          |

---

## Task Breakdown Preview (parallel lanes, dependency-resolved)

Order is topological. Lanes 1–2 run first; 3–8 can run in parallel once 1–2 are green.

1. Lane 1 (crypto + schema) → C2 green. No other lane starts until this is stable.
2. Lane 2 (activation) → C1, C3, C10 green; startup-reject half of C4 green.
3. Lane 3 (connection/node seams) → C8 green; sentinel scan C1 passes through repos.
4. Lane 4 (settings/MITM) → settings sentinels C1; MITM re-key C3; OIDC/SAML strings decrypt.
5. Lane 5 (workspace deletion) → C7 green.
6. Lane 6 (transfer) → C4 transfer cases, C9 green.
7. Lane 7 (rotation core) → C5, C6 green.
8. Lane 8 (API/CLI) → route refusal cases; CLI transcript; audit event.
9. Parent: adjacent regression set, final gate, adversarial review, CodeRabbit, CI, merge, Linear Done.

Each lane writes its tests first (TDD, handbook §7.4). The parent reruns the final evidence on the rebased head.

---

## Final Evidence and Release Sequence (parent validation owner)

After implementation is complete, the parent session runs this exact sequence:

1. **Targeted claims:** run C1–C10 in both switch states (`TOKENHOP_MULTI_USER=off` and `=on`) with `tests/vitest.config.js`. Paste output in the PR "Verification evidence" section.
2. **Adjacent regression set:** run the 14-file set from `verification.md` §4 once on the final head.
3. **Final gate:** `npm run lint`, `TOKENHOP_MULTI_USER=off npm test`, `TOKENHOP_MULTI_USER=on npm test`, `npm run build`, `npm run lint:brand`, and `git diff origin/master -- package.json package-lock.json tests/package.json tests/package-lock.json cli/package.json` must be empty (no dependency changes).
4. **Adversarial self-review + `/security-review`:** every real finding fixed with a regression test only when it changes a required path. The checklist is in `verification.md` §5 (no decrypt-error fallback to plaintext, no `await` inside credential transactions, every writer through the encrypt seam, no key/IV/tag/plaintext in logs/audit/responses).
5. **CodeRabbit review:** open the PR, wait for the first CodeRabbit pass, address every actionable comment (fix or reply-then-resolve). Do not merge before this.
6. **CI green on the rebased head:** 3 brands × switch off/on, plus build. No `known-fails.txt` additions for YAN-365 tests.
7. **Squash merge:** PR title `feat(security): envelope encryption of credentials at rest (per-workspace DEKs)`, body includes "Closes YAN-365", Decisions, Isolation matrix, Verification evidence. Squash-merge to `master`, delete the branch, remove the worktree.
8. **Linear Done:** move YAN-365 to Done and comment the PR link, merge commit, and summary. The maintainer copies `decisions.md` D1–D11 into the main-checkout ADRs.

---

## Key Decisions Needed (already accepted in `decisions.md`, restated for the PR)

| #   | Decision                                                                                            | Consequence                                                                                      |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| D1  | Field AAD is `v1\|table\|rowId\|workspaceId\|field`                                                 | ADR-0008 text must be amended; test vectors are frozen.                                          |
| D3  | Missing/wrong/corrupt KEK fails closed; no regeneration, no plaintext fallback                      | Startup readiness rejects stickily; degraded boot is rejected.                                   |
| D4  | Established encryption is independent of `TOKENHOP_MULTI_USER`                                      | Off+never-enabled is unchanged; on-then-off stays encrypted.                                     |
| D5  | Default workspace is undeletable (`409 DEFAULT_WORKSPACE_PROTECTED`)                                | Prevents destruction of SSO/MITM secrets and startup bootstrap.                                  |
| D6  | Derived API-key hash key is wrapped under the KEK; `apiKeysHashKid` frozen, `credentialsKekKid` new | Gateway keys survive KEK rotation; old master never stored.                                      |
| D7  | Checked WAL TRUNCATE + VACUUM after activation; old backups/exports documented, not cleaned         | Shredding claim is live-only; PR must state the limit.                                           |
| D8  | CLI/admin rotation, per-workspace DEK rotation, and ciphertext transfer are YAN-365 scope           | No deferral of rotation or snapshot to YAN-375/377.                                              |
| D9  | Env-managed KEK rotation refused (`409 KEK_ENV_MANAGED`) with manual conversion path                | Two-key protocol deferred; never report env rotation complete while restart injects the old key. |
| D10 | Coverage allow-list as listed; proxy pools stay plaintext, flagged for discovery                    | PR must state proxy pools remain plaintext.                                                      |
| D11 | Legacy MITM value decrypts strictly once; on failure activation aborts                              | Never silently null the sudo password.                                                           |

---

## Open Questions (Notes)

1. **Backup acknowledgment persistence:** after KEK rotation, does `settings.masterKeyBackupAcknowledgedAt` reset to re-arm the dashboard callout? Recommendation: yes (research-ux.md OQ5). Confirm with maintainer.
2. **`master.old-…` retention and exports:** does the retained old key file plus rolling DB backups cover the restore window, or should `keys status` warn while an old key file exists that no backup verification has been run? (Overlaps YAN-375/YAN-379.)
3. **Typed-name confirmation strictness:** exact match vs. case-insensitive/trimmed for workspace deletion. Recommendation: exact match (research-ux.md OQ4). Confirm with maintainer.
4. **Dashboard key-status row:** read-only row in Settings → Data & backup (path, kid, rotatedAt) for v1.1.0, or fully deferred? Recommendation: ship read-only row with the existing backup callout (research-ux.md OQ2). Confirm with maintainer.
5. **Proxy-pool discovery:** decide the outcome of D10's proxy-pool credential check. File a follow-up only if discovery confirms stored credentials there.

---

## Relevant Files

- `src/lib/security/masterKey.js` — KEK loader, `deriveApiKeyHashKey`, strict env/file handling
- `src/lib/db/repos/connectionsRepo.js` / `nodesRepo.js` — encrypt/decrypt seams; refresh transaction
- `src/lib/db/repos/settingsRepo.js` — settings secrets seam
- `src/lib/db/schema.js` / `migrations/013-workspace-keys.js` — `workspaceKeys` DDL
- `src/lib/db/tenancy.js` — table classification
- `src/lib/db/startupReadiness.js` / `activateGatewayKeys.js` — startup latch, backup-gated activation precedent
- `src/lib/db/index.js` / `helpers/gatewayKeyTransfer.js` — export/import, transfer parity
- `src/lib/db/backup.js` — protected backup helpers
- `src/lib/auth/gatewayResources.js` — raw gateway reads
- `src/lib/users/featureSwitch.js` — the only switch reader
- `src/mitm/manager.js` — legacy machine-id crypto to retire
- `src/lib/settingsConfigDoc.js` — `SECRET_SETTING_KEYS`
- `tests/setup/tenancyHarness.js` — test fixtures
- `tests/unit/gateway-key-*.test.js`, `background-token-refresh.test.js` — test patterns
- `docs/plans/yan-365-envelope-encryption/decisions.md` — accepted decisions (D1–D11)
- `docs/plans/yan-365-envelope-encryption/verification.md` — claims C1–C10, commands, budget
- `docs/plans/yan-365-envelope-encryption/research-*.md` — seven lane reports
- `docs/users/adr/0008-encryption-at-rest.md` — accepted ADR (main checkout; amendments in `decisions.md`)
- `docs/users/spec.md` — decisions 8, 9, 10, 52
- `docs/users/README.md` — handbook §4–§8
