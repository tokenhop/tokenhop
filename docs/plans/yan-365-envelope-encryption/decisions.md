# YAN-365 — Accepted Decisions and ADR Amendments

Status: **Accepted by parent validation owner, 2026-10-06.** Binding for YAN-365 planning and implementation.

Why this file exists: the canonical ADRs live in the main checkout under `docs/users/adr/`, which is gitignored and absent from this worktree. This file is the durable record of the ADR-0005 and ADR-0008 amendments until a maintainer copies them into the ADR set. Do not edit the main checkout from this worktree.

Sources: GH #233 and live Linear YAN-365 (approved "Design decisions (YAN-350)" appendix), ADR-0005, ADR-0008, spec decisions 5/8/9, and the seven `research-*.md` files in this directory.

## D1 — Field AAD (amends ADR-0008)

- **Decision:** the field AAD is the UTF-8 string `v1|<table>|<rowId>|<workspaceId>|<field>`. It replaces ADR-0008's `connectionId|workspaceId` and matches the GH #233 checklist (`table|rowId|workspaceId|field`) with a version prefix.
- **Rules:**
  - Encrypt and decrypt share one builder.
  - Decrypt recomputes the AAD from authoritative SQL row coordinates, never from envelope contents or caller input.
  - Every component must be non-empty and must not contain `|` or any control character (U+0000–U+001F, U+007F); otherwise throw before any cipher call.
  - `table` comes from a constant, `field` from a fixed allow-list. Nested fields use dotted paths (`providerSpecificData.clientSecret`).
  - `kid` stays in the envelope and out of the AAD.
  - A NULL `workspaceId` cannot be encrypted: activation adopts ownerless rows first.
- **Wrap AAD:**
  - DEK wrap: `v1|workspaceKeys|<workspaceId>|<workspaceId>|dek:<dekKid>`. This extends ADR's `workspaceId|kid` with a table and domain prefix.
  - Wrapped API-key hash key: `v1|_meta|apiKeyHashKey|<defaultWorkspaceId>|hashKid:<hashKid>`.
  - Instance settings: `v1|settings|1|<defaultWorkspaceId>|<settingKey>`.
- **Exact test vectors.** UTF-8 AAD bytes and their SHA-256, computed with `node:crypto`. Tests must assert the builder output equals the string and that the hash matches:

| Case                 | AAD string                                                                                                                               | SHA-256(AAD)                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| connection top-level | `v1\|providerConnections\|22222222-2222-4222-8222-222222222222\|11111111-1111-4111-8111-111111111111\|refreshToken`                      | `0c364587c19a4ddad08085641d9368dd32b20b9921e5592f2a01e457259d7c1c` |
| connection nested    | `v1\|providerConnections\|22222222-2222-4222-8222-222222222222\|11111111-1111-4111-8111-111111111111\|providerSpecificData.clientSecret` | `48fc66c5f4ca0e4d22c9091c412cc36cebc55c92b79ac13649ac331458eb1117` |
| node                 | `v1\|providerNodes\|33333333-3333-4333-8333-333333333333\|11111111-1111-4111-8111-111111111111\|apiKey`                                  | `7024dbdb9768cba746cd058531555ea63312995936def84f1fcb1cec2cdc5fc5` |
| instance setting     | `v1\|settings\|1\|00000000-0000-4000-8000-000000000000\|oidcClientSecret`                                                                | `61bfbc36d1db3d2d1816e593816329e80069b3637c276c26c2148cc2b9e317c3` |
| DEK wrap             | `v1\|workspaceKeys\|11111111-1111-4111-8111-111111111111\|11111111-1111-4111-8111-111111111111\|dek:dk_0123456789abcdef`                 | `8525b911992f9f5d565da8e36e1f1871d9318a13858f1a7c14d27df938003dfc` |
| hash-key wrap        | `v1\|_meta\|apiKeyHashKey\|00000000-0000-4000-8000-000000000000\|hashKid:0123456789abcdef`                                               | `4e1f3471539330d57d2937768c23e4491aea963aca5c9f949ad37f0ae5754adc` |

The pipes are escaped only for the Markdown table; the real strings use a single `|`. Negative vectors must throw: a component containing `|`, `\n`, `\u0000` or `\u007f`; an empty component; a NULL workspace; a field not on the allow-list.

- **Consequence:** moving a row between workspaces (YAN-701) must decrypt and re-encrypt explicitly.

## D2 — Envelope and primitives (confirms ADR-0008)

- **Primitives:** AES-256-GCM, 32-byte keys, a fresh 12-byte random IV per encrypt or wrap, and an explicit `authTagLength: 16`.
- **Envelope:** `{v:1, kid, iv, ct, tag}` with canonical base64 and strict type, length and size validation before decrypt.
- **Plaintext release:** plaintext is returned only after `final()` succeeds; partial output is discarded.
- **Dependencies:** Node `crypto` only.
- **Key IDs:** DEK kids are random and unrelated to the root ID.

## D3 — Missing, wrong or corrupt KEK fails closed (clarifies ADR-0008)

- **Behaviour:** on established encrypted storage, startup readiness rejects stickily before serving or starting background writers. This reuses the `startupReadiness.js` and YAN-363 contract.
- **Never:** auto-generate a replacement root, fall back to plaintext or legacy MITM derivation, or substitute an empty credential.
- **Superseded wording:** ADR-0008's "instance starts, connections report unreadable" no longer applies to a missing or wrong root.
- **Per-row integrity failures:** after a successful start, these fail that credential use with a typed error. They do not fail metadata listing.

## D4 — Established encryption is independent of the switch (clarifies ADR-0008 and spec 9)

- **Durable marker:** a strictly validated `_meta` pair (`credentialsEncryptedVersion`, `credentialsKekKid`, plus cleanup state) latches encryption.
- **After activation:** reads decrypt, writes encrypt, a missing key fails closed, and a malformed marker fails closed, regardless of `TOKENHOP_MULTI_USER`.
- **Never-enabled install with switch off:** no master key, no DEKs, no encryption backup, no marker. Behaviour is unchanged and new routes return 404.
- **Default:** the switch default stays off until YAN-380.

## D5 — Default workspace undeletable, unconditionally (amends ADR-0001/0008 lifecycle)

- **Refusal:** deleting the workspace whose id is `_meta.defaultWorkspaceId` is refused with `409 DEFAULT_WORKSPACE_PROTECTED` and zero mutation, whether or not it currently holds instance secrets. The check and the delete run in one transaction.
- **Rationale:** Default holds the SSO and MITM secrets under its DEK, and startup (`requireOwnerAndDefault`) needs Default anyway.
- **Rotation:** rotating the Default DEK re-encrypts `oidcClientSecret`, `samlPrivateKey`, `samlDecryptionKey`, `samlSigningKey` and `mitmSudoEncrypted` in the same transaction.

## D6 — Preserve the API-key hash key across KEK rotation (amends ADR-0005 and ADR-0008)

- **What is stored:** the **derived** 32-byte key `HKDF(originalMaster, "tokenhop/api-key-hash")` (current `deriveApiKeyHashKey`), wrapped under the KEK as `_meta.apiKeyHashKeyWrapped` and written during the activation transaction. Never the old master.
- **Identity split:**
  - `_meta.apiKeysHashKid` and `apiKeys.hashKid` are frozen as the **hash-key identity**.
  - The new `_meta.credentialsKekKid` is the **current KEK identity**.
  - The two are equal until the first rotation.
- **Single getter:** one getter supplies the hash key to every caller. That covers `apiKeyPrincipal.js`, `users/apiKeyManagement.js`, `cliToolSettingsRepo.js`, `usageRepo.js`, `app/api/cli-tools/codex-settings/route.js`, the `db/index.js` import root proof, and the `activateGatewayKeys.js` root check. The root check validates by KEK kid plus a successful unwrap.
- **Rotation:** KEK rotation rewraps the DEKs and the hash key atomically. `apiKeys.keyHash` bytes and the unwrapped hash key stay identical. The same raw `th_` and legacy `sk-` keys authenticate after a restart.
- **Transfer:** the transfer snapshot gets a new version carrying `credentialsKekKid` plus the wrapped hash key. Existing v2 behaviour is unchanged for unrotated instances.

## D7 — Physical plaintext cleanup at activation; old copies documented (amends ADR-0008 shredding claim)

- **Cleanup:** after the encryption commit, perform a checked WAL checkpoint (TRUNCATE) plus `VACUUM` (or an equivalent rebuild) so freelist and WAL pages lose the old plaintext. A durable cleanup-pending marker forces restart to finish cleanup before readiness.
- **Limit:** pre-existing copies are **not** cleaned. That covers the protected pre-activation backup (kept deliberately, private 0700/0600), earlier rolling, `pre-import-*` and `gateway-key-activation-*` backups, prior exports and filesystem snapshots. Docs (YAN-379) and the PR state this.
- **Shredding claim:** crypto-shredding is limited to live state. Deleting a workspace removes its DEK row and evicts the cache. A historical backup that still holds its wrapped DEK remains decryptable with a surviving KEK. ADR-0008's "cryptographically unrecoverable" backup claim is withdrawn.

## D8 — Rotation and transfer are in YAN-365 scope (amends ADR-0008 deferrals to YAN-377/YAN-375)

The issue checklist governs. YAN-365 ships:

- **KEK rotation:** CLI `tokenhop keys rotate` (loopback to the running server, authenticated CLI owner principal) and the owner-only admin API `POST /api/settings/keys/rotate`. Both delegate to one rotation service using a crash-recoverable staged file → durable DB rewrap → atomic rename → finalize protocol with restart recovery.
- **Per-workspace DEK rotation:** CLI `tokenhop keys rotate --workspace <id>` and `POST /api/workspaces/[id]/keys/rotate`, owner-only.
- **Ciphertext backup/export/restore:** snapshots carry the envelopes, `workspaceKeys`, the marker and the wrapped hash key, with original IDs. Preflight proves the root and authenticates the wraps before any backup or wipe; a wrong or missing KEK means zero mutation. Plaintext legacy payloads are rejected on an encrypted instance.

YAN-377 keeps general user, key and auth-recovery CLI UX. YAN-375 keeps user-aware export breadth (preferences, `disabledModels`, new tables beyond encryption).

## D9 — Env-managed KEK: refuse automatic KEK rotation

- **Refusal:** when `TOKENHOP_MASTER_KEY` is set, automatic KEK rotation (CLI and API) is refused with `409 KEK_ENV_MANAGED` and no mutation. The process cannot atomically update the deployment environment and the DB.
- **Guidance in the response:** env-managed roots can't be rotated in-process. Back up DB plus the current key separately. To move to file management, stop the server, provision the **same current key** as 32 raw bytes in `DATA_DIR/keys/master` (0600 inside 0700 `keys/`), remove `TOKENHOP_MASTER_KEY` from deployment configuration, restart, and verify the stored KEK kid and gateway authentication before rotating. Never generate a different file key for this conversion or overwrite an existing key file without proving identity. Alternatively, wait for the approved manual two-key protocol.
- **Per-workspace DEK rotation still works** under an env-managed KEK.
- **Deferred:** a manual two-key (old/new env) restart protocol. Do not invent storage of old masters on disk or in the DB to work around this.
- **Never:** report env rotation complete while the next restart would still inject the old key.

## D10 — Coverage minimum; proxy pools flagged

- **Covered:**
  - Connection `accessToken`, `refreshToken`, `idToken`, `apiKey` (including cookie-auth providers storing the cookie in `apiKey`).
  - `providerSpecificData` `clientSecret`, `copilotToken`, `idToken`, `firebaseIdToken`, `mimoPassToken`, `cookie`, `apiKey` and `secretAccessKey`.
  - Secret-bearing provider-node leaves if present (`apiKey`, tokens, auth headers).
  - Settings `oidcClientSecret`, `samlPrivateKey`, `samlDecryptionKey`, `samlSigningKey` and `mitmSudoEncrypted`.
- **Discovery:** the central allow-list gets one coverage fixture per observed provider shape.
- **Proxy pools are not in the issue.** `proxyPools.data` (no `workspaceId`) and credential-bearing URLs (userinfo) are **flagged as a discovery item, not encrypted** in YAN-365. The PR must state that they remain plaintext. File a follow-up only if discovery confirms stored credentials there. No other unjustified expansion.
- **Out of scope:** bcrypt hashes, keyed API-key hashes, the MITM internal verifier, the JWT secret file, env secrets and usage/request tables.

## D11 — MITM legacy re-key

- **One-time migration:** the activation migration strictly decrypts the legacy `ivHex:tagHex:ctHex` machine-derived value once and stores the sudo plaintext under the Default DEK.
- **Failure:** abort activation with a typed error and operator guidance to re-enter or clear the sudo password. Never silently null it.
- **After activation:** the activated path performs no machine-derived encryption.

## D12 — UX proposals resolved (from planning UX lane)

- **Old key file after KEK rotation: not kept.** The previous KEK exists on disk only while the staged rotation is in flight (crash recovery), then is removed after the DB commit. The CLI warns that backups taken before rotation need the previous key, which the operator must keep offline if they want those backups restorable. Keeping it beside the DB would let a disk leak decrypt older backups.
- **`--yes`: kept.** `tokenhop keys rotate` asks for confirmation that the new key is backed up; `--yes` skips it for scripted use.
- **`--dry-run` and `--json`: dropped** (YAGNI). Add when automation needs machine output.
- **Dashboard "I've saved the key" acknowledgment: dropped.** No new dashboard UI in YAN-365; the CLI and startup log carry the backup warning.

## Open items still for the maintainer

- **Tenancy wording:** copy D1–D9 into ADR-0005 and ADR-0008 in the main checkout. Record the ADR-0001 tenancy wording on Default undeletability.
- **Proxy-pool discovery:** decide the outcome of the D10 discovery.
- **Two-key protocol:** schedule and design the deferred manual env-KEK protocol (D9).
