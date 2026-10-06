# YAN-365 Envelope Encryption — Verification Plan

Evidence path for GH #233 / Linear YAN-365, written before implementation. Parent session owns validation and final sign-off. Inputs: all seven `research-*.md` files (including `research-technical.md`), [`decisions.md`](decisions.md), [`feature-spec.md`](feature-spec.md) and current test/config seams.

## 1. Accepted decisions encoded by these tests

Parent accepted these on 2026-10-06. Full text and the ADR-0005/0008 amendments are in [`decisions.md`](decisions.md); that file is the durable record, because the main-checkout ADRs are gitignored and absent here. Changing a decision means editing the matching assertion, never deleting the claim.

| ID  | Decision                                                                                                                                                                                                                                                        | Claims     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| D1  | Field AAD `v1\|table\|rowId\|workspaceId\|field`. Components containing `\|` or control characters, empty components and NULL workspace throw. Exact vectors are in decisions.md. Wrap AAD is domain-separated (`workspaceKeys`, `_meta` hash key, `settings`). | C2         |
| D3  | Missing, wrong or corrupt KEK: sticky readiness reject. No regeneration, no plaintext or legacy fallback.                                                                                                                                                       | C4, C10    |
| D4  | Established encryption is independent of `TOKENHOP_MULTI_USER`.                                                                                                                                                                                                 | C10        |
| D5  | Default workspace is undeletable unconditionally (`409 DEFAULT_WORKSPACE_PROTECTED`, zero mutation). Default DEK rotation re-encrypts instance secrets.                                                                                                         | C6, C7     |
| D6  | The derived API-key hash key is wrapped under the KEK. `apiKeysHashKid` is frozen; `credentialsKekKid` is new. One getter serves every caller.                                                                                                                  | C5         |
| D7  | Checked WAL TRUNCATE plus VACUUM after activation, with a cleanup-pending marker. Pre-existing backups and exports are documented, not cleaned.                                                                                                                 | C1         |
| D8  | CLI and admin KEK rotation, per-workspace DEK rotation, and ciphertext export/restore are in YAN-365 scope.                                                                                                                                                     | C5, C6, C9 |
| D9  | Env-managed KEK: automatic KEK rotation refused (`409 KEK_ENV_MANAGED`, no mutation, guidance). DEK rotation still works. Two-key protocol deferred.                                                                                                            | C5, C6     |
| D10 | Coverage allow-list as listed. Proxy pools stay plaintext, flagged for discovery.                                                                                                                                                                               | C1         |
| D11 | Legacy MITM value decrypts strictly once; on failure, activation aborts.                                                                                                                                                                                        | C1, C3     |

Folded from `research-technical.md`:

- `src/lib/auth/gatewayResources.js` raw reads must decrypt.
- Transactions must not await (adapter savepoints release on a returned Promise).
- `tokenRefresh.js` currently drops a minted `apiKey` and swallows write failures.
- `featureSwitch` needs a raw settings read to avoid a decrypt cycle.
- Transfer root proof assumes hash kid equals master kid.
- KEK publication needs staged file, durable DB, rename and restart recovery.
- Metadata listing must not fail on one unreadable secret.

## 2. Claims, tests, owners

**Impl owner:** the YAN-365 implementation lane writes and greens these tests first (TDD, handbook §7.4). **Parent evidence owner:** the parent validation session reruns them on the final head and records output in the PR "Verification evidence" section. Parent owns every row's final evidence; impl owner is listed per row.

| #   | Claim                                                                                    | Test file (new or extend)                                                                        | Critical assertions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Impl owner            |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| C1  | No covered plaintext in the DB, or in a backup extracted after activation                | `credential-encryption-activation.test.js` (new)                                                 | Seed unique sentinels (`SENTINEL-yan365-<field>-<rand>`) in each covered field: connection `accessToken`/`refreshToken`/`idToken`/`apiKey`/cookie/nested `providerSpecificData` secret, node secret, `oidcClientSecret`, three SAML keys, MITM sudo. Activate, then flush/checkpoint. Read raw bytes of DB, `-wal`, and a `backupDbLite` copy taken after activation; no sentinel found. Same scan over `exportDb()` JSON. The pre-activation protected backup **does** still contain sentinels and is 0600 inside a 0700 dir: assert both (documents the limit, see §5).                                                            | crypto/migration lane |
| C2  | AES-GCM tamper, each AAD component, and field swaps are rejected                         | `envelope-crypto.test.js` (new, pure, no DB)                                                     | Round-trip; fresh IV per encryption. Flipping one byte in each of `iv`, `ct`, `tag` rejects. Bad `v`, unknown `kid`, wrong lengths, non-canonical base64 reject. Changing **each** AAD component alone (table, rowId, workspaceId, field) rejects. Swapping envelopes between two fields of one row, two rows, two workspaces, connection↔node, and connection↔settings rejects. Wrong DEK and wrong KEK unwrap reject. Errors carry a typed code and no key, IV, tag or plaintext.                                                                                                                                                  | crypto lane           |
| C3  | Migration is idempotent and keeps existing workspace ownership                           | `credential-encryption-activation.test.js`                                                       | Legacy fixture with rows in Default, a personal workspace and a shared workspace (`tenancyHarness`), plus one legacy NULL-owner row. After activation: each row decrypts under **its own** workspace DEK; the NULL-owner row is backfilled to Default; `workspaceId`/`createdByUserId` unchanged. Second activation: no write (envelope bytes and `workspaceKeys` rows identical). Mixed plaintext+envelope fixture reads correctly. A failure injected mid-transaction preserves rows, markers and key graph (allow SQLite header/journal bookkeeping to change), plus a usable protected backup.                                   | migration lane        |
| C4  | Missing or wrong KEK is rejected before any destructive import                           | extend `db-import-backup.test.js` + `gateway-key-transfer.test.js`                               | On an encrypted instance with the KEK file removed / env wrong / file corrupt: `importDb` throws a typed error **before** a backup is created or any table is wiped (compare row counts and file hash). Startup on an established instance without KEK rejects sticky and never creates a new `keys/master`. A plaintext legacy payload imported into an encrypted instance never leaves a plaintext secret behind.                                                                                                                                                                                                                  | transfer lane         |
| C5  | After KEK rotation and restart, existing gateway keys still authenticate                 | `credential-encryption-lifecycle.test.js` (new)                                                  | Issue a `th_` key and hash a legacy key, then rotate KEK. Field ciphertext is byte-identical; every `workspaceKeys.wrappedDek` changed. Simulate restart (`vi.resetModules`, re-run startup activation). Both gateway keys authenticate through `apiKeyPrincipal`; a connection decrypts; `importDb` root proof passes. Old KEK alone no longer unwraps. Failure before durable rewrap leaves old KEK working; failure after durable rewrap keeps readiness closed until staged-root recovery proves new KEK usable. Rotate route/CLI is refused for non-owner and hidden (404) while the switch is off on a never-enabled instance. | rotation lane         |
| C6  | Rotating the Default DEK re-encrypts the instance secrets                                | `credential-encryption-lifecycle.test.js`                                                        | Rotate Default DEK: every Default-owned connection, node and instance-secret envelope changes `kid`; all still decrypt (settings read, MITM sudo load); other workspaces byte-identical. Old Default DEK row gone. A refresh write racing the rotation cannot leave mixed generations (serialize, then assert all one `kid`).                                                                                                                                                                                                                                                                                                        | rotation lane         |
| C7  | Cache eviction, workspace deletion, and Default protection                               | `credential-encryption-lifecycle.test.js`                                                        | Warm the DEK cache, then delete a shared workspace: `workspaceKeys` row gone in the same transaction; cache no longer returns that DEK; an earlier envelope copy no longer decrypts with the live KEK on the live DB. Same for user deletion of a personal workspace (`usersRepo` path). Cache size stays bounded under N+1 workspaces. Deleting the Default workspace is refused and the instance secrets still decrypt.                                                                                                                                                                                                            | lifecycle lane        |
| C8  | A real refresh merges the encrypted row atomically                                       | `credential-encryption-lifecycle.test.js` (or extend `token-refresh-generic.test.js`)            | On an encrypted connection, drive `src/sse/services/tokenRefresh.js` with mocked upstream returning a new access+refresh pair. The row holds envelopes for both; decrypted values match; non-secret fields merged. Upstream error, or a tampered stored envelope, writes nothing (row bytes unchanged). No `await` between decrypt-merge-encrypt inside `updateInTx` (asserted by the transaction succeeding with a sync adapter spy).                                                                                                                                                                                               | repo lane             |
| C9  | Export/import moves ciphertext plus DEKs and recovers with the same KEK                  | extend `gateway-key-transfer.test.js`                                                            | Export contains envelopes and wrapped DEKs, no sentinel, no KEK/DEK bytes. Wipe, then import with the same KEK: connections, nodes and instance secrets decrypt, and IDs and `workspaceId` are preserved. Other-KEK import fails in preflight with zero mutation (C4). Orphan or duplicate `workspaceKeys` entries in the payload are rejected.                                                                                                                                                                                                                                                                                      | transfer lane         |
| C10 | Never-enabled + switch off is unchanged; established encryption stays protected when off | `credential-encryption-activation.test.js` (pattern: `gateway-key-established-security.test.js`) | **Off + pristine:** no `keys/master` created, no `workspaceKeys` rows, `providerConnections.data` / `providerNodes.data` / settings byte-identical to a pre-change snapshot of the same writes, no new routes reachable (404). **On → off after activation:** new writes are still envelopes, reads still decrypt, missing KEK still rejects sticky, malformed marker rejects (no legacy fallback).                                                                                                                                                                                                                                  | migration lane        |

Additions to the claims above, from technical research and decisions D1–D11:

- **C1:**
  - Seed every D10 field, including the PSD `clientSecret`, `copilotToken`, `firebaseIdToken`, `mimoPassToken` and `cookie` fields.
  - Read through `gatewayResources` and assert values decrypt.
  - Assert the cleanup-pending marker is cleared only after the scan passes. A crash fixture after commit but before cleanup must finish cleanup on restart before readiness.
  - Assert `proxyPools` is untouched (D10 scope guard).
- **C2:**
  - Assert the six exact AAD strings and their SHA-256 from decisions.md D1.
  - Negative vectors: `|`, `\n`, `\u0000`, `\u007f`, empty component, NULL workspace, and a field not on the allow-list.
  - A swap between the DEK wrap and the hash-key wrap rejects.
- **C3:** a legacy MITM `ivHex:tagHex:ctHex` value is re-keyed. An undecryptable legacy value aborts activation with zero mutation (D11).
- **C4:** a non-NULL marker paired with a missing marker partner fails closed.
- **C5:**
  - Every hash-key caller resolves the same key after rotation: `apiKeyPrincipal`, `apiKeyManagement`, `cliToolSettingsRepo`, `usageRepo`, `codex-settings` route and `importDb` root proof.
  - `apiKeys.keyHash` bytes are unchanged, `apiKeysHashKid` is unchanged and `credentialsKekKid` is new.
  - Env-managed KEK returns `409 KEK_ENV_MANAGED` with no file, DB or marker change (D9).
  - Crash matrix: kill a child process at each boundary (staged file written / DB committed / renamed / finalized), restart, and assert one coherent root.
  - Old KEK cannot unwrap new wraps.
- **C6:** Default DEK rotation keeps OIDC (`oidc.js` string with `.trim()`) and MITM sudo load working. DEK rotation succeeds under env-managed KEK.
- **C7:** deleting Default returns `409 DEFAULT_WORKSPACE_PROTECTED` with zero mutation even when Default holds no secrets (D5). A cache hit after deletion cannot resurrect the key (live-row check).
- **C8:**
  - A refresh that mints `apiKey` persists it encrypted.
  - A persistence or integrity failure is reported, not swallowed as success.
  - `testUtils.js` refresh does not overwrite sibling PSD secrets from a stale snapshot.
  - A metadata list with one unreadable secret still lists the rows.
- **C9:**
  - The new snapshot version carries `credentialsKekKid` plus the wrapped hash key, and post-rotation export/import works.
  - A plaintext legacy payload is rejected on an encrypted instance with zero mutation (D8).
  - `configExport` stays secret-free.

Not separate claims, but covered by the full gate: tenancy classification (`tenancy-guard.test.js` fails until `workspaceKeys` is classified), route-policy row for any new route (`route-policy.test.js`), secret redaction of decrypted settings (`settings-secret-leaks.test.js`), migration chain shape (`db-migration-chain.test.js`).

## 3. Minimal test files

New (3):

- `tests/unit/envelope-crypto.test.js`: C2. Pure, static buffers, fastest feedback.
- `tests/unit/credential-encryption-activation.test.js`: C1, C3, C10, plus startup-reject half of C4.
- `tests/unit/credential-encryption-lifecycle.test.js`: C5, C6, C7, C8.

Extend (2): `tests/unit/gateway-key-transfer.test.js` (C9 plus C4 transfer cases) and `tests/unit/db-import-backup.test.js` (C4 no-mutation and no-backup). No new helpers unless shared by 2+ files. If a byte-scan helper is shared, put it in `tests/helpers/` (plain function, no framework). Fixtures are seeded through `tests/setup/tenancyHarness.js` and the repos; no checked-in binary DBs. No `*.real.test.js`; every secret is a fake sentinel.

## 4. Commands

Every test run uses `tests/vitest.config.js`, which gives each file its own temp `DATA_DIR`/`HOME` (`setup/tempRoot.js`, `setup/isolateDataDir.js`, forks pool). Clear ambient `TOKENHOP_MASTER_KEY`, `TOKENHOP_TEST_TMP_PARENT`, `TOKENHOP_TEST_REAL_PROJECT`, `RUN_REAL` and `RUN_E2E` before tests; fixtures provide fake roots explicitly. Never run root vitest with another config. No command touches real `~/.tokenhop` or production data. Assert `assertIsolatedHome()` before destructive fixtures. Child-process crash tests inherit the test file's isolated HOME/DATA_DIR, do not load real credentials, and use existing installed SQLite adapters; no additional framework.

Setup, once per worktree:

```bash
npm install && (cd tests && npm install)
```

Targeted, during implementation and for parent spot-reruns (run from `tests/`; the switch is read at module load, so pass it per run):

```bash
cd tests
TOKENHOP_MULTI_USER=off npx vitest run -c vitest.config.js unit/envelope-crypto.test.js unit/credential-encryption-activation.test.js unit/credential-encryption-lifecycle.test.js unit/gateway-key-transfer.test.js unit/db-import-backup.test.js
TOKENHOP_MULTI_USER=on  npx vitest run -c vitest.config.js unit/envelope-crypto.test.js unit/credential-encryption-activation.test.js unit/credential-encryption-lifecycle.test.js unit/gateway-key-transfer.test.js unit/db-import-backup.test.js
```

Adjacent regression set, run once after the repo/settings/MITM seams change:

```bash
cd tests
npx vitest run -c vitest.config.js unit/gateway-key-established-security.test.js unit/gateway-key-activation.test.js unit/gateway-key-startup-integration.test.js unit/tenancy-guard.test.js unit/tenancy-isolation.test.js unit/settings-secret-leaks.test.js unit/background-token-refresh.test.js unit/token-refresh-generic.test.js unit/antigravity-mitm-credential.test.js unit/connection-ownership.test.js unit/db-migration-chain.test.js unit/route-policy.test.js unit/test-data-isolation.test.js
```

Final gate, required because the issue changes app code. Parent runs it once on the final rebased head:

```bash
npm run lint
TOKENHOP_MULTI_USER=off npm test
TOKENHOP_MULTI_USER=on npm test
npm run build
npm run lint:brand
git diff origin/master -- package.json package-lock.json tests/package.json tests/package-lock.json cli/package.json   # expect empty; any dependency change blocks merge without maintainer approval
```

`npm test` writes `tests/results.json` and passes only through the `tests/__baseline__/known-fails.txt` gate. Do not add YAN-365 tests to `known-fails.txt`. Only if the provider registry gains a secret-field marker, also run `node tests/__baseline__/verify-providers.mjs`. CI then repeats tests for 3 brands × switch off/on, plus the build. All legs must be green on the rebased head before merge.

## 5. What tests can prove, and what needs review

Tests prove the live system: current DB file and WAL, backups and exports made **after** activation, current transfer paths, and key lifecycle in an isolated process. They cannot prove:

- **Older copies are untouched by design.** Pre-activation protected backup (`gateway-key-activation-*` / credential-activation prefix), earlier `newest-3` safety backups, `pre-import-*` backups, previously downloaded exports, filesystem snapshots, and swap still hold plaintext. Crypto-shredding cannot reach a backup that carries its wrapped DEK when the KEK survives. C1 asserts the pre-activation backup is still plaintext and private, so the limit is visible. Docs (YAN-379) must state it; tests cannot enforce operator retention.
- **Host or operator compromise.** The KEK is in memory for unattended refresh (ADR-0008 threat table). Not tested; out of scope.
- **Nonce uniqueness, side channels, memory zeroing.** Tests sample randomness only. Correct use of `node:crypto` AES-256-GCM with 12-byte random IVs is a review item.
- **Writer completeness.** Sentinel scans catch only seeded fields and exercised paths. A raw-SQL writer or reader that bypasses the repos (`exportDb`, `gatewayKeyTransfer.js`, `src/lib/auth/gatewayResources.js`, `oauth/providers/index.js` refresh writer, MITM manager) needs a grep-backed review.

Stronger, non-test requirements (parent):

1. Self code review plus `/security-review` on the final diff. Checklist: every `createCipheriv`/`createDecipheriv` lives in one module; no decrypt-error fallback to plaintext; no `await` inside credential transactions; all writers of `providerConnections.data`, `providerNodes.data` and settings secrets go through the encrypt seam (`grep -rn "providerConnections\|providerNodes" src` reviewed line by line); no key/IV/tag/plaintext in logs, errors, audit rows or API responses; `globalThis.__mitmSudoPassword` pattern not extended.
2. `decisions.md` D1–D11 are the binding ADR-0005/0008 amendments; the maintainer copies them into the main-checkout ADRs. The PR states the D7 limits (old backups and exports still hold plaintext; shredding is live-only), D9 (env KEK rotation refused, two-key protocol deferred) and D10 (proxy pools remain plaintext pending discovery).
3. Review explicitly checks: no awaits inside `db.transaction` callbacks; the raw readers and writers (`gatewayResources.js`, `exportDb`, `gatewayKeyTransfer.js`, `oauth/providers/index.js`, `testUtils.js`, quota pollers, MITM) go through the codec or stay opaque; restart recovery never infers commit from the staging file alone.
4. CI green in both switch states on the rebased head. Every real review finding fixed, with a regression test only when it changes a required path.

## 6. Verification budget

- TDD loop: the impl lane runs only its own targeted file(s) per change. The pure crypto file must stay sub-second (no DB).
- The adjacent regression set runs once per seam change (repo, settings, MITM, startup), not per edit.
- The full gate (§4 final) runs **once** on the final head. Rerun only the affected targeted files after review fixes. Rerun the full gate only if those fixes touch app code outside the files already covered, or after a rebase that pulls new `src/` changes. CI is the second full run; do not duplicate it locally.
- No duplicate suites: C-claims each live in exactly one file. Do not copy C2 cases into repo-level tests; repo tests assert envelope presence plus one tamper case only.
- No new frameworks, fixtures libraries, property-testing tools, or dependencies. Plain vitest plus `node:crypto`/`node:fs` byte reads.
- Skip: UI screenshots and theme/RTL checks (unless a UI surface ships; then the handbook §7.6 UI check applies to that surface only), live-provider runs, performance benchmarks, migration of large real DBs.

## 7. Parent sign-off checklist

- [x] D1–D11 accepted by parent (2026-10-06), recorded in `decisions.md`.
- [ ] Crash-matrix (C5) and cleanup-restart (C1) child-process tests green on native and sql.js drivers.
- [ ] C1–C10 targeted runs green in both switch states, with output pasted in the PR.
- [ ] Adjacent regression set green.
- [ ] Final gate green: lint, `npm test` off/on, build, `lint:brand`, no dependency diff.
- [ ] Security review done, findings fixed; limits in §5 stated in the PR and handed to YAN-379.
- [ ] CI green on the rebased head (3 brands × 2 switch states, plus build).
