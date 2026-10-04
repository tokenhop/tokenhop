# Business Research: YAN-363 — Hashed, Workspace-Scoped Gateway API Keys

> Provenance: Linear YAN-363 full description (Scope checklist, Trunk landing, Dependencies, Agent prompt); Design decisions section (YAN-350 approved 2026-10-02, binding); `docs/users/spec.md` (Accepted, verified `master@31c4cf8d`); ADR-0005 (Gateway API keys, Accepted); ADR-0008 (Encryption at rest); ADR-0009 (Versioning); ADR-0002 (Roles/capabilities); ADR-0003 (Identity/bootstrap/CLI principal); handbook `docs/users/README.md` §2–§5, §7–§9; RELEASING.md (release-branches, trunk `master`, target label `v1.1.0`, no backport). File paths in YAN-363 predate rebrand — must be re-derived (issue says so explicitly). No codebase edits performed in this lane.

## Executive Summary

Gateway keys today are raw, ownerless globals: `apiKeys.key` stored in clear, `validateApiKey` a boolean exact-match, usage rows keyed by raw key, any valid key able to use every connection. This breaks both target customers — households (personal subscriptions must stay personal) and small teams (shared credentials need ownership, budgets, audit). YAN-363 turns each key into a hashed, workspace-scoped bearer credential that resolves to a principal `{ workspaceId, userId?, apiKeyId, scopes }`, owned by a workspace and optionally a user. It is the enabling keystone for the gateway chain: YAN-363 → YAN-368 (principal-aware routing) → YAN-370 (usage) → YAN-372 (budgets), plus YAN-365 (shares the master-key loader), YAN-374/375/377 follow-ups. Trunk landing is **behind the switch**; the hash migration is irreversible and runs only switch-on, after backup. Target label `v1.1.0` (tokenhop release group), PR into `master`, no backport.

## User Stories

| Who                                                                                                           | Wants                                                                                                   | Value / problem solved                                                           |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Household member (e.g. Claude Max holder)                                                                     | A key that only touches my personal workspace's connections                                             | My subscription credential is never usable by housemates; ToS stays intact       |
| Team admin                                                                                                    | Service keys that survive member churn (`userId NULL`)                                                  | CI / shared bots keep working when someone leaves                                |
| Team member                                                                                                   | My own user key in a shared workspace                                                                   | I can call the gateway without touching anyone else's key; revocation follows me |
| Instance owner                                                                                                | Existing clients keep working after upgrade with zero manual steps                                      | Default-workspace service-key migration; raw keys hashed in place                |
| Instance owner/admin                                                                                          | Create keys scoped to allowed models/combos, with expiry                                                | Least-privilege distribution; time-boxed tokens for contractors                  |
| Gateway consumer (any `/v1`, `/v1beta`, `/codex`, `/responses`, embeddings, fetch/search/image/video/TTS/STT) | Present key → correct principal resolution with cache                                                   | Requests route only to the key's workspace connections + grants                  |
| Local CLI / loopback operator                                                                                 | Keyless local requests keep working in single-user; refused once multi-user active unless admin opts in | No breakage today, no silent owner-bypass tomorrow                               |
| MITM auto-start operator                                                                                      | Instance keeps MITM working after keys become hashed                                                    | Dedicated internal credential replaces "first active client key" hack            |
| Auditor / owner (later, YAN-367/370)                                                                          | Keys attributable (`apiKeyId`), metadata listable without secrets                                       | `prefix` display only; full key shown once at creation                           |

Non-goals (from handbook §1, inherited): SaaS multi-org, billing/payments, per-tenant DB files, user-editable ACLs, horizontal scaling. `budgetId` column noted in issue ("added later") — out of scope here.

## Business Rules

### Core rules

1. **Ownership.** Every key belongs to exactly one workspace (`workspaceId NOT NULL`). `userId` set = user key; `userId NULL` = service key. No global/ownerless keys after migration.
2. **Lifecycle (membership-bound).** A user key is revoked when its user is disabled or deleted, or leaves the workspace. A service key survives member churn. (Issue text; YAN-360 owns user disable/delete, so this rule is a cross-issue contract.)
3. **Expiry enforced.** `expiresAt` non-null → reject after expiry at validation time.
4. **Scope filters.** `allowedModels` / `allowedCombos` empty = no restriction; non-empty = allow-list enforced at resolution (gateway enforcement itself lands in YAN-368; YAN-363 stores + resolves + tests the filter).
5. **One-time display.** Full key shown **once** in the `POST /api/keys` creation response. Thereafter only `prefix`. One-time notice that legacy full keys can no longer be displayed.
6. **No raw key anywhere else.** No raw key in any other response, never in logs, never in audit rows (handbook §8 DoD), never persisted (usage migrates to `apiKeyId`).
7. **Legacy continuity.** `sk-{machineId}-{keyId}-{crc8}` keys remain accepted through v1.x. On switch-on migration they are hashed in place and flagged `legacy`; rotation is nudged (low-entropy by construction, ~31 bits). Future major may drop `sk-` acceptance.
8. **Keyless local mapping.** When `requireApiKey` is false and no key is presented, map to owner + Default workspace (replacing `local-no-key`). Refuse when `multiUserActive` is true unless an admin opts in.
9. **Routes scoped by capability.** `api/keys/*` and the CLI keys menu resolve through the YAN-357 capability map: `workspace.keys.create` (create own keys) vs `workspace.keys.manage` (list/revoke any workspace key metadata). Cross-workspace list/revoke/use must fail (B vs A negative tests).
10. **Uniqueness on hash.** Table rebuild; `UNIQUE` on `keyHash`, not on any raw/derived display field.
11. **Cache with invalidation.** `resolveApiKey` short cache; revoke (or user disable/leave, expiry) must invalidate so a revoked key stops working promptly.
12. **CLI-token gap.** Close the inconsistency where `handleChat` doesn't accept the CLI token but `requireClientApiKey` does — one consistent CLI-token path (owner principal, loopback-bound once multi-user active per ADR-0003/YAN-355; alias `x-tokenhop-cli-token` itself is YAN-377, not here).

### Edge cases

- Unknown/inactive/expired key → same generic auth failure; must not leak whether a key id exists (parallels YAN-358 anti-enumeration posture).
- `expiresAt` exactly at now → treat as expired (enforce `now < expiresAt` strictly; document the boundary in tests).
- Rotation of a `legacy` key yields a `th_` key; old hash row deactivated, not deleted (audit continuity, YAN-367 later).
- Master-key loss/change → validation impossible until re-issue (see Contradictions §4); rows carry `hashKid` so old HKDF keys stay loadable until rotated away.
- Zero `apiKeys` rows → MITM auto-start still works via internal credential.
- Switch-off → raw storage + exact-match validation untouched; no `keyHash` reads/writes on hot path.

## Workflows

### Primary flows

1. **Create key (switch on).** Caller with `workspace.keys.create` → generate `th_`+32 base62 (~190 bits, `crypto.randomBytes`) → compute `keyHash = HMAC-SHA256(hashKey, key)` where `hashKey = HKDF-SHA256(masterKey, "tokenhop/api-key-hash", 32)` → persist row (hash, `hashKid`, `prefix` = first 7 + last 4, workspace, user or NULL, scopes, expiry, name) → return full key **once** → never again.
2. **Validate on gateway call.** Presented key → HMAC → `WHERE keyHash = ? AND isActive = 1` → check `expiresAt` → resolve principal `{ workspaceId, userId?, apiKeyId, scopes }` (short cache) → YAN-368 consumes principal for candidate/grant filtering. Wired into YAN-355 principal hook, `requireClientApiKey.js`, and each handler's `requireApiKey` (chat, embeddings, fetch, search, image, video, TTS, STT, v1beta).
3. **Switch-on migration.** Preconditions: switch on + pre-migration backup exists (YAN-352 gates backup on any pending migration). For each raw key: hash in place (`legacy=1`), assign Default workspace, service key (`userId NULL`), keep `name`. Idempotent re-run. Usage rows re-keyed raw→`apiKeyId` (owned jointly with YAN-370; ADR-0005 test impact assigns history migration to the YAN-363/YAN-370 boundary).
4. **Revoke.** Owner/manager with `workspace.keys.manage` (or key owner) revokes → `isActive=0` → cache invalidated → subsequent use fails. Auto-revoke on user disable/delete/workspace-leave (user keys only).
5. **MITM boot.** At MITM enable time, generate dedicated internal credential (same `th_` generator), store only its `keyHash` next to settings (`mitmSudoEncrypted` area), pass value to MITM process via `ROUTER_API_KEY` at spawn (auto-start, restart path, `ACTIVE.defaultApiKey` fallback). Never an `apiKeys` row, never in UI; regeneration only restarts MITM. `src/mitm/handlers/base.js` unchanged (already compares env var).
6. **Keyless local.** No key + `requireApiKey=false` → owner+Default principal (single-user). Multi-user active → refuse unless admin opt-in flag set.

### Error recovery

- Migration failure mid-chain → idempotent re-run safe; backup restore path (3 rolling backups, `requestDetails` excluded) documented in YAN-378 rehearsal.
- Lost/changed master key → keys unvalidatable; recovery is re-issue, not recompute (raw material gone). Must surface as clear "re-issue keys" error, never a crash or partial auth.
- Downgrade after switch-on migration → **unsupported** (ADR-0009); restore pre-migration backup on v1.0.x. Switch never turned on → downgrade safe (additive only).

## Domain Model

**Entities (new/changed):**

- `apiKeys` reshaped: keep `id, name, machineId (legacy rows only), isActive, createdAt`; drop raw `key`; add `keyHash TEXT UNIQUE`, `hashKid`, `prefix`, `legacy INTEGER`, `workspaceId NOT NULL`, `userId NULL (=service)`, `allowedModels`, `allowedCombos`, `expiresAt`, `budgetId` (later), `lastUsedAt`. Index on `keyHash`.
- Principal (transient): `{ workspaceId, userId?, apiKeyId, scopes }` — produced by `resolveApiKey`, consumed by gateway (YAN-368), usage (YAN-370), audit (YAN-367).
- Master-key material (shared with YAN-365): `TOKENHOP_MASTER_KEY` (base64, 32B) or generated `DATA_DIR/keys/master` (32 random bytes, mode 0600). YAN-363 introduces the loader; YAN-365 reuses it. Derived `hashKey = HKDF-SHA256(masterKey, "tokenhop/api-key-hash", 32B)`.
- MITM internal credential: `keyHash`-only stored setting, not an `apiKeys` row.
- `usageHistory.apiKey` (raw) → `apiKeyId`; `usageDaily.byApiKey` keys `${rawKey}|…` → `${apiKeyId}|…`; `local-no-key` marker retired for keyless-local (owner+Default mapping). New rows write `apiKeyId` only.

**State transitions:** `active → revoked (isActive=0)` (manual, expiry is a validation-time refusal not a row state, auto-revoke on user lifecycle events); `legacy=1 → rotated to th_` (new row, old row deactivated). Encryption/KEK rotation (ADR-0008) **does not** rehash rows — hashes cannot be recomputed; old `hashKid` keys stay loadable until rotated away.

**Relations:** key → workspace (scope), key → user (nullable, lifecycle), key → budgets (later `budgetId`), key → usage/audit attribution (`apiKeyId`). Gateway candidates = key's workspace connections + grants to that workspace/user (YAN-368/369; grants themselves are YAN-369, only the `scopes` plumbing here).

## Existing Codebase Integration

Per handbook §3 inventory (paths pre-rebrand, re-derive): `src/lib/db/schema.js` (`apiKeys.key` raw, UNIQUE), `src/lib/db/repos/apiKeysRepo.js` (`validateApiKey` exact match), `src/shared/utils/apiKey.js` (`sk-` format, unused CRC/`parseApiKey`), 9 inline `requireApiKey` gates + `src/lib/auth/requireClientApiKey.js` (also accepts CLI token), `src/shared/services/initializeApp.js` (MITM "first active key"), `src/mitm/manager.js` + `handlers/base.js` (`ROUTER_API_KEY` env), `src/lib/cliToolConfigs/shared.js` (embeds `apiKeys[0].key` — YAN-374 follow-up), `GET /api/keys` returning `k.key` + `usageRepo` joins on `k.key` (`apiKeyMap`, `keyNames`, `withUsage`), `usageHistory.apiKey` / `usageDaily.byApiKey` raw-keyed, `local-no-key` marker. Blockers Done: YAN-356 (owner + Default workspace exist to receive migrated keys), YAN-357 (capability map `workspace.keys.create/manage` + guard test for unmapped routes), YAN-351 (switch `isMultiUserEnabled()` / `requireMultiUser()`), YAN-355 (principal hook to wire into). Peers: YAN-352 (backup-gated, switch-on-only execution + legacy fixture harness), YAN-354 (two-user cross-workspace harness for negative tests).

## Success Criteria

From issue Tests checklist + agent prompt + handbook §8 DoD (all binding):

1. Legacy-DB fixture: existing raw key still authenticates after switch-on migration; DB holds `keyHash` + `legacy=1`, no raw key anywhere (scan test).
2. B can't list, revoke, or use A's key (cross-workspace negatives via YAN-354 harness; Isolation matrix in PR).
3. `expiresAt` enforced; `allowedModels`(/combos) filter enforced at resolution.
4. Revoke on user disable (contract with YAN-360 lifecycle).
5. Full key present only in creation response; never in list/detail/logs/audit.
6. Single-user regression: switch off → raw keys, `GET /api/keys`, MITM behavior byte-identical.
7. MITM auto-start works with zero `apiKeys` rows (internal credential).
8. Gates green both states: `npm run lint`, `npm test` with `TOKENHOP_MULTI_USER=off` and `=on`, `npm run build`, `npm run lint:brand`; self code-review + `/security-review` clean; PR `Closes YAN-363` with Decisions/Isolation/Verification sections; CI green on rebased head; squash-merge; issue to Done with PR link + merge commit.

## Open Questions / Contradictions

1. **Hash algorithm supersession (resolved, ADR wins).** Issue Scope checklist says `keyHash` "(SHA-256)"; the Design decisions section + ADR-0005 + spec §1-row-5 normatively require `HMAC-SHA256(HKDF(masterKey,"tokenhop/api-key-hash"), key)` because legacy keys carry ~31 bits. **Binding: HMAC construction, not plain SHA-256.** The checklist line is stale and must not be implemented literally. (Spec/ADRs win over handbook §4 and over checklist shorthand per YAN-350 approval.)
2. **MITM design tension (resolved, ADR wins).** Issue Scope says "explicit instance setting that references a service key"; ADR-0005 says dedicated internal credential, never an `apiKeys` row. **Binding: internal credential.** Rationale recorded: avoids dependency on whichever client key is first and keeps MITM out of the UI/key lifecycle.
3. **Usage-migration ownership split.** ADR-0005 test impact assigns `usageHistory`/`usageDaily` re-keying and new-row `apiKeyId` writes partly to YAN-363, partly "(with YAN-370)". Risk of double-work or gap: orchestrator should confirm the seam (recommend: YAN-363 migrates stored raw keys + switches identity joins to id; YAN-370 owns all new-row attribution and the remaining protocol coverage TTS/STT/image/video/search/fetch).
4. **`budgetId` column timing.** Issue adds column now ("added later" for semantics) vs YAN-372 owning budgets. Harmless if nullable/unread, but confirm no YAN-372 migration conflict.
5. **Keyless-local admin opt-in flag shape.** "Refuse when `multiUserActive` unless an admin opts in" — the opt-in setting's name/location is unspecified (likely instance settings, YAN-362 split). Needs a named decision before implementation.
6. **Prefix collision display.** `prefix` = first 7 + last 4 is display-only (identity joins use row id per ADR-0005 note on `usageRepo.apiKeyIdentity`), so collisions are cosmetic — confirm no uniqueness constraint on `prefix`.
7. **Cache TTL unspecified.** "Short cache invalidated on revoke" — exact TTL / store (in-process, ≤5s like YAN-355 `sv` cache?) left to tech-designer; must cover revoke, user-disable, workspace-leave, expiry.
8. **No new dependencies** (handbook §8): `node:crypto` HKDF/HMAC/randomBytes only — compatible, no approval needed. Argon2/bcrypt explicitly rejected for hot-path hashing (ADR-0005).
