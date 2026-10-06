# Security Research — YAN-365 Envelope Encryption (GH #233)

Lane: security. Worktree: `/home/yandy/Projects/github.com/tokenhop/tokenhop-yan-365`.
Refs: GH #233 (mirror of YAN-365); main-checkout `docs/users/README.md` (§3-§9), `docs/users/spec.md` row 8, ADR-0008 (`docs/users/adr/0008-encryption-at-rest.md`); existing `src/lib/security/masterKey.js`; persistence `src/lib/db/index.js` (`exportDb`/`importDb`), `src/lib/db/schema.js`, `src/lib/db/backup.js`, `src/lib/db/repos/connectionsRepo.js`, `nodesRepo.js`, `workspacesRepo.js`; `src/mitm/manager.js` (`ENCRYPT_SALT`, `deriveKey`, `encrypt/decryptPassword`); `src/lib/settingsConfigDoc.js` (`SECRET_SETTING_KEYS`).
OWASP cross-check: Cryptographic Storage Cheat Sheet (AES-256-GCM, 96-bit random nonce, ≥128-bit tag, AAD binding, no ECB/CBC-without-MAC, HKDF key separation), Key Management Cheat Sheet (fail closed, no hard-coded keys, least-privilege storage 0600/0700, rotation, crypto-shredding, audit of key lifecycle).

## Executive Summary

- Design is sound: KEK (env or 0600 file, never in DB) wraps per-workspace DEKs; fields encrypted with AES-256-GCM + AAD binding rows/workspaces; Node `crypto` only; crypto-shredding on workspace delete; migration idempotent behind switch with pre-migration backup. Matches OWASP envelope guidance.
- Residual risk concentrates in **key-file lifecycle, AAD/nonce discipline, migration mixed-state, rotation atomicity, cache/WAL remnants, export/import trust, and admin-scope honesty**. Biggest open hazards: (1) legacy machine-id MITM key still live until cutover; (2) mutation paths that write `data` blobs (`connToRow`, refresh merge, nodes/proxyPools/settings) must all funnel through encrypt-on-write or secrets leak back to plaintext silently; (3) import path currently wipes/reinserts without knowing `workspaceKeys` (owned by YAN-375) — YAN-365 must not silently drop DEK rows or imports become data-loss events.
- `masterKey.js` implementation is strong (strict base64, symlink/O_NOFOLLOW, 0600/0700 fail-closed, atomic publish via link, no chmod-of-existing). Reuse it verbatim; do not invent a second KEK loader.
- Scope boundary must stay explicit in UI + docs: protects DB/backup/export leaks; **does not** protect against root, live-process/memory attacker, or instance admin (unattended refresh requires KEK in memory).

## Findings by Severity

### CRITICAL

1. **Legacy MITM key (`src/mitm/manager.js:194,262-282`) still machine-id-derived with static salt `"9router-mitm-pwd"`.**
   Predictable KDF input (machine id is low-entropy/host-readable; fallback is pure static hash), non-standard `iv:tag:ct` hex format, no AAD/kid/version. Any host-info leak weakens it.
   Mitigation: re-encrypt `mitmSudoEncrypted` under Default-workspace DEK at migration; retire `deriveKey/encryptPassword/decryptPassword`; delete legacy code path. Keep one decrypt-legacy→encrypt-new bridge only during idempotent migration, then remove. **Confidence**: High.

2. **Encrypt-on-write must cover every mutation path or secrets regress to plaintext.**
   `connToRow`/`upsert` (`connectionsRepo.js:74-131`), `updateInTx` refresh merge (`342-351`), `nodesRepo`, `proxyPoolsRepo` (no workspace scoping), settings blob writes (`oidcClientSecret`, SAML keys, `mitmSudoEncrypted`), OAuth credential manager/background refresh writers all serialize `data` JSON. One missed writer persists plaintext inside an "encrypted" DB; scan test must catch it but prevention is centralizing secret-field encrypt/decrypt in one module called by all repos.
   Mitigation: single `encryptSecrets(obj, aadCtx)` / `decryptSecrets` helper with explicit SECRET_FIELD list per provider registry; repos never touch raw secret fields; plaintext-scan test over raw `data` columns. **Confidence**: High.

3. **Missing/unreadable KEK must fail closed — never silent plaintext.**
   Issue demands fail-fast; ADR-0008 test expects connections "report unreadable, no crash, no partial decryption". Any fallback that writes plaintext when KEK absent (or catches decrypt errors and returns plaintext) converts key loss into credential leak.
   Mitigation: decrypt failure → typed `DECRYPT_UNREADABLE` error surfaced as "re-link required", row untouched; writes blocked unless KEK+DEK available; no `catch → return plaintext`; startup check `loadMasterKey({create:true})` only when switch on, else inert. **Confidence**: High.

4. **Import/export must not destroy or leak DEKs (trust boundary with YAN-375).**
   `exportDb` (`src/lib/db/index.js:270+`) emits plaintext JSON of all connections/nodes today; `importDb` wipes and reinserts and its wipe list does not know `workspaceKeys`. Risks: (a) exporting plaintext post-encryption defeats the feature; (b) importing a payload without DEKs then deleting existing `workspaceKeys` = crypto-shredding the live instance by accident; (c) cross-instance import with different KEK must be rejected, not partially merged.
   Mitigation (contract with YAN-375): export carries envelopes + `wrappedDek` rows, never plaintext; import is all-or-nothing in a transaction, verifies KEK can unwrap every DEK before wiping, aborts with clear error on KEK mismatch; documents same-KEK requirement. **Confidence**: High.

5. **AAD must bind `table|rowId|workspaceId|field` (issue spec), not the weaker ADR draft `connectionId|workspaceId`.**
   Without table + field in AAD, a `refreshToken` envelope can be transplanted into `apiKey` of the same row, or a connection envelope into a node row with the same id scheme, and still authenticate.
   Mitigation: canonical AAD `v1|table|rowId|workspaceId|field`, fixed order, `|`-free validated ids or length-prefixed encoding; every decrypt recomputes AAD from live row coordinates, never from stored envelope fields; tests for field-swap and cross-table swap. **Confidence**: High (OWASP: AAD must cover full context).

6. **Nonce/tag discipline: 96-bit random nonce per encryption, 128-bit tag, never reuse under same DEK.**
   GCM nonce reuse under one key is catastrophic (auth + confidentiality loss). Must use `crypto.randomBytes(12)` fresh per field encryption and `authTagLength: 16`.
   Mitigation: single encrypt helper owns nonce generation; envelope stores `iv` (12 B) + `tag` (16 B) separately (exact `{v,kid,iv,ct,tag}` base64, no hex-concat legacy format); reject envelopes with wrong `iv`/`tag` lengths before decrypt. **Confidence**: High.

### WARNING

1. **Envelope marker validation (version/kid parsing) is an attacker-influenced parse surface.**
   Mixed plaintext/encrypted state means readers must distinguish legacy plaintext from envelopes; sloppy `JSON.parse` + duck-typing can misclassify, throw unhandled, or — worst — treat attacker-crafted `{"v":1,…}` strings as envelopes and feed them to decrypt with oracle-like error differences.
   Mitigation: strict envelope validator (`v===1`, `kid`/`iv`/`ct`/`tag` canonical base64, exact byte lengths, unknown `v` → hard error); plaintext detection only for allow-listed legacy shapes during migration window; constant generic error messages (`DECRYPT_FAILED`, no "bad tag" vs "bad base64" distinction to callers); error details only in server logs without secret material. **Confidence**: Medium (standard practice; exact helper is new code).

2. **Key-file concurrency/permissions beyond `masterKey.js` — DEK cache and rotation writers.**
   `masterKey.js` handles KEK creation race well (exclusive tmp + `link`, never replace). DEK generation/rotation/rewrap code must match: concurrent `keys rotate` + field writes, or two rotations, must not leave half-rewrapped `workspaceKeys` rows.
   Mitigation: rotation in one DB transaction (read all wrapped DEKs → unwrap with old KEK → wrap with new KEK → update all + KEK kid marker → commit); field writes join the same DEK-version read; file/dir perms for any new key-adjacent files reuse `assertPrivateMode` semantics (0700/0600, fail closed, Windows best-effort documented). **Confidence**: Medium.

3. **DB/file rotation atomicity and recovery ordering.**
   KEK rotation (rewrap DEKs only, O(workspaces)) vs per-workspace DEK rotation (re-encrypt fields, O(rows)) have different failure windows. Crash between "new DEK written" and "fields re-encrypted" can orphan rows under an old `kid`.
   Mitigation: keep both wrapped DEKs (`kid` + `prevKid`) until all rows verify under new `kid`, then delete old; readers try current then previous kid; rotation command prints backup reminder and verifies unwrap of every DEK before committing; document rollback (old KEK backup restores access). **Confidence**: Medium.

4. **Decrypt cache: bounds, TTL, and invalidation.**
   Issue requires bounded cache cleared on workspace deletion. Unbounded/global cache also keeps deleted-workspace DEKs and secrets alive in memory past destruction, defeating crypto-shredding in the live process.
   Mitigation: LRU with hard cap (e.g. ≤1000 entries or time-boxed), per-`(workspaceId,kid)` + per-field entries, `deleteWorkspace` path evicts workspace keys and secrets synchronously inside the same transaction completion; no cache for wrapped DEKs beyond process memory (never persisted); consider `mlock`/zeroing out of scope — document as not defended. **Confidence**: Medium.

5. **WAL/journal and SQLite freelist plaintext remnants.**
   Adapters use WAL (`betterSqliteAdapter.js`, `bun/nodeSqliteAdapter.js` checkpoint TRUNCATE). Rewriting a `data` blob leaves old plaintext pages in `-wal`/`-shm`, freelist, and pre-migration backups. Post-migration DB file still contains recoverable plaintext.
   Mitigation: after migration run `VACUUM` + WAL checkpoint + fsync; document that old backups (incl. pre-migration safety backup and `gateway-key-activation-*` protected copies) still hold plaintext and need manual retention/destruction; consider `PRAGMA secure_delete=ON` for future deletes (does not rewrite existing pages — call it out). **Confidence**: Medium (SQLite behavior well established; exact adapter wiring needs verification).

6. **Refresh-token rotation path must stay atomic and authenticated.**
   `updateProviderConnection` merge runs inside transaction today; adding decrypt→call-provider→encrypt steps risks TOCTOU (two refreshes interleaving) and writing partially-decrypted blobs on provider error.
   Mitigation: keep single transaction: read envelope → decrypt in memory → refresh → encrypt → write; on refresh/decrypt failure write nothing (row keeps last-known-good envelope); existing single-use-refresh tests extended with tampered-envelope case asserting no write. **Confidence**: Medium.

7. **Settings secrets and `SECRET_SETTING_KEYS` redaction interplay.**
   `oidcClientSecret`/SAML keys/`mitmSudoEncrypted` move under encryption, but `SECRET_SETTING_KEYS` redaction (`settingsConfigDoc.js:60-74`) must still apply to decrypted values at every read surface (settings GET, config export, DB snapshot readback per header comment). Decrypt-then-redact ordering bugs re-expose secrets through the API the redaction was built to close (YAN-607).
   Mitigation: decrypt at repo layer, redact at serialization layer, never store decrypted in `settings` cache; add regression tests hitting settings GET + config export asserting redaction of decrypted values. **Confidence**: Medium.

### ADVISORY

1. **Threat-model honesty: admin/process access is out of scope — say so in product, not just docs.**
   Unattended refresh keeps KEK in memory, so instance admin, root, memory dump, and live-process attackers can decrypt. Users may otherwise assume "encrypted" means "admin can't see".
   Mitigation: enable-time UI warning + YAN-379 docs + export-file banner stating operator-visible; ADR-0002 personal-workspace admin rules remain access-control, not cryptographic, guarantees. **Confidence**: High.

2. **KDF separation for derived usages (ADR-0005 API-key hash key shares the master key).**
   Reusing raw KEK bytes for wrapping and for HMAC-hash derivation invites cross-protocol interactions.
   Mitigation: keep HKDF (`deriveApiKeyHashKey`, info `tokenhop/api-key-hash`) pattern; wrap/encrypt subkeys via HKDF with distinct `info` strings per usage (`tokenhop/dek-wrap`, `tokenhop/field-enc` if KDF layer added); never use raw KEK as GCM key directly in new code paths. **Confidence**: Medium.

3. **Logging/audit of key lifecycle without secret material.**
   Key creation/rotation/migration failures need audit trail, but logging `kid`-adjacent material is fine while logging key bytes, nonces-as-secrets, or plaintext shapes is not.
   Mitigation: audit `kid`, workspace id, envelope version, outcome — never key bytes, nonces, tags, or decrypted values; reuse YAN-367 credential-free audit allow-list discipline. **Confidence**: Medium.

4. **Passphrase-wrapped export explicitly out of scope (hardening issue) — do not half-build.**
   Issue defers optional passphrase export. A weak ad-hoc PBE (bad KDF params, no salt discipline) is worse than deferring.
   Mitigation: YAN-365 exports require same KEK; passphrase path waits for hardening issue with Argon2/scrypt + documented params. **Confidence**: High.

5. **No new dependencies — audit surface stays `node:crypto` + existing `node-machine-id` (legacy only).**
   Keeps supply-chain risk flat. Note `node-machine-id` remains only until MITM cutover; its removal shrinks the native-exec dependency surface.
   Mitigation: lint/grep gate rejecting new crypto imports outside the one module; remove `node-machine-id` usage with legacy path. **Confidence**: High.

## Authentication and Authorization

- KEK access = instance-root capability: only `owner` role may trigger enable/migrate/rotate/delete-workspace-DEK operations; CLI `tokenhop keys rotate` requires same owner auth as other owner-only CLIs. Rotation endpoint (CLI + admin API) must enforce owner check server-side, not CLI-side. **Confidence**: Medium (role model per README §4; exact rotate wiring is YAN-377).
- Workspace DEK access follows membership: decrypt of a connection/node requires principal membership in the row's workspace (`MEMBER_ROW` pattern in `connectionsRepo.js:442`); cross-workspace id reads stay "not found" (no IDOR oracle distinguishing "exists but encrypted" from "missing" — generic 404). **Confidence**: High (pattern exists).
- Unauthenticated SSDP/setup surfaces must never expose KEK status beyond boolean "encryption enabled"; no `kid` enumeration, no decrypt-error oracle text. **Confidence**: Medium.
- Session/auth secrets out of scope correctly: `users.passwordHash` (bcrypt), `apiKeys.keyHash` (keyed HMAC per ADR-0005), JWT secret file, `API_KEY_SECRET` env remain as-is; do not "encrypt" hashes — hashing ≠ encryption. **Confidence**: High.

## Data Protection

- Algorithm profile (OWASP-aligned): AES-256-GCM, 256-bit KEK/DEK from `crypto.randomBytes`, 96-bit nonce, 128-bit tag, AAD-bound, HKDF-separated usages. Envelope `{v:1, kid, iv, ct, tag}` canonical base64; `kid = sha256(masterkey).hex.slice(0,16)` pattern from `masterKey.js` reused for DEK kids (hash of DEK, truncated, collision-checked per workspace).
- Coverage: `providerConnections.data` secret fields (tokens, `apiKey`, cookies, `providerSpecificData` secrets), `providerNodes` secrets, settings (`oidcClientSecret`, SAML keys, `mitmSudoEncrypted`). Non-secret metadata stays plaintext for queries. `proxyPools.data` needs explicit in/out decision (currently unscored, no workspace column) — recommend in scope or documented out.
- At-rest states: live DB (ciphertext + wrapped DEKs), backups (`backupDbLite` copies rows verbatim — automatically covered once rows are ciphertext, but pre-migration backups stay plaintext: label + retain/destroy policy), exports (ciphertext + wrapped DEKs; same-KEK restore), WAL/`-shm`/freelist (VACUUM + checkpoint post-migration).
- Deletion: workspace delete destroys DEK row + evicts cache synchronously; row deletes rely on FK cascade (`ON DELETE CASCADE` in schema) plus explicit DEK-row delete (verify `workspacesRepo.deleteWorkspace` ordering: delete DEK row in same transaction as workspace delete, before commit). Backups of deleted workspaces remain only as unrecoverable ciphertext once DEK destroyed — state this guarantee precisely.
- Loss: KEK loss = credential loss by design; connections surface "unreadable — re-link", instance keeps running; key-backup reminder at enable, rotation, and export time (YAN-379).

## Dependency Security

- New dependencies: none (`node:crypto` only). Supply-chain delta: zero. **Confidence**: High.
- Incumbent risk: `node-machine-id` (used only by legacy MITM `deriveKey`) shells to host utilities; remove with legacy path. `sql.js` (backup verifier) parses backup files — keep verifier on the read path for migration backups since a corrupt backup + destructive migration is the data-loss combo. **Confidence**: Medium.
- Action: `npm audit` gate unchanged; add grep-guard test failing on `require("crypto-js"|"node-forge"|...)` or new `dependencies` entries in the crypto module.

## Input Validation

- Validate at three layers: (1) envelope shape (types, base64 canonical, byte lengths, `v` allow-list); (2) AAD coordinates (table allow-list, row/workspace id format, field allow-list — reject `..`, `|`, empty, overlong); (3) KEK input (strict base64-32 enforced by `decodeStrictEnv`; config-file paths never accepted as key material).
- `importDb` payload validation must additionally verify envelope array shapes and `workspaceKeys` row shapes before wipe; reject mixed-KK payloads pre-transaction. Oversized `ct` values bounded (e.g. ≤64 KiB per field) to cap memory/CPU on decrypt of hostile exports.
- Error hygiene: single `DECRYPT_FAILED`/`UNREADABLE` to callers; detailed reason (`bad_tag`, `aad_mismatch`, `unknown_kid`, `bad_envelope`) only in server logs with row id, never with key/nonce/tag/plaintext.

## Infrastructure Security

- KEK storage: env var preferred in Docker (secret manager → env, never baked into image); file fallback `DATA_DIR/keys/master` 0600 under 0700 `keys/` (already implemented, symlink/O_NOFOLLOW hardened). Docker users must mount/persist `DATA_DIR/keys` — data loss otherwise; compose docs must show the volume. Backups must include key-backup reminder, never the key itself.
- File permissions: fail closed on group/other-readable key material (existing `assertPrivateMode`); extend same check to backup dirs holding ciphertext? No — ciphertext backups need only normal perms, but pre-migration plaintext backups deserve 0700 + explicit destruction notice.
- Transport: exports downloaded over loopback/admin API inherit existing auth (YAN-605 CLI-token check, login requirement); no new network surface except rotate admin endpoint (owner-only, CSRF-protected like other admin POSTs).
- Observability: no plaintext in logs, error responses, audit rows, `/requestDetails`, usage tables, or crash dumps attributable to new code; plaintext-scan test extended to exported JSON fixtures.

## Secure Coding Guidelines

1. One crypto module owns all primitives: `encryptField(dek, aadCtx, field, plaintext)`, `decryptField(dek, aadCtx, field, envelope)`, `wrapDek/unwrapDek`, `newDek`, strict `parseEnvelope`. Repos call it; nobody touches `createCipheriv` directly (grep-guard).
2. AAD canonical builder `buildAad({table,rowId,workspaceId,field})` with allow-lists + length-prefix or `|`-rejection; unit-test field-swap, row-swap, table-swap failures.
3. Nonce/tag constants: `IV_LEN=12`, `TAG_LEN=16`, `KEY_LEN=32`; `randomBytes` per encryption; `authTagLength:16` explicit; no reuse, no counter nonces.
4. Fail-closed error type `EnvelopeUnreadableError(code)`; callers map to "re-link" UX; writers require keys present.
5. Memory discipline: `Buffer.fill(0)` on DEK/plaintext buffers after use where practical; bounded LRU decrypt cache with synchronous workspace-scoped eviction; no decrypted secrets in module globals (contrast `globalThis.__mitmSudoPassword` — eliminate that pattern for migrated secret).
6. Transaction discipline: migration/rotation/import all-or-nothing; verify-before-wipe; idempotency keys (`kid`, `envelope.v`, `migratedAt` marker column or envelope-presence check, never a separate "done" flag that can desync).
7. Tests (issue list + lane additions): round-trip; AAD tamper; row/field/table swap; KEK rotation (ciphertext byte-identical for KEK-only rotation); missing KEK fail-fast; legacy fixture idempotent migration; refresh-path atomicity; scan test (DB file + WAL + export JSON) for secret substrings; switch-off byte-identical behavior.

## Trade-off Recommendations

| Decision                | Recommendation                                                                                 | Rationale                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| AAD shape               | `v1\|table\|rowId\|workspaceId\|field` (issue text) over ADR draft `connectionId\|workspaceId` | Blocks field- and cross-table transplant; negligible cost                               |
| KEK rotation scope      | Rewrap DEKs only (ADR)                                                                         | O(workspaces), online, ciphertext-stable; document old-KEK backup retention             |
| DEK rotation            | Keep prev-kid window until re-encrypt verifies                                                 | Crash-safe; readers dual-kid during window                                              |
| Cache                   | Small bounded LRU + sync eviction                                                              | Refresh-heavy workloads need it; unbounded cache defeats shredding                      |
| WAL remnants            | VACUUM + checkpoint + documented backup handling                                               | Full secure-wipe of SQLite history is impractical; honesty + labeling beats theater     |
| Passphrase export       | Defer to hardening issue                                                                       | Weak ad-hoc PBE worse than clear same-KEK-only rule                                     |
| `proxyPools`            | Encrypt secrets too or document why not                                                        | Unscoped pool credentials in same DB file undermine the story if left plaintext         |
| OS keychain / SQLCipher | Stay rejected (ADR options 4–5)                                                                | Headless/Docker target, native-dep ban, per-workspace destruction needs envelope anyway |

## Open Questions

1. `proxyPools.data` and `cliToolSettingsRepo` values: may they hold secrets? If yes, include or justify exclusion. — for implementer + YAN-375.
2. Exact SECRET_FIELD list per provider registry entry: who owns the registry (which fields are secret vs queryable metadata)? Over-encryption breaks search/sort; under-encryption leaks. — for implementer.
3. `workspaceKeys` table DDL/owner: `workspaceId` FK cascade direction (deleting workspace must delete DEK row — cascade vs explicit delete in same tx) and `kid` uniqueness scope. — for implementer (check YAN-361 deletion path).
4. Rotation UX owner: YAN-377 CLI vs YAN-365 library — which issue ships the transactional rewrap core vs the CLI wrapper? Avoid duplicate implementations.
5. Pre-migration backup gate: YAN-352 backup-gated execution — does the gate verify backup integrity (`quick_check`) before destructive encrypt, and does it pin the KEK `kid` used for migration into backup metadata?
6. `DATA_DIR/keys` persistence in supported Docker/compose templates: who updates volume mounts + docs (YAN-379) so upgrades do not orphan the key file?
7. Post-migration `VACUUM`: acceptable downtime window for large DBs, or online incremental (`auto_vacuum` note) instead?
8. Decrypt-cache size/TTL tuning data: refresh QPS vs memory budget — any measurements, or adopt conservative default (e.g. 500 entries/5 min) and measure later?

## Sources

- GH #233 / YAN-365 text (issue body, trunk-landing + test list).
- Main checkout `docs/users/README.md` §§3–9 (target model, switch, DoD, issue map); `docs/users/spec.md` row 8; ADR-0008 full text (decision, threat table, test impact).
- `src/lib/security/masterKey.js` (strict env decode, symlink/O_NOFOLLOW, 0600/0700 fail-closed, atomic `link` publish, HKDF separation).
- `src/lib/db/index.js` `exportDb`/`importDb`; `src/lib/db/schema.js` table DDL; `src/lib/db/backup.js` ATTACH-lite + protected prefixes; `src/lib/db/repos/connectionsRepo.js` mutation paths; `src/lib/db/repos/workspacesRepo.js:85-92` delete path; adapters WAL checkpoint.
- `src/mitm/manager.js:194,262-290,334-355` legacy machine-id crypto; `src/lib/settingsConfigDoc.js:60-74` `SECRET_SETTING_KEYS`.
- OWASP Cryptographic Storage Cheat Sheet; OWASP Key Management Cheat Sheet; OWASP Multi-Tenant Security Cheat Sheet (current series, consulted 2026-10-06).

## Search Queries Executed

- (Codebase, no web): issue `gh issue view 233`; `docs/users/README.md`, `spec.md` encryption refs; ADR-0008; `masterKey.js`; `connectionsRepo.js`; `backup.js`; `schema.js`; `manager.js` MITM crypto; `settingsConfigDoc.js`; adapter WAL pragmas; workspace delete path.
- (Prior lane knowledge, no new web fetch needed): OWASP crypto-storage/key-management guidance applied from standing sources; no conflicting vendor claims to resolve.
- Uncertainties & gaps: SECRET_FIELD registry location not traced to provider registry file; `proxyPools`/`cliToolSettings` secret status unconfirmed; YAN-377/YAN-375 interface split assumed from ADR affected-issues list — verify against those issues before coding.
