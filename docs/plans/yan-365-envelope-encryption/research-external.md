# External Research — YAN-365 Envelope Encryption (GH tokenhop/tokenhop#233)

> Research lane: external (Node `crypto` official docs, OWASP cheat sheets, Google/NIST envelope references, public GitHub implementation patterns). Codebase facts read from this worktree (`masterKey.js`, `mitm/manager.js`, `db/index.js`, `db/backup.js`) and the main checkout's gitignored `docs/users/adr/0008-encryption-at-rest.md` + `docs/users/README.md`. Constraint binding: **Node `crypto` only, zero new dependencies** (GH #233, ADR-0008, handbook §8). Runtime verified in worktree: Node v24.15.

## Executive Summary

AES-256-GCM envelope encryption (KEK wraps per-workspace DEKs, DEK encrypts fields, AAD binds ciphertext to its location) is fully implementable in Node `crypto` with no dependencies: `createCipheriv`/`createDecipheriv` + `setAAD` + `setAuthTag`/`getAuthTag` + `randomBytes`. The repo already owns every hard primitive: `src/lib/security/masterKey.js` provides fail-closed, exclusive, crash-safe, symlink-safe KEK creation (`O_NOFOLLOW`, `wx` temp, `fsync`, `link()` atomic publish, dir fsync) plus `hkdfSync` domain separation and `masterKeyId` — **reuse it unchanged for the KEK; do not fork a second key-loading path.** The genuinely new external-knowledge decisions are: (1) rotation ordering that never leaves wrapped DEKs unreadable across a crash (DB rewrap txn commits _before_ the KEK file swap, dual-kid rows make every crash point recoverable); (2) AAD canonicalization that delivers the fail-closed row/workspace/field swap resistance the issue demands; (3) envelope-marker discrimination so mixed plaintext/ciphertext states read correctly during migration but fail closed after it. OWASP Cryptographic Storage explicitly blesses the envelope design (DEK encrypts data, KEK stored separately from DB, KEK ≥ DEK strength) and Key Management specifies the exact rotation semantics ADR-0008 chose: retiring a KEK = re-wrap DEKs under the new KEK, which leaves DEK cryptoperiods untouched. OWASP also mandates the two operational facts the issue already encodes: secure key backup (lost key = unrecoverable data, by design) and retaining retired keys until old backups age out. Biggest gotcha from Node docs: GCM `setAAD` must precede `update()` and `setAuthTag` must precede `final()` — order violations throw, and tag-length mismatches throw since v11 (pass `authTagLength: 16` explicitly on both sides; cost is zero, it hard-pins the DEP0182-era behavior). NIST SP 800-38D caps a random-96-bit-IV GCM key at 2^32 encryptions — irrelevant at tokenhop's per-workspace volume, but it is the reason rotation stays event-driven (compromise/schedule), not volume-driven.

## Primary APIs (official links)

Node.js v24 crypto — all built-in, zero deps:

| API                                                    | Link                                                                                                                                                                                                                           | Role in YAN-365                                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `crypto.createCipheriv(algorithm, key, iv[, options])` | <https://nodejs.org/docs/latest-v24.x/api/crypto.html#crypto_createcipheriv_algorithm_key_iv_options>                                                                                                                          | AES-256-GCM encrypt, DEK and KEK-wrap; `authTagLength: 16`                                                                        |
| `crypto.createDecipheriv(...)`                         | <https://nodejs.org/docs/latest-v24.x/api/crypto.html#crypto_createdecipheriv_algorithm_key_iv_options>                                                                                                                        | decrypt; throws at `final()` on tamper                                                                                            |
| `cipher.setAAD(buffer[, options])`                     | <https://nodejs.org/docs/latest-v24.x/api/crypto.html#cipher_setaad_buffer_options>                                                                                                                                            | bind `table\|rowId\|workspaceId\|field`; **must be called before `cipher.update()`**                                              |
| `cipher.getAuthTag()`                                  | <https://nodejs.org/docs/latest-v24.x/api/crypto.html#cipher_getauthtag>                                                                                                                                                       | 16-byte tag; only after `final()`                                                                                                 |
| `decipher.setAAD(buffer)`                              | <https://nodejs.org/docs/latest-v24.x/api/crypto.html#decipher_setaad_buffer_options>                                                                                                                                          | same AAD on decrypt, before `update()`                                                                                            |
| `decipher.setAuthTag(buffer[, encoding])`              | <https://nodejs.org/docs/latest-v24.x/api/crypto.html#decipher_setauthtag_buffer_encoding>                                                                                                                                     | **before `final()` for GCM**; invalid length throws (NIST SP 800-38D range)                                                       |
| `crypto.randomBytes(size)`                             | <https://nodejs.org/docs/latest-v24.x/api/crypto.html#crypto_randombytes_size_callback>                                                                                                                                        | DEK generation (32B), nonce generation (12B), KEK generation (32B)                                                                |
| `crypto.hkdfSync(digest, ikm, salt, info, keylen)`     | <https://nodejs.org/docs/latest-v24.x/api/crypto.html#crypto_hkdfsync_digest_ikm_salt_info_keylen>                                                                                                                             | domain separation KEK→API-key-hash key (already in `masterKey.js`; extend info strings, never reuse raw KEK)                      |
| `crypto.createHash`                                    | <https://nodejs.org/docs/latest-v24.x/api/crypto.html#crypto_createhash_algorithm_options>                                                                                                                                     | `masterKeyId` (existing) — keep as kid derivation                                                                                 |
| `crypto.timingSafeEqual(a, b)`                         | <https://nodejs.org/docs/latest-v24.x/api/crypto.html#crypto_timingsafeequal_a_b>                                                                                                                                              | kid comparison if needed; docs warn it does not make surrounding code constant-time                                               |
| `fs.open(path, 'wx')`, `fs.constants.O_NOFOLLOW`       | <https://nodejs.org/docs/latest-v24.x/api/fs.html#fileopenflags> , <https://nodejs.org/docs/latest-v24.x/api/fs.html#fs_constants>                                                                                             | exclusive non-overwriting create, symlink refusal (both already in `masterKey.js`)                                                |
| `FileHandle.sync()`, `fs.rename`, `fs.link`            | <https://nodejs.org/docs/latest-v24.x/api/fs.html#filehandlesync> , <https://nodejs.org/docs/latest-v24.x/api/fs.html#fsrenameoldpath-newpath> , <https://nodejs.org/docs/latest-v24.x/api/fs.html#fslinkexistingpath-newpath> | crash-safety: fsync data before publish; `link` = non-overwriting atomic publish (creation), `rename` = atomic replace (rotation) |

## OWASP Official Sources (live consult, HTTP 200, fetched 2026-10-06)

All three OWASP cheat sheets below were fetched live on 2026-10-06 from `cheatsheetseries.owasp.org`; the Key Management sheet's relevant sections are byte-identical between two fetches this session (Cryptographic Storage identical modulo whitespace/nav-chrome). Quotes are verbatim from the live pages.

**OWASP Cryptographic Storage Cheat Sheet** — <https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html>

- _Cipher Modes:_ "Where available, authenticated modes should always be used. These provide guarantees of the integrity and authenticity of the data, as well as confidentiality. The most commonly used authenticated modes are GCM and CCM, which should be used as a first preference." → AES-256-GCM is the sheet's first preference; no ECB/CBC-without-MAC anywhere in the new code.
- _Secure Random Number Generation:_ CSPRNG required for "generating encryption keys, IVs, session IDs" → `crypto.randomBytes` for every DEK and every nonce; never `Math.random`/PRNG.
- _Key Generation:_ "Where multiple keys are used (such as data separate data-encrypting and key-encrypting keys), they should be fully independent from each other." → KEK and each DEK are independent `randomBytes(32)` draws; never derive DEKs from the KEK.
- _Key Lifetimes and Rotation:_ rotate on compromise, cryptoperiod (NIST SP 800-57 §5.3), or before mode usage limits; "Enforce the mode's limits on ... initialization vector (IV) uniqueness across all instances sharing the key. For example, AES-GCM has separate requirements for input lengths and IV construction in NIST SP 800-38D, Sections 5.2.1.1 and 8." → the 2^32 random-IV budget below.
- _Key Storage:_ prefer OS/framework/provider vaults; where unavailable (our Docker/headless case): "Do not hard-code keys into the application source code. Do not check keys into version control. Protect the configuration files containing the keys with restrictive permissions. Avoid storing keys in environment variables, as these can be accidentally exposed through ... /proc/self/environ." → documents the accepted `TOKENHOP_MASTER_KEY` env risk as a conscious trade-off (masterKey.js already implements the restrictive-permissions file path as the default).
- _Separation of Keys and Data:_ "if the data is stored in a database, the keys should be stored in the filesystem" → exactly `DATA_DIR/keys/master` vs DB.
- _Encrypting Stored Keys (envelope, verbatim):_ "The Data Encryption Key (DEK) is used to encrypt the data. The Key Encryption Key (KEK) is used to encrypt the DEK. For this to be effective, the KEK must be stored separately from the DEK. ... The KEK should also be at least as strong as the DEK. The envelope encryption guidance from Google contains further details." → the ADR-0008 design is the sheet's recommended pattern; KEK 256-bit = DEK 256-bit satisfies "at least as strong".
- _Defense in Depth:_ encrypted data still needs access control on top — matches the tenancy/role layers (ADR-0001/0002), not a substitute for them.

**OWASP Key Management Cheat Sheet** — <https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html>

- _Storage:_ "If you are planning on storing keys in offline devices/databases, then encrypt the keys using Key Encryption Keys (KEKs) prior to the export of the key material. KEK length (and algorithm) should be equivalent to or greater in strength than the keys being protected. Ensure that keys have integrity protections applied while in storage (consider dual purpose algorithms that support encryption and Message Code Authentication (MAC))." → wrapped DEKs in `workspaceKeys` = exactly this; AES-256-GCM wrapping supplies the "integrity protections" (AEAD, not bare AES).
- _Key Usage:_ "in general, a single key should be used for only one purpose" → raw KEK only wraps DEKs and feeds HKDF with distinct `info` strings; DEK only encrypts fields of its workspace.
- _Cryptoperiods and Rotation — Usage-Based Rotation Limits (verbatim):_ "when using Advanced Encryption Standard in Galois/Counter Mode (AES-GCM) with random 96-bit initialization vectors (IVs), limit each key to at most 2^32 (4,294,967,296) encryption operations across all devices sharing that key to limit IV-collision risk (NIST SP 800-38D §8.3)." → per-workspace DEKs make this unreachable in practice; rotation stays event/schedule-driven.
- _Handling Existing Encrypted Data — Envelope Encryption (verbatim):_ "To retire a Key Encryption Key (KEK), re-wrap stored Data Encryption Keys (DEKs) under the replacement KEK before destroying the old one. Rewrapping leaves the DEKs unchanged and does not reset their cryptoperiods or usage limits. Replacing a DEK for existing ciphertext requires re-encrypting that data." → directly blesses the ADR-0008 rotation split: KEK rotation = rewrap O(workspaces); DEK rotation = re-encrypt O(rows).
- _Manual Rotation Logging:_ "rotation events should be logged with the timestamp, operator identity, and management authorization reference." → rotate CLI must emit an audit event with timestamp + operator (kid only, never key material).
- _Escrow and Backup:_ "Data that has been encrypted with lost cryptographic keys will never be recovered. Therefore, it is essential that the application incorporate a secure key backup capability, especially for applications that support data at rest encryption." → the enable-time key-backup warning (YAN-379) is an OWASP requirement, not a nicety.
- _Zeroization and Destruction:_ "Destroy all copies of secret and private keys, including backup, archived, escrowed, and memory copies, as soon as they are no longer needed." + "Cryptographic Erasure: ... Destroying a wrapping key does not erase plaintext copies of the keys it protected." → crypto-shredding = delete wrapped-DEK rows (workspace delete) and destroy retired-KEK escrow only after backups age out; memory zeroing is best-effort in V8 (documented residual risk).

**OWASP Secrets Management Cheat Sheet** — <https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html>

- §7.3 (verbatim): "You should not store keys next to the secrets they encrypt, except if those keys are encrypted themselves (see envelope encryption)." → wrapped DEKs co-located with ciphertext in the DB are explicitly acceptable _because_ they are wrapped; the raw KEK must not be in the DB (ADR: "never stored in the DB").
- Environment variables: "environment variables are generally accessible to all processes and may be included in logs or system dumps. Using environment variables is therefore not recommended unless the other methods are not possible." → document `TOKENHOP_MASTER_KEY` as the Docker/secret-manager injection path with this caveat; the 0600 file is the safer default for bare-metal installs.
- Auditing list (who requested/approved/used a secret, administrative actions) → key-lifecycle audit events (create/rotate/migrate/delete-workspace-DEK) belong in the YAN-367 audit allow-list with `kid` + actor, never material.

**Google Cloud KMS — AAD semantics** — <https://cloud.google.com/kms/docs/additional-authenticated-data> (fetched live 2026-10-06; envelope doc: <https://cloud.google.com/kms/docs/envelope-encryption>)

- "AAD is used as an integrity check and can help protect your data from a confused deputy attack." / "Cloud KMS will not decrypt ciphertext unless the same AAD value is used for both encryption and decryption." / "AAD is bound to the encrypted data ... it is not stored as part of the ciphertext." → in Node AES-GCM `setAAD` delivers exactly this semantic; decrypt recomputes AAD from live row coordinates, never from stored envelope fields.

- NIST SP 800-38D (GCM IV construction/limits, tag lengths) and NIST SP 800-57 Part 1 Rev. 5 (cryptoperiods, lifecycle states) — the normative references both OWASP sheets cite.

## AAD Assessment: GH `table|rowId|workspaceId|field` vs ADR `connectionId|workspaceId` — Verdict and Binding

**The two specifications in circulation:**

- GH #233 / YAN-365 (Linear is source of truth): "AAD = `table|rowId|workspaceId|field`, so ciphertext can't be moved between rows or workspaces."
- ADR-0008: "Field encryption: ... AAD `connectionId|workspaceId`. ... The AAD binds ciphertext to its row: copying a field between connections or workspaces fails authentication." (wrap AAD: `workspaceId|kid`.)

**Swap-resistance matrix** (would the transplant still authenticate?):

| Transplant                                                 | ADR `connectionId\|workspaceId`                                                                                | GH `table\|rowId\|workspaceId\|field` |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Same field, other connection (row swap)                    | FAILS (connectionId differs)                                                                                   | FAILS (rowId differs)                 |
| Any field, other workspace                                 | FAILS (workspaceId differs)                                                                                    | FAILS (workspaceId differs)           |
| **`accessToken` envelope → `refreshToken` slot, same row** | **PASSES — AAD identical**                                                                                     | FAILS (field differs)                 |
| **`apiKey` envelope → `accessToken` slot, same row**       | **PASSES**                                                                                                     | FAILS                                 |
| Connection envelope → `providerNodes` row                  | **Passes whenever uuid collision (both tables mint `uuidv4()` ids — same id space; `connectionsRepo.js:308`)** | FAILS (table differs)                 |
| Envelope → settings field (or back)                        | Undefined in ADR (settings have no connectionId)                                                               | FAILS (table/field differ)            |
| Whole `{iv,ct,tag}` → another row of same workspace        | FAILS (connectionId differs)                                                                                   | FAILS (rowId differs)                 |

The field-swap hole is real harm, not theory: a copied `apiKey` envelope decrypts successfully in the `refreshToken` slot and the refresh path then sends the API key to the token endpoint as a refresh token — silent wrong-credential use (and possibly leak into provider request logs), the exact "moved ciphertext must fail authentication, not decrypt" property the issue demands. Google KMS's AAD guidance frames AAD as the anti-confused-deputy integrity check; OWASP Crypto Storage (Cipher Modes) positions AEAD authenticity as the mechanism that guarantees the data's context. Both point at binding the **full locator**, not a prefix of it.

**Verdict (recommendation):** adopt the GH/Linear form as the canonical binding — `v1|<table>|<rowId>|<workspaceId>|<field>` — and reconcile ADR-0008's prose (its _intent_ is row-binding; the 4-part form is a strictly stronger superset and contradicts nothing else in the ADR). Handbook README says spec/ADRs win over §4, but Linear is source of truth for issue scope — flag for the parent lane to amend ADR-0008 or record the deviation.

**Concrete binding decisions:**

1. One `buildAad({v, table, rowId, workspaceId, field})` builder used by both encrypt and decrypt; decrypt always recomputes from live row coordinates (table name constant at call site, `row.id`, `row.workspaceId`, field name constant), **never from stored envelope fields** — a stored AAD would be self-authenticating and worthless.
2. Encoding: plain `|` join is unambiguous in-repo — `providerConnections.id` and workspace ids are `uuidv4()` output (36 chars, no `|`; `connectionsRepo.js:308`). Still reject `|` and empty components inside the builder (defense in depth against future id formats); table/field come from fixed allow-lists at call sites.
3. `v` inside the AAD binds the format version, so a future v2 envelope never authenticates against v1 AAD bytes.
4. `kid` stays **in the envelope, out of the AAD**: `kid` selects which DEK/KEK version decrypts; flipping it only causes wrong-key selection → auth failure → fail closed. Wrapping keeps ADR's own binding: wrap AAD = `workspaceId|kid` (prevents wrap-row transplant between workspaces/versions).
5. Settings pseudo-table: settings is a single-row blob (`settings.id = 1`, `schema.js`). AAD = `v1|settings|<settingKey>|<defaultWorkspaceId>|<settingKey>` — fixed table string, the setting key as locator, so OIDC and SAML envelopes are non-interchangeable with each other and with any connection/node field.
6. Field-level placement: envelopes replace secret fields **inside** the existing `data` JSON blob (`connToRow`, `connectionsRepo.js:74-99`), not new columns — AAD `rowId` = `providerConnections.id` regardless; non-secret metadata stays plaintext-queryable per ADR.
7. Workspace-move caveat: because `workspaceId` is in the AAD, changing a row's workspace post-encryption deliberately breaks decryption. Verified current writers only move workspaceId while rows are pre-encryption (`adoptOwnerlessUnscoped` at bootstrap, `bootstrap.js:111-112`; upsert `COALESCE(workspaceId, ...)`), and the encryption migration runs after YAN-361 adoption. Any future "move connection between workspaces" feature must re-encrypt with the new AAD as an explicit operation — never silent `UPDATE workspaceId`.
8. Out-of-scope tables note: `proxyPools` has **no `workspaceId` column** (`schema.js`) — if the parent lane pulls it into scope later, its AAD needs an instance-scope constant in the workspace slot, and the table component is what keeps its envelopes disjoint from connections/nodes.

## Libraries and SDKs

**None. Binding constraint: zero new dependencies** (GH #233: "a crypto module using Node `crypto` only"; ADR-0008 handbook §8). Everything below is context for what is deliberately _not_ adopted:

- **Node WebCrypto (`crypto.subtle`, AES-GCM)** — in-repo alternative; supports `additionalData`. Rejected as primary: promise-based, ArrayBuffer-centric, awkward with the Buffer/JSON envelope flow; `createCipheriv` matches existing precedent (`src/mitm/manager.js` `ENCRYPT_ALGO` GCM, `src/lib/security/masterKey.js` HKDF/HMAC).
- **`libsodium.js` / `sodium-native`** — native dep; rejected (handbook §8). XChaCha20-Poly1305's extended nonce is unnecessary at this volume.
- **AWS Encryption SDK / `@aws-crypto/kms-encryption-sdk-node`, GCP Tink** — production envelope implementations with KEK-in-KMS; rejected (self-hosted product, no cloud dependency); their **design** is the reference: data keys generated client-side, wrapped under KMS KEK, AAD-bound envelopes with key IDs (`kid`) in the header — exactly the `{v, kid, iv, ct, tag}` format.
- **`node-machine-id`** — already a dependency, but its use in `src/mitm/manager.js:260-271` (`deriveKey` = sha256(machineId + static salt `"9router-mitm-pwd"`) is the pattern YAN-365 _retires_. After migration this dependency can be dropped from that import path (check other usages before removing the dep itself).
- GitHub real-world patterns surveyed via code search: `nodejs/node` official tests `test/parallel/test-crypto-authenticated.js` and `test-crypto-authenticated-stream.js` (canonical setAAD/setAuthTag round-trip incl. AAD-before-update ordering); `auth0/express-openid-connect` `lib/crypto.js` (HKDF `info`-based domain separation — same pattern as `masterKey.js` `HASH_INFO`); `abhigyanpatwari/GitNexus`, `JuliusBrussee/caveman` (`O_NOFOLLOW | O_EXCL` + temp+rename 0600 key-file writes — the same shape `masterKey.js` already implements, confirming it as community-standard rather than bespoke).

## Integration Patterns

### 1. KEK — reuse `src/lib/security/masterKey.js` verbatim

`loadMasterKey({ create })` already implements the entire ADR-0008 KEK contract: `TOKENHOP_MASTER_KEY` strict-canonical-base64-32-bytes env (`decodeStrictEnv` re-encodes and compares), else `DATA_DIR/keys/master` with 0700 dir / 0600 file, symlink refusal (`lstat` + `O_NOFOLLOW` double-check), group/other-mode fail-closed, exclusive crash-safe creation (`wx` temp → `chmod 0600` → write → `fsync` → `link` atomic non-overwriting publish → dir fsync, EEXIST loser re-reads the winner), corrupt-file never-regenerated, `masterKeyId` = sha256(master) first 16 hex. **Decision: the crypto module calls `loadMasterKey({ create: true })` at first switch-on enable, and `loadMasterKey({ expectedKid })` everywhere else.** Never write a parallel loader.

### 2. DEK + wrap/unwrap (new `workspaceKeys` table)

`workspaceId, kid, wrappedDek, createdAt` (ADR-0008). Wrap = AES-256-GCM with **KEK**, AAD `workspaceId|kid`, envelope `{v:1, kid, iv, ct, tag}`. Per-workspace DEK = `crypto.randomBytes(32)`, kid = `masterKeyId(dek)`-style (derive per DEK, e.g. sha256(dek).slice(16 hex) so envelopes self-describe which DEK decrypts them). Never derive the DEK from the KEK — OWASP Storage CS "Key Generation": multiple keys must be fully independent. Insert wrapped row and workspace row in one transaction so no workspace exists without a destroyable DEK (YAN-361 dependency).

### 3. Field encryption with location-bound AAD — the swap-resistance core

GH #233 requires AAD = `table|rowId|workspaceId|field`; ADR-0008 shorthand `connectionId|workspaceId` is the **weaker draft — superseded** (full assessment with transplant matrix in "AAD Assessment" below). Canonical decision: `v1|<table>|<rowId>|<workspaceId>|<field>` as a UTF-8 Buffer, built by one helper used by both encrypt and decrypt paths (drift between the two is the classic bug). Decrypt recomputes AAD from live row coordinates, never from stored envelope fields. Repo UUIDs are pipe-free (`uuidv4`, `connectionsRepo.js:308`) so plain `|` join is unambiguous; the builder still rejects `|` and empty components. This single string delivers all four required failures as GCM auth failures at `decipher.final()`: row swap, workspace swap, **field swap within a row** (the hole the ADR form leaves open), and cross-table transplant. Google's AAD doc frames AAD exactly as the anti-confused-deputy integrity check ("will not decrypt ciphertext unless the same AAD value is used").

### 4. Envelope storage + fail-closed discrimination

Store `{v:1, kid, iv, ct, tag}` (base64url fields) in place of the plaintext secret inside the existing `data` JSON blob. Discriminator: `typeof value === "object" && value !== null && value.v === 1 && typeof value.kid === "string"` ⇒ envelope; else, **only while the migration-incomplete flag is set**, read as legacy plaintext (re-encrypt lazily or at migration completion); once migration completes, a non-envelope secret under switch-on is an error — never silently returned as plaintext (GH #233 "missing KEK fails fast ... never silently plaintext"). Parse errors on malformed envelopes always fail closed.

### 5. Repos encrypt-on-write / decrypt-on-read; rotation of OAuth tokens stays transactional

`connectionsRepo.js` `updateProviderConnection` already runs token refresh in one transaction (issue requirement: keep it). Encrypt inside that transaction — envelope write is a pure function of (plaintext, DEK, AAD), no extra I/O, so transactionality is preserved. Unwrap failures inside refresh must mark the connection unreadable (per ADR-0008 wrong-KEK behavior) rather than crash the refresh loop.

### 6. Crash-safe KEK rotation (`tokenhop keys rotate`, YAN-377 boundary — decision recorded here)

The unsafe ordering is swapping the KEK file before the DB: a crash in between leaves wrapped DEKs unreadable forever. Safe protocol (all steps idempotent, every crash point recoverable):

1. Generate new KEK K2 (`randomBytes(32)`). Old KEK K1 stays loaded in memory and on disk.
2. **DB transaction**: for every `workspaceKeys` row, unwrap DEK with K1, insert a second row wrapped under K2 with `kid2` (keep the K1-wrapped rows for now). Commit. Crash here: disk still has K1, DB still readable — safe.
3. Publish K2 as `DATA_DIR/keys/master` via the `masterKey.js` durability pattern but with **`fs.rename` (atomic replace) instead of `fs.link`** (`link` is non-overwriting by design — correct for creation, wrong for rotation): temp file `wx` 0600 → write → `fsync` → `rename` over `master` → fsync keys dir and DATA_DIR. Crash before rename: old KEK file intact, safe. Crash after rename: DB already carries K2-wrapped rows (step 2 committed) — safe.
4. Second DB transaction: delete all K1-wrapped rows. Crash before: harmless duplicates. Idempotent re-run detects completion by row kids.
5. Escrow K1 (`keys/master.<kid1>.retired`, 0600) until rolling backups (`KEEP_BACKUPS = 3`, `src/lib/db/backup.js`) have aged past — OWASP Storage CS: keep retired keys so older backups stay decryptable; OWASP KM "Zeroization": destroy all copies only when recovery/retention needs end.

`TOKENHOP_MASTER_KEY` env users: the file publish is meaningless; rotate must print the new canonical base64 for the operator to set, and rewrap runs in two phases (`--phase prepare`/`--phase finish`) or errors out telling the operator to switch to file-based KEK for rotation. Per-DEK rotation (issue scope: "DEKs themselves are rotated per workspace") = unwrap with KEK, new DEK, re-encrypt that workspace's fields in one transaction — O(workspace rows), separate command path from KEK rotation.

### 7. Crypto-shredding on workspace delete

Delete `workspaceKeys` row(s) for the workspace in the same transaction as workspace data deletion (YAN-361 ordering). Per OWASP KM Zeroization, "destroying a wrapping key does not erase plaintext copies" — analog here: deleting the wrapped-DEK row makes every field ciphertext of that workspace undecryptable _even with the KEK_, which is exactly the ADR-0008 test ("old ciphertext from a backup cannot be decrypted even with the KEK (missing DEK)"). Also clear that workspace's entries from the decrypt cache and best-effort `buffer.fill(0)` cached plaintext.

### 8. Decrypt cache — bounded, keyed, invalidated

Issue requires "bounded and cleared when a workspace is deleted." Decision: simple Map-based LRU (stdlib only) capped (e.g. 512 entries), key `workspaceId|table|rowId|field`, value Buffer; `delete(workspaceId)` eviction on workspace deletion and on DEK rotation; clear entirely on KEK rotation. Evicted/invalidated Buffers get `fill(0)` (best-effort per OWASP KM "Software Memory" — GC runtimes can retain copies; document as residual risk, do not buy a "secure memory" dependency).

### 9. Export/import: same-KEK restore check

`exportDb` emits ciphertext envelopes + `workspaceKeys` rows verbatim (YAN-375 carries the table into export/import plumbing; today's `importDb` wipe list doesn't know it). ADR-0008 test demands "different KEK is rejected with a clear error": `importDb` (which is destructive — wipes and reinserts) must, **before any wipe**, `loadMasterKey()`, attempt to unwrap one (or all, small N) wrappedDek with AAD `workspaceId|kid`; GCM auth failure ⇒ reject with "backup was encrypted under a different KEK", leaving the live DB untouched. This verifies the KEK without decrypting any field data and honors "import never decrypts or re-encrypts field envelopes."

### 10. Instance secrets incl. MITM sudo migration

Settings fields `oidcClientSecret`, `samlPrivateKey/DecryptionKey/SigningKey`, and `mitmSudoEncrypted` encrypt under the Default workspace DEK with AAD `v1|settings|<settingKey>|<defaultWorkspaceId>|<settingKey>`. MITM path: one-time migration decrypts legacy `mitmSudoEncrypted` via the existing machine-id `deriveKey()` (`src/mitm/manager.js:260-293`), re-encrypts under the DEK, sets a marker; runtime decrypt tries DEK first, legacy fallback only while unmigrated; after migration the legacy path and `node-machine-id` import are dead code — delete (ADR-0008 follow-ups line).

### 11. Trunk landing behind the switch

Handbook §5: everything gated by `isMultiUserEnabled()`; switch off ⇒ byte-identical single-user behavior, no `workspaceKeys` rows, fields plaintext; CI runs the gate in both states. KEK generation + migration run only when the switch is on and only after the YAN-352 pre-migration backup exists (ADR-0008 decisions 9-10).

## Constraints and Gotchas

1. **Order of operations (Node docs, hard throws):** `setAAD` must be called before `update()`; `setAuthTag` before `final()` for GCM; `setAuthTag` once only; `getAuthTag` only after `final()`. Wrong order throws — good, but means decrypt code must set tag+AAD before feeding ciphertext, including when ct is empty.
2. **Tamper detection point:** authentication failure surfaces at `decipher.final()`, not `update()`. Wrap the whole decrypt in try/catch and translate to one typed error (`ENVELOPE_AUTH_FAILED`); never catch-and-return-null on the read path (that is the silent-failure mode the issue forbids). Note `update()` may already have emitted plaintext internally before `final()` throws — **discard partial output**, never return it.
3. **authTagLength:** GCM defaults to 16 bytes on both sides; since Node v22/v24 non-128-bit GCM tags without explicit `authTagLength` are deprecated (DEP0182 line, `decipher.setAuthTag` history). Pass `{ authTagLength: 16 }` explicitly on cipher and decipher — pins behavior, self-documents.
4. **Nonce budget:** random 96-bit IV per encryption; NIST SP 800-38D §8 via OWASP KM caps a key at ~2^32 random-IV encryptions. Per-workspace DEK makes the budget astronomically safe; do not add deterministic-nonce machinery (complexity with no need).
5. **Nonce/tag/key sizes:** IV exactly 12 bytes (`randomBytes(12)`), tag 16 bytes, DEK and KEK exactly 32 bytes. Zero-length plaintext is valid GCM input — settings fields can be empty strings; envelope round-trips them, don't special-case.
6. **`hkdfSync` returns ArrayBuffer**, not Buffer — existing `masterKey.js` wraps with `Buffer.from(...)`. Keep that wrapper in any new derivation; also keep distinct `info` strings per purpose (`tokenhop/api-key-hash` today; add e.g. `tokenhop/dek-wrap` if any derivation is ever introduced) — OWASP KM "Key Usage": one key, one purpose.
7. **Key separation of KEK:** the raw KEK must only ever (a) wrap DEKs, (b) feed HKDF with distinct infos. Never use the KEK directly on field data — that collapses the envelope.
8. **Windows:** `masterKey.js` already degrades mode/O_NOFOLLOW/fsync-dir checks on win32 with comments; keep that. No new platform behavior needed.
9. **`Buffer` zeroization is best-effort** in V8 (OWASP KM "Software Memory" says exactly this); `fill(0)` on eviction is hygiene, not a guarantee — document, don't over-engineer.
10. **Env KEK + rotation conflict** (gotcha above): `link()`-based publish cannot replace an existing `master`; rotation needs `rename`. And env-provided KEKs cannot be rotated by the process at all — explicit two-step operator flow or refuse with instructions.
11. **Old-backup decryptability vs. shredding tension:** retired KEK escrow (rotation) must not resurrect deleted workspaces — it can't: their wrapped-DEK rows are gone from every post-deletion backup. But pre-deletion backups + retained K1 remain decryptable until those backups age out of the 3-deep rotation; that window is the documented compromise (OWASP: retain old keys for old backups; destroy when retention ends). State it in the threat-model docs (YAN-379).
12. **`importDb` is destructive-first today** — the KEK-verification step must be inserted _before_ the wipe transaction, else a wrong-KEK import destroys the live DB and then fails (data loss the issue's "clear error" wording does not permit).
13. **Mixed-state reads are only a migration-window affordance.** After the migrated flag is set, non-envelope secret = hard error. Forgetting to close this window silently reintroduces the plaintext acceptance the feature exists to kill — cover with the plaintext-scan test.
14. **Never log envelope components or plaintext.** `kid` is safe (it's a hash prefix); `iv/ct/tag` are safe-ish but pointless to log; plaintext never. Existing `SECRET_SETTING_KEYS` redaction in `src/lib/settingsConfigDoc.js:60-74` must gain the new settings keys if any config-export path can see them.
15. **AAD drift:** encrypt and decrypt must share one AAD-builder function; a refactor that changes the format on one side bricks every stored envelope (auth failure everywhere). Bump `v` in AAD string and envelope together if format ever changes — that is what the `v` field is for. `kid` is deliberately **outside** the AAD: it only selects the key version, and tampering with it fails closed via wrong-key auth failure.
16. **Envelope `kid` vs DEK identity:** envelope `kid` should identify the DEK (hash of DEK), so field envelopes resolve to a `workspaceKeys` row without trial-decryption; the wrap envelope's `kid` identifies the KEK version that wrapped it. Two different kid namespaces in one table — name them explicitly (`dekKid`, `kekKid`) or the schema will bite during rotation (see Open Questions).

## Code Examples

Node `crypto` only. Example 1 is the core primitive pair; examples 2-4 are the pattern decisions (rotation ordering, import precheck, migration discrimination) in minimal runnable form. Ladder note: everything below is stdlib; no ponytail needed.

```js
// 1. Envelope encrypt/decrypt — AES-256-GCM, AAD-bound (Node crypto only).
//    Mirrors nodejs/node test/parallel/test-crypto-authenticated{,-stream}.js
//    ordering: setAAD before update(); setAuthTag before final().
import crypto from "node:crypto";

const ALGO = "aes-256-gcm";
const b64u = (buf) => buf.toString("base64url");

export function buildAad(v, table, rowId, workspaceId, field) {
  for (const part of [table, rowId, workspaceId, field])
    if (typeof part !== "string" || part.includes("|"))
      throw new Error("[envelope] invalid AAD component");
  return Buffer.from(`${v}|${table}|${rowId}|${workspaceId}|${field}`, "utf8");
}

export function encryptField(dek, aad, plaintext /* string|Buffer */) {
  if (!(dek instanceof Buffer) || dek.length !== 32)
    throw new Error("[envelope] DEK must be 32 bytes");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALGO, dek, iv, { authTagLength: 16 });
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  const tag = c.getAuthTag(); // after final(), 16 bytes
  return { v: 1, kid: kidOf(dek), iv: b64u(iv), ct: b64u(ct), tag: b64u(tag) };
}

export function decryptField(dek, aad, envelope) {
  if (envelope?.v !== 1) throw new Error("[envelope] unsupported envelope version");
  const d = crypto.createDecipheriv(ALGO, dek, Buffer.from(envelope.iv, "base64url"), {
    authTagLength: 16,
  });
  d.setAAD(aad);
  d.setAuthTag(Buffer.from(envelope.tag, "base64url")); // before final(); invalid length throws
  try {
    // NOTE: update() output is unauthenticated until final() succeeds.
    // Collect, only return after final() passes.
    const out = [d.update(Buffer.from(envelope.ct, "base64url"))];
    out.push(d.final()); // throws on tamper / wrong key / AAD mismatch
    return Buffer.concat(out).toString("utf8");
  } catch (err) {
    throw Object.assign(new Error("[envelope] authentication failed", { cause: err }), {
      code: "ENVELOPE_AUTH_FAILED", // row/workspace/field swap lands here
    });
  }
}

const kidOf = (key) => crypto.createHash("sha256").update(key).digest("hex").slice(0, 16); // same shape as masterKey.js

// DEK wrapping: identical primitives, AAD "workspaceId|kid", key = KEK.
export const wrapDek = (kek, workspaceId, kid, dek) =>
  encryptField(
    kek,
    buildAad(1, "workspaceKeys", workspaceId, workspaceId, "wrappedDek:" + kid),
    dek,
  );
// unwrapDek = decryptField with the same arguments — wrapped row readable only
// under the right KEK and the right workspaceId|kid (wrap-swap resistance).
```

```js
// 2. Crash-safe KEK rotation order (see Integration Patterns §6).
//    DB first, file swap second, prune third, escrow fourth.
import fs from "node:fs/promises";
import { constants } from "node:fs";

// step 2 (one txn): unwrap all DEKs with old KEK, INSERT rows wrapped under K2/kid2.
// step 3: publish new master with rename (NOT link — link never replaces):
async function publishMasterAtomically(file, dir, key /* Buffer 32B */) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  const h = await fs.open(tmp, "wx", 0o600); // exclusive: never clobber
  try {
    if (process.platform !== "win32") await h.chmod(0o600); // umask re-assert
    await h.writeFile(key);
    await h.sync(); // bytes durable BEFORE publish
  } finally {
    await h.close();
  }
  try {
    await fs.rename(tmp, file); // atomic replace: crash-safe at every instant
  } finally {
    if (
      await fs.stat(tmp).then(
        () => true,
        () => false,
      )
    )
      await fs.rm(tmp, { force: true });
  }
  // fsync dir so the rename itself survives power loss (pattern from masterKey.js syncDir)
  const d = await fs.open(dir, "r");
  try {
    if (process.platform !== "win32") await d.sync();
  } finally {
    await d.close();
  }
}
// step 4 (second txn): DELETE old-kid rows. step 5: escrow old KEK file 0600.
```

```js
// 3. Import KEK precheck — before the destructive wipe (Gotcha 12).
function verifyBackupKek(wrappedDekRows, kek) {
  for (const row of wrappedDekRows) {
    try {
      unwrapDek(kek, row.workspaceId, row.kid, JSON.parse(row.wrappedDek));
    } catch {
      // ENVELOPE_AUTH_FAILED => wrong KEK; reject WITHOUT wiping the live DB.
      throw new Error(
        "Backup was exported under a different KEK (master key). " +
          "Restore requires the same TOKENHOP_MASTER_KEY / DATA_DIR/keys/master that produced it.",
      );
    }
  }
}
```

```js
// 4. Fail-closed discrimination during and after migration.
function readSecretField(storedValue, { migrationComplete }) {
  if (isEnvelope(storedValue))
    return decryptField(dekFor(storedValue.kid), aadFor(row), storedValue);
  if (!migrationComplete) return storedValue; // legacy plaintext, transition window only
  throw new Error("[envelope] refusing plaintext secret after migration completed"); // fail closed
}
const isEnvelope = (v) =>
  v !== null &&
  typeof v === "object" &&
  v.v === 1 &&
  typeof v.kid === "string" &&
  typeof v.iv === "string" &&
  typeof v.ct === "string" &&
  typeof v.tag === "string";
```

## Open Questions

1. **Env-KEK rotation UX (needs maintainer decision):** when `TOKENHOP_MASTER_KEY` is the KEK source, does `tokenhop keys rotate` (a) refuse and instruct manual re-wrap with an explicit old/new flag pair, (b) two-phase `prepare`/`finish` with printed base64, or (c) require file-based KEK before rotation is allowed? Recommendation: (c) — simplest failure surface; env stays for immutable-infra installs that never rotate in place.
2. **`workspaceKeys` kid granularity:** one kid column = KEK kid (rotation identity) or DEK kid (envelope self-reference)? Research recommendation: store **DEK kid** (envelopes then resolve to a row without trial-decryption) plus `kekKid` audit column so rotation verifies provenance — but the ADR schema names a single `kid`; confirm with parent lane before schema freeze.
3. **Lazy vs. batch migration:** encrypt-on-next-write (lazy) leaves plaintext in DB until touched — conflicts with the plaintext-scan test unless the migration pass is batch. Recommendation: batch migration under the Default DEK immediately after switch-on (post-backup), exactly once, idempotent by envelope-marker skip; lazy re-encryption only as the transition-window fallback. Confirm parent lane agrees the transition window is measured in minutes (single boot), not releases.
4. **Escrow retention policy for retired KEKs:** how long does `keys/master.<kid>.retired` live? Options: tied to backup count (3 rolling backups ⇒ N days), explicit `tokenhop keys prune-retired`, or manual. Recommendation: manual + documented (YAN-379), auto-delete risks silent old-backup loss.
5. **Settings AAD shape (resolved in this lane):** settings are a single-row blob (`settings.id = 1`); AAD = `v1|settings|<settingKey>|<defaultWorkspaceId>|<settingKey>` (see AAD Assessment, decision 5). Parent lane confirms the builder signature accepts the settings shape — YAN-361/363 land first and may have frozen the AAD helper signature.
6. **ADR-0008 reconciliation (new):** the ADR's AAD prose (`connectionId|workspaceId`) is the weaker form; GH/Linear `table|rowId|workspaceId|field` is canonical for YAN-365. Handbook says ADRs win over README §4 while Linear is the issue source of truth — parent must either amend ADR-0008's AAD line or record the deviation in the PR's Decisions section. Cross-lane note: `research-security.md` finding 5 independently reached the same verdict (field- and cross-table transplant), so both lanes recommend the 4-part AAD; the only delta is encoding (security lane allows length-prefix alternative, this lane picks `|`-join + reject because all covered ids are `uuidv4`).
7. **`providerNodes` secret field inventory:** #233 lists "`providerNodes` secrets" without naming fields (the registry-driven secret-field list exists for `providerConnections` per ADR-0008 "secret fields per provider registry entry"). Parent lane owns the exact field list; the crypto module should take `(table, rowId, workspaceId, field)` generically so the inventory lives in one registry constant, not in the cipher.
8. **Refresh-path failure semantics:** on unwrap failure mid-refresh, ADR-0008 says connections report "unreadable" — confirm whether that is a persisted connection status flag (new UI state) or a transient error surfaced through the existing error path, since it affects YAN-379 docs and dashboard strings.
9. **`workspaceKeys` kid granularity (refined):** store both `dekKid` (envelope resolution) and `kekKid` (rotation provenance) as separate columns — single overloaded `kid` makes the dual-kid rotation window (old+new KEK-wrapped rows coexist) ambiguous. Conflicts with ADR's single-`kid` schema sketch; parent decides.

---

_Sources verified 2026-10-06: nodejs.org v24 API docs (Context7 + local fetch), OWASP Cryptographic Storage + Key Management + Secrets Management cheat sheets (fetched live HTTP 200 from cheatsheetseries.owasp.org on 2026-10-06; KM byte-identical across two fetches, CS identical modulo whitespace), Google Cloud KMS envelope + AAD docs (AAD page fetched live 2026-10-06), nodejs/node official crypto tests, auth0/express-openid-connect HKDF pattern, GitNexus/caveman O_NOFOLLOW patterns, GH #233 body, ADR-0008, handbook README §4-§8, worktree sources `src/lib/security/masterKey.js`, `src/mitm/manager.js`, `src/lib/db/{index,backup,schema}.js`, `src/lib/db/repos/connectionsRepo.js`. Cross-read: `research-security.md` (security lane) — findings 5 (field/table swap, same 4-part AAD verdict), 1/18 (MITM legacy cutover), 3 (fail closed), 11 (VACUUM/WAL remnants — dovetails with retired-KEK escrow note in gotcha 11, not duplicated here). No direct conflicts; deltas noted in Open Questions 6 and 8/9 of that file._
