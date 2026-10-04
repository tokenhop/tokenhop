# Feature Spec: YAN-363 — Full-parity hashed workspace API keys

Status: **implementation underway**. P0 crypto is under safety repair and is **not accepted**. Exact next-batch write contracts: [next batch](./next-batch.md).

## Executive Summary

YAN-363 replaces plaintext gateway keys with workspace-scoped HMAC credentials without removing supported gateway, transfer or MITM functions. Pristine switch-off remains legacy; migrated installations retain secure hash storage and working scoped operations after switch-off. Delivery includes only acceptance-critical compatibility slices, not all seven neighboring issues. Approved decisions keep existing permissions, explicit hashed creation and data-preserving migration stops for ambiguous presets. An unused crypto foundation can ship independently; final key migration cannot ship exposed until positive compatibility tests pass. Irrecoverable raw display (Q1) is the one explicit information-limit exception; Q2–Q5 are approved.

## External Dependencies

### APIs and Services

No new external service or dependency. Existing provider APIs remain. Research baseline `bf80e10a`, target `master`, v1.1.0; all seven research files remain historical evidence, not editable instructions. This revision supersedes earlier refusal-based D4 design.

Tracker covers **eight issues including YAN-363**: seven neighbors YAN-362/settings GH230, YAN-364/models GH232, YAN-365/encryption GH233, YAN-368/routing GH236, YAN-370/usage GH238, YAN-374/tools GH242, YAN-375/transfer GH243; all target v1.1.0. Their full scopes are not prerequisites for this issue. Existing graph explains related ownership, not a circular merge sequence: do not merge incomplete363 merely to unblock siblings, and do not demand every sibling Done before finishing363. Required slices below are owned explicitly in363 or inert prerequisite PRs; sibling issues remain open for their remaining scope.

### Libraries and SDKs

| Existing component       | Role                                       | Change                                                      |
| ------------------------ | ------------------------------------------ | ----------------------------------------------------------- |
| Node crypto/fs ≥22.5     | HKDF/HMAC/random/private key file          | No package additions                                        |
| Existing SQLite adapters | Atomic rebuild/import, indexed eligibility | Test native driver and sql.js; explicit durability boundary |
| Next.js                  | Existing proxy/routes/server               | No framework upgrade                                        |
| Vitest                   | Existing isolated tests                    | Only tests/vitest.config.js                                 |

### External Documentation

[Node crypto](https://nodejs.org/download/release/v22.5.0/docs/api/crypto.html), [Node fs](https://nodejs.org/download/release/v22.5.0/docs/api/fs.html), [SQLite rebuild](https://www.sqlite.org/lang_altertable.html), [savepoints](https://www.sqlite.org/lang_savepoint.html), [Next auth](https://nextjs.org/docs/app/guides/authentication).

Do not copy external research's faulty Buffer/base62 sample or `>` expiry boundary. Generate 32 characters by rejection sampling; expire at equality.

## Business Requirements

### User Stories

- As an existing client, I want my legacy key, model names, streaming and media workflows to continue working after migration.
- As a workspace member, I want my key restricted to owned/authorized resources without losing legitimate model, catalog, video or configuration functionality.
- As an operator, I want export/import, backup restore and configured local/remote MITM to remain supported without recovering secrets from hashes.
- As a manager, I want user/service ownership, expiry and permanent revocation without destroying history.
- As a creator, I want explicit one-time secret delivery, not silently provisioned unusable keys.

### Business Rules

1. **R1 — Full functional parity:** positive authorized cases must succeed across all existing paths. Blanket migrated-off503, unsupported-scope403, enabled transfer refusal and remote MITM refusal are rejected designs. Legitimately forbidden access remains401/403/404; corrupt storage, failed backup, unavailable upstream or wrong restore key may still fail appropriately.
2. **R2 — Approved cryptography:** `th_` +32 base62; HMAC-SHA256(HKDF-SHA256(master, empty salt, `tokenhop/api-key-hash`,32), presented). Legacy keys accepted through v1.x, migrated to Default service keys with stable IDs/names.
3. **R3 — Authority:** gateway bearer authority never becomes dashboard/host authority. Supplied invalid key never falls back to owner cookie/CLI/local mode. Every candidate/model/job/catalog is scoped, including non-Default workspaces.
4. **R4 — Durable security:** irreversible hashing persists across later switch-off. No raw-key reconstruction, schema downgrade, unscoped routing or disabled-user resurrection. Existing scoped resources remain usable/manageable; switch-off controls new enrollment/feature rollout, not already-established authorization invariants.
5. **R5 — Decisions D1/D3 approved:** unchanged capability matrix; managers list/manage, members create own user keys, viewers no key list. Explicit hashed creation; no automatic Default Key minting/discard. Pristine legacy behavior unchanged.
6. **R6 — D2 approved:** known local gateway tokens converted to IDs; ambiguous external preset provenance safely stops migration and preserves data. No broad deletion. Operator resolution required only for those ambiguous records.
7. **R7 — Lifecycle:** service null-user survives creator/member churn. User disable/leave sets permanent revokedAt transactionally; pause is reversible isActive. User deletion follows approved key cascade only if history is not cascaded; otherwise retention/FK decision required.
8. **R8 — Secret handling:** creation-only raw response, prefix metadata afterward, no raw readback/server recovery copy/logging. Explicit supplied/new-key client delivery allowed in request/browser memory and intended client config. Protected backups may contain pre-migration raw values.
9. **R9 — Minimum compatibility, not sibling absorption:** YAN-363 must keep currently reachable data/workflows working after key migration. It does not create new workspace-scoped settings/model products, grants, full usage views, remote-member exports, provider encryption or general workspace transfer. Existing global combos/aliases/settings remain instance-owned compatibility data available to authorized workspaces exactly as before, while credentials, jobs and connection candidates are workspace-filtered. No speculative budgetId/budgets/rotation commands.

### Edge Cases

| Scenario                                              | Expected behavior                                                                                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrated DB, switch disabled                          | Hash validation, CRUD, routing, telemetry and transfer continue; prefix UI stays; established membership/session checks remain                            |
| Empty list in hashed mode                             | Explicit Create, no lost auto-provisioned secret; metadata endpoint supplies mode/capabilities                                                            |
| Invalid key plus valid owner cookie/CLI               | Generic401; no authority expansion                                                                                                                        |
| Existing global combo/alias used with a workspace key | Existing name works; every final model/candidate checked against key and workspace. New duplicate-name per-workspace model CRUD stays YAN-364             |
| Multipart video / job poll without model              | Parse non-destructively or recover authoritative job model/owner; do not blanket-deny endpoint                                                            |
| Wrong import master/hash kid                          | Clear preflight error before mutation; live DB unchanged                                                                                                  |
| Remote MITM configured                                | Explicit remote credential handed into spawn; never local internal key sent remotely                                                                      |
| Remote MITM restart                                   | Approved Q2: operator-managed env/file/secret injected at parent startup; kept in parent memory for child restarts; local internal token fresh each spawn |
| Ambiguous preset                                      | D2 stop with record IDs/names only, no raw-value error echo                                                                                               |
| Root lost                                             | Restore matching root or explicit reissue procedure; never silently mint replacement for hashed rows                                                      |

### Success Criteria

- [ ] SC1: pristine off unchanged; off/on/off/on after migration preserves valid client operations and security.
- [ ] SC2: every authorized gateway/modality/alias/catalog/job path succeeds with scoped resources; cross-workspace negatives fail without upstream work.
- [ ] SC3: live lifecycle/scope/expiry checks defeat cache and authority-confusion cases.
- [ ] SC4: raw secret only at explicit delivery boundaries; actual response/log/DB sentinels verify containment.
- [ ] SC5: local MITM fresh per spawn, remote MITM explicit handoff, restart behavior tested under approved Q2 contract.
- [ ] SC6: versioned instance transfer, legacy import and same-key restore work; wrong-key/malformed/collision cases non-destructive.
- [ ] SC7: existing preferences/models/usage/client-config workflows work with new key contracts; only required compatibility slices delivered, no new sibling feature or false sibling completion.
- [ ] SC8: lint/test both environments/build/brand, isolated HTTP/restore and browser matrix, independent code/security/PR reviews pass.

## Technical Specifications

### Architecture Overview

```text
Existing entrypoints (all formats/modalities)
  shared gateway auth + durable security mode
  restricted principal + current workspace preferences/model resolution
  authorized model/connection/job/catalog context
  existing upstream engines + per-workspace selection state
  ID-only usage, existing authorized views, targeted newly reachable isolation

Management session/local CLI
  established identity + current DB membership/capability
  scoped key CRUD, one-time creation, versioned export/import

MITM local: fresh internal token, gateway verifier, child env
MITM remote: explicit external credential source, child env, no local hash reconstruction
```

One security-state resolver used by DB, auth, repos, UI metadata and consumers. No competing fail-open switch caches. No new global key/no-auth bypass.

### Data Models

| Field / entity                              | Contract                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| apiKeys.id                                  | TEXT PK, stable migrated ID                                                                                                                             |
| workspaceId                                 | NOT NULL FK workspaces; scope enforced even migrated-off                                                                                                |
| userId                                      | Nullable user FK; null service, never SET NULL on user deletion to convert user key                                                                     |
| createdByUserId                             | Nullable creator provenance; SET NULL allowed                                                                                                           |
| keyHash / hashKid                           | NOT NULL UNIQUE HMAC digest / root identifier; never regular API metadata                                                                               |
| prefix / legacy                             | First7 + ellipsis + last4; legacy integer0/1                                                                                                            |
| name / machineId / createdAt                | Preserved legacy metadata; new machineId null                                                                                                           |
| isActive / revokedAt                        | Manual pause boolean; permanent lifecycle UTC tombstone                                                                                                 |
| allowedModels / allowedCombos               | Validated JSON arrays; canonical provider/model IDs / workspace combo IDs; empty unrestricted                                                           |
| expiresAt / lastUsedAt                      | Nullable UTC ISO; expiry at equality; touch at most once60s                                                                                             |
| _meta.apiKeysHashedVersion / apiKeysHashKid | Durable format/security commitment and expected hash-root identifier                                                                                    |
| gatewayJobs (routing dependency)            | Persisted workspace/provider/upstreamJobId/connectionId/model/creator context for async video authorization; no client bearer                           |
| usage compatibility                         | Current history/daily credential fields converted to IDs; transient ownership context and existing joins preserved; full370 schema/rollup remains later |

Key indexes unique keyHash, workspaceId, userId+workspaceId, hashKid. No budgetId. Baseline has no usage FK to apiKeys; verify after dependency merges. Never cascade key deletion into history. Tombstones retain labels for disable/leave; user-delete retention follows ADR/FK evidence, not accidental conversion to service.

`gatewayJobs` added only if existing dependency implementation has no equivalent. Server needs authoritative async-job model/connection binding; caller-controlled x-connection-id alone is not proof. Composite identity includes workspace/provider/job ID; connection remains owned by workspace. Durable mapping survives restart, and import carries mappings when histories/jobs expected to remain pollable. No speculative generic queue.

#### Root/hash contract

Strict base64 TOKENHOP_MASTER_KEY exactly32 bytes or resolved DATA_DIR/keys/master, file0600/directory0700, safe exclusive creation+fsync. Shared loader with YAN-365; current kid first16 hex SHA256(root). HKDF empty salt and fixed info tested. Generator accepts random bytes below248, maps to base62 until32 characters. No Math.random, biased modulo or unkeyed legacy hash. Only current kid required before rotation; unknown kid errors before auth/import mutation. YAN-377 must add retained-kid support before rotation; no archive vault now.

#### Durable mode after switch disabled

```text
legacy: switch off, no committed hashing marker
pending: enabled, migration preparing/not committed
hashed-enabled: marker valid, switch on
hashed-compat: marker valid, switch off
error: corrupt/incompatible state or unavailable required key
```

`hashed-enabled` and `hashed-compat` share storage, identity/lifecycle, capability, routing, telemetry, transfer and metadata behavior. Switch alone must never disable security checks after commit. Existing users/workspaces/keys stay manageable; hide unfinished enrollment/navigation only when it does not remove access to existing resources. Session validation checks status/sessionVersion/membership in both hashed states; local keyless rule uses actual active-user/shared-workspace cardinality in both. `requireLogin=false` cannot reopen a multi-user DB. Metadata explicitly reports hashed mode even empty list.

This is a security-state latch, not silently turning env variable on. `isMultiUserEnabled()` remains the sole rollout switch reader; `usesEstablishedSecurity()` reads durable state plus that result. Key/state bootstrap must be below session logic and cannot recursively import the DB barrel. Migrate schema sync selects final definition from marker even with env off. Reads cannot restore raw column/index.

Pristine off stays behavior-identical. Migrated-off cannot be pixel/raw-display-identical because raw data is destroyed; Q1 explicitly names impossible compatibility. Full functional parity means accepted operations continue, not removed privacy/security rules.

#### Atomic lazy migration and activation

Normal numbered migration prepares metadata without hashing/root generation. Separate backed-up lazy step executes only switch-on, after owner/Default and prerequisites verified. Successful protected backup mandatory; failed backup leaves state unchanged. Synchronous transaction hashes/rebuilds keys, converts gateway credential occurrences/history/presets, preserves counts/IDs, checks FKs, stamps marker and kid. sql.js flush must throw on durability failure; unavailable until persisted. **Approved timing amendment (user decision): activation is restart-only, not runtime-drain — the operator turns the env/stored switch on (or off) and restarts; the migration runs during startup before request readiness, and runtime switch toggling inside a live process is not supported.**

Activation only after363's bounded compatibility set is deployable together; no production switch-on enters partially scoped execution. Stage pure contracts/additive preparation without exposing incomplete behavior, then coherent final integration. No prerequisite on full sibling features, no permanent unsupported endpoints and no readiness claim by returning403 everywhere.

D2 blocks ambiguous preset conversion non-destructively. Mark validated local raw values by ID; unknown gateway history gets keyed pseudonym; do not rewrite upstream-provider secrets. Existing requests finishing across migration normalize at sink against current mode; never reintroduce raw usage. Credential readback responses recheck mode before returning loaded legacy data. Recovery backups/legacy JSON not silently erased; logical removal differs from forensic erasure.

### Gateway and Dependency Integration

Full parity removes previous Default-only shortcut without requiring all of362/364/368. Existing settings/combos/aliases/custom/disabled-model KV have no workspace ownership yet and remain explicit instance-owned compatibility resources. Preserve existing names, definitions and management restrictions; a combo is model configuration, not permission to use global credentials. Resolve its models normally, then authorize every canonical target and select only key-workspace connections/nodes. Dynamic catalog exposes only permitted targets and fetches only with authorized owned credentials. Do not invent per-workspace duplicate-name CRUD or copy all global data into every workspace. When YAN-364 later introduces row ownership, resolver switches to ctx lookup with migration, not another permanent global fallback. Actual node repo is `nodesRepo.js`.

Small required routing slice threads principal, enforces workspace candidates/preferred IDs/jobs across every handler, and keys existing selection/rotation state by workspace where sharing it would alter credential selection. Full grant hooks, redesigned settings API and independent catalog/model tenancy belong siblings. Existing configuration predicates remain usable by all permitted callers; no false claim that preexisting global configuration is already private workspace data.

- Auth cache max1024 digest-to-ID, TTL5s, immutable only; live eligibility/scopes on every request. API key remains gateway-only; management cookie/CLI separate. Presented invalid/empty/malformed key fails before fallback. Gateway ignores dashboard cookie.
- Empty scope unrestricted; nonempty arrays exact canonical IDs. Check aliases, nested combos, fusion/judge, capacity-adapter additions and every fallback. Legitimate authorized alternatives still execute; forbidden target403 is authorization, not missing implementation.
- Candidate SQL and preferred connection checks use workspace; no global fallback. Free/no-auth providers still authorize model/usage context. Custom node catalog fetch only after ownership check.
- Native Gemini/actions preserve query/header extraction and model context; messages/Responses/compact/Ollama wrappers preserve principal across reconstruction.
- Media defaults resolve from provider schema/config before checks. Multipart video inspected via cloned/body-byte representation without modifying forwarded bytes; any prefix rewrite preserves other fields/boundaries. Invalid format400 remains valid, but supported multipart does not become unsupported403.
- Async video generate/edit/extend returns existing response while recording job provenance from successful upstream response. Poll/content uses recorded model+connection within workspace, rechecks current key model scope and user/job access. Approved Q3: legacy unrestricted keys poll via an authorized workspace connection; restricted keys require recorded or owner-confirmed model; all new jobs mapped; no global fallback; supplied IDs alone never trusted.
- Internal probes use authenticated caller ctx in-process; no owner CLI token escalation. Full catalog/count_tokens/voices support uses same policy.

Minimum usage slice stops bearer persistence now, converts historical gateway-token fields to key IDs/keyed pseudonyms, and keeps existing joins/counts/UI working. Existing history apiKey slot can temporarily store IDs under durable migration-version semantics; request context carries apiKeyId/workspaceId/userId for future370. Do not require real rollup redesign, all-modality accounting/performance benchmarks or new scoped usage product to ship keys. Existing telemetry management remains constrained by current route capability; if a newly enabled caller could reach another workspace's data, add targeted filtering to that reachable path rather than declaring all370 complete. No raw-token leak deferred.

### Versioned Export and Import — Functional, not refused

YAN-363 keeps the **existing instance database export/import endpoint** working for current schema plus hashed keys and legacy imports. It does not implement YAN-375 workspace export, passphrase portability, multi-user diff UI or new encrypted-provider format. YAN-365 is not prerequisite while provider credentials retain their current plaintext format; when365 lands it must extend this versioned snapshot. Master/root remains separate. Same-root restore mandatory now.

```json
{
  "format": "tokenhop-instance",
  "formatVersion": 2,
  "schemaVersion": 6,
  "security": {
    "apiKeyStorage": "hmac-sha256-hkdf-v1",
    "hashKids": ["root-fingerprint"],
    "keyCheck": { "nonce": "base64-random", "tag": "domain-separated-HMAC" }
  },
  "tables": {}
}
```

SchemaVersion example is illustrative, serialized value equals actual dependency-integrated schema, not frozen6. Tables are typed complete validated snapshot, not arbitrary executable SQL; export keyHash/hashKid metadata needed for restoration but **never root/derived hash key/raw gateway token**. Reauth/admin restrictions unchanged or strengthened. Internal MITM verifier/ephemeral state omitted/regenerated; remote source references portable only after explicit destination review, never export raw external credential.

- Prepare snapshot consistently from tables actually present after363: existing exported settings/connections/nodes/pools/combos/KV, users/identities/workspaces/memberships, hashed key metadata, durable security marker and minimal gateway job binding. Existing usage-history exclusion policy remains explicit unless current exporter changes; never claim omitted data restored. Fix existing disabledModels omission only if reachable compatibility requires it; otherwise preserve tracked YAN-375 bug ownership.
- Master travels separately via operator-managed env/private file. Verify supplied current root derives expected kids and challenge HMAC before mutation. Kid fingerprint alone insufficient compatibility proof. Imported proof demonstrates key compatibility, not authenticity of untrusted content: schema/type/FK/ownership/count validation still mandatory.
- Restore on clean destination with same separately-provisioned master preserves raw client tokens' validity. Existing destination with conflicting master/users requires explicit owner-approved replacement procedure and destination backup, not automatic overwrite of key file.
- Restore original master separately (approved Q4). A differently keyed destination fails preflight before mutation; live DB and master remain untouched, never auto-replaced. Cross-root hashed-key continuity is out of scope without reissue.
- Stage import in scratch isolated DB, validate versions/types/scope/FKs/kids/secret fields before live mutation. Dry-run difference report identifies destructive overwrite/users/key conflict. Unknown newer format/version rejects without wiping. Legacy v1 export raw keys are accepted input, hashed into destination Default with IDs/names preserved; never echoed or persisted plaintext in migrated DB.
- Apply prevalidated snapshot in one synchronous live transaction with required pre-import backup; check FKs/counts before commit; persist before reporting success. Failure rolls back or reports durability failure with preserved backup. Do not swap live DB file while active singleton writes continue; quiesce concurrent writers at commit. Flush/invalidate usage/identity/session caches and reset runtime state after successful replacement.
- In hashed-compat, same versioned transfer works. Legacy import cannot remove durable security mode or turn existing users into implicit owner. No blanket409 solely because hashing enabled.

### Remote MITM — Explicit Credential Handoff

Local mode remains dedicated internal credential, fresh every spawn, settings hash only, direct-loopback scoped Default, zero apiKeys rows. Stop previous process before replacement; failure revokes installed hash. Strip forwarded client auth/CLI headers; manager never logs token-bearing commands/errors.

Remote mode is distinct: operator supplies **destination gateway credential**, already assigned remote workspace/scopes, or external runtime source provides it. Never send local internal token/root to remote URL. API accepts explicit secret handoff in request body for immediate spawn, returns nonsecret status only; TLS/URL handling protects transport, endpoint changes discard old binding. Save endpoint and nonsecret source descriptor, not raw credential or recoverable local encrypted copy. Child env intentionally carries token, like an external client config; local DB/backup/UI cannot recover it.

Manual remote start works with typed credential. Approved Q2 profile: operator-managed environment/file/secret injected at parent startup (outside tokenhop-managed persistence), retained in protected parent memory for child restarts. Source values never copied into settings/presets/export.

Fresh **internal local** credential every spawn is mandatory. Remote bearer is the operator-supplied external credential; no per-spawn remote issuance is assumed. Remote target's actual auth controls remain authoritative; no locally synthesized owner key.

### API Design

| Path                                   | Hashed-enabled AND hashed-compat                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| GET `/api/keys?workspaceId=...`        | Manager metadata-only list; explicit storage/mode/workspace/capabilities                         |
| GET `/api/keys?meta=1&workspaceId=...` | Authenticated current member's safe mode/capability hints, no keys                               |
| POST `/api/keys?workspaceId=...`       | Explicit create; member own user, manager service allowed;201 raw once + metadata                |
| GET/PUT/DELETE `/api/keys/[id]`        | Manager scoped; metadata only; rename/manual pause/delete; permanent revoked reactivation denied |
| PATCH `/api/keys`                      | Exact migration-notice ack, manage-only; persists across browsers                                |
| Existing DB/config transfer            | Versioned working path, reauth and validation; never blanket refuse hashed mode                  |
| Existing MITM start                    | Explicit local/remote configuration; raw only incoming handoff/child env, status no secret       |

Type discriminator `type:"user"|"service"`; no kind alternative. Prefix no uniqueness. PUT scope/expiry edit deferred; supported create/recreate still works. Name existing64-character/control rule, JSON16KiB max, scope arrays128×256 chars, token4096-byte max, future valid UTC expiry. Reject unknown ownership/hash/budgetId fields; SQL parameterized.

```json
{
  "name": "build runner",
  "type": "service",
  "allowedModels": ["openai/gpt-4o"],
  "allowedCombos": [],
  "expiresAt": "2026-12-31T00:00:00.000Z"
}
```

Metadata no key/hash/kid: id/name/prefix/type/userId/workspaceId/ownerLabel/scopes/expiry/legacy/isActive/createdAt/lastUsedAt/lastUsed/requestsToday. All key responses no-store. Invalid/expired/revoked gateway credential generic401; actual scope denial403; foreign resource404; malformed input400; confirmed-state/restore conflicts409; genuine unavailable storage/root/provider503. **No api_keys_require_multi_user or gateway_scope_unavailable implementation-gap responses.**

### System Integration

#### Files to Create

First slice only: shared crypto module and isolated crypto tests, no activation. Later module paths/state/repo/job/transfer contracts are stage-owned in [plan](./parallel-plan.md). Existing key utility reused, no new framework. Root loader shared with YAN-365.

#### Files to Modify

Stage-by-stage schema/migrations/repos, feature/session security-state users, scoped routing/usage/model/config/transfer surfaces. Previous176-path concurrent dispatch retired; rebase and allocate exact writer paths at each stage, shared schema/barrels serial owner. Research source paths remain references, not blanket write permission.

#### Configuration

Rollout TOKENHOP_MULTI_USER default off, existing feature reader preserved. TOKENHOP_MASTER_KEY strict source. allowLocalWithoutApiKey defaultfalse under actual established security cardinality, including migrated-off. Remote MITM nonsecret source selector resolved only by trusted host runtime; no secret-return endpoint. No speculative budgetId, public switch UI, new dependencies/version/release edits.

## UX Considerations

### User Workflows

1. Explicit create in hashed mode; Me/Service visibility per unchanged matrix, model/combo scopes and expiry presets; one-time CreatedBanner/copy.
2. Prefix-only metadata with type/scope/expiry/Legacy pills; no row reveal/copy; rename/pause/delete manager-only. Member create-only with safe hints; viewer no key list. No silent provisioning.
3. Migration notice server-acknowledged, persistent legacy rotation nudge. D2 names ambiguous records without showing values and explains data-preserving resolution.
4. Migrated-off shows functioning hashed key page, never misleading switch-required outage. Explain irreversible prefix display, not claim raw key recoverable.
5. QuickConnect/setup accepts just-created or explicitly supplied key; produces client config/copy/download through browser or authorized explicit handoff. Metadata selection alone cannot reveal old secret. Host file readback safe/redacted; functional config edit preserves existing secret through server-side merge without returning it, or asks explicit replacement when required. No server raw recovery store.
6. Transfer UI gives version/master requirements, preview diff, destructive confirmation and same-key restore path; errors before mutation. Remote MITM shows external credential source/needs-runtime-supply state without readback.

### UI Patterns

Existing modal/focus/copy/live-region/theme/table/mobile patterns preserved; no full redesign. Explicit storage metadata handles empty list. Home name-only creation allowed; endpoint full scoping. No new workspace-switch project here, but existing-workspace selectors must remain operational after migration/off.

### Accessibility Requirements

Keyboard-only create/rename/pause/delete, native scope/date controls, focus trap/Escape/return focus, aria-invalid/describedby, textual state pills, LTR prefix/reveal in RTL, live copy confirmation, safe destructive default focus. Light/dark and logical spacing.

### Performance UX

Existing loading/retry, no optimistic key mutations/no new polling. One-time reveal only in memory. Workable remote-secret resupply/restore forms do not echo bearer or root in errors. Browser matrix light/dark ×1440/1024/390, RTL, manager/member/viewer, pristine-off/enabled/migrated-off; HTTP positive checks alongside screenshots.

## Recommendations

### Implementation Approach

**Acyclic YAN-363 delivery with bounded compatibility slices.** First executable PR is pure crypto/master-file primitives/tests, unused at runtime, no hashing or gateway behavior change; parent363 remains In Progress. Next, inert data contracts/helpers may be reviewed separately. Final363 integration delivers migration plus required routing/telemetry/config/transfer/MITM compatibility in one release-coherent set. Do not merge an activated incomplete363 and wait for siblings to repair it; do not make all seven siblings prerequisite either.

Related work overlaps issue ownership, not whole-issue dependency. Record exact delivered slice and remaining work with sibling owner, without closing sibling. If safe partial landing cannot be proven for a particular patch, keep it on363 feature branch until positive compatibility passes. No new hidden rollout flags or temporary blanket endpoint failures to disguise partial delivery.

### Technology Decisions

| Decision        | Recommendation                                                  | Rationale                                                     |
| --------------- | --------------------------------------------------------------- | ------------------------------------------------------------- |
| Hash/root       | Approved HMAC/HKDF/shared private root                          | Legacy entropy and encryption interoperability                |
| Migrated-off    | Durable security compatibility mode                             | Preserve working operations without privacy downgrade         |
| Routing         | Real workspace models/preferences/candidates/jobs               | Full parity cannot be supplied by Default-only shortcut       |
| Transfer        | Versioned validated restore with separate key proof             | Secure functionality, not blanket prohibition                 |
| Remote MITM     | Explicit external handoff/source profile                        | Remote token not derivable from local hash                    |
| Lifecycle/cache | Tombstones + live eligibility                                   | Permanent revoke and preserved history                        |
| Execution       | Inert foundation PRs then complete363 compatibility integration | No circular full-issue dependency or false sibling completion |

### Quick Wins

Pure CSPRNG/HMAC/root vectors, source evidence/FK inventory, metadata contracts and existing redaction/helpers are independently reviewable. These do not authorize hashing activation.

### Future Enhancements

Budgets/grants/rotation commands remain separate. They are not prerequisites for owned-workspace parity. Hash-key archive only when rotation introduced; no magical rehash from imported hash. Full sibling issue additions beyond required bridges follow their own acceptance tracking.

## Risk Assessment

### Technical Risks

| Risk                                       | Impact                                             | Mitigation                                                                      |
| ------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| Overstated sibling dependency              | Scope explosion or incomplete363 merge             | Allocate only acceptance-critical bridges; keep sibling scope/status explicit   |
| Off switch disables session/tenancy checks | Global authority leak                              | Durable established-security guard across dependencies, positive+negative tests |
| Async jobs lack authoritative model/owner  | Scope bypass or lost poll compatibility            | Durable job mapping for new jobs; approved Q3 policy for legacy jobs            |
| Restore root mismatch                      | Existing clients fail or destination key destroyed | Separate proof, dry-run, explicit root conflict, no automatic replacement       |
| Remote boot has no secret                  | Impossible unattended authentication               | Approved Q2 operator-injected startup source; no local recovery store           |
| Migration data ambiguity                   | Silent loss/leak                                   | Approved D2 preserved stop, targeted remediation                                |

### Integration Challenges

Neighbor feature contracts are not implemented and are not assumed available. Build narrow bridges against current source, documenting their replacement seams for later work. Security-state latch must cover all established key/management paths; final tests prove post-disable behavior. Allocate schema versions sequentially. Remote credential source (Q2) and legacy job polling (Q3) follow approved policies; tests must prove them before claiming parity.

### Security Considerations

#### Critical — Hard Stops

| Finding                                              | Required mitigation                                               |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| Bearer/dashboard authority confusion                 | Separate resolvers/capabilities, invalid supplied key no fallback |
| Full parity implemented by global candidate fallback | Scope real resources, never broaden key                           |
| Hash-only table while raw sinks persist              | ID-only usage, preset cleanup, safe config/transfer now           |
| Import wipes before validation                       | Scratch preflight, proof/FKs, backup/transaction/quiesce          |
| Remote token/root leakage                            | Explicit destination token, no root export/raw readback/log       |

#### Warnings — Must Address

| Finding                                     | Mitigation                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Backups/free pages/WAL retain past raw      | Honest retention boundary/private backup; no automatic deletion                                       |
| External access logs query credentials      | App redaction plus operator header/proxy guidance                                                     |
| Cache/late requests across state transition | Switch changes take effect only after restart; startup lock/readiness gates migration before requests |
| History FK changes on rebase                | Inspect, retain tombstones, never cascade-delete attribution                                          |

#### Advisories — Best Practices

Host-root compromise outside at-rest threat model. No multi-process sql.js writer support. No acceptance based solely on source scan or all-negative tests. LastUsedAt approximate activity, not accounting substitute.

## Task Breakdown Preview

### Phase 1: Inert crypto foundation

Frozen HMAC/root contract and isolated tests, no runtime callers/migration. Small independently reviewable prerequisite slice; parent remains In Progress. P0 is under safety repair and not accepted.

### Phase 2: Bounded acceptance-critical slices

Within363: hashed repos/lifecycle/principal contracts; current instance model resolution with scoped credentials/jobs; ID-only usage/known-secret cleanup; existing setup supplied-key compatibility; current-schema same-root transfer. Shared root loader alone overlaps365; no provider encryption. Exact sibling handoff notes prevent duplicate work or false completion.

### Phase 3: YAN-363 full integration

Atomic key migration activates only with all its bounded compatibility paths complete, including healthy migrated-off, every gateway positive, local/remote MITM, current UI/CLI and instance transfer. No temporary refusal endpoints, Default-only routing or prerequisite on whole sibling issues.

### Phase 4: Verification

Both env suites plus same-data off/on/off/on; real isolated HTTP models/media/jobs/export/import; browser matrix; reviews/security/PR CI. No implementation performed by this synthesis.

## Decisions

### Approved

- **D1:** unchanged permission map, create-only members, manager list/manage.
- **D2:** safe stop on ambiguous preset provenance, preserve data.
- **D3:** explicit hashed creation, no silent provisioning.
- **D4:** FULL PARITY required. Prior blanket refusals withdrawn; research remains historical.
- **Q2–Q5:** approved; see section below.

### Information limit and approved resolutions

Q1 is the explicit exception. Q2–Q5 are user-approved and no longer open.

**Q1 — Irrecoverable raw display (information limit).** Hashes cannot restore old full-key list/copy behavior after migration or switch-off. Prefix-only plus explicit new/supplied-key delivery is required; user has already stated this unavoidable exception. Document prominently. If “byte-identical migrated-off raw display” is demanded, requirements are mathematically incompatible without forbidden recoverable raw storage.

**Q2 — Approved remote MITM restart profile.** Operator-managed environment/file/secret is injected at parent startup; credential remains in parent memory for child restarts. Local internal credential stays fresh on every spawn. Remote secret is not locally persisted or read back.

**Q3 — Approved legacy video poll policy.** Old video jobs with unrestricted keys may poll through an authorized workspace connection. Restricted keys require recorded or owner-confirmed model. All new jobs receive durable workspace/model/connection mappings. No global fallback.

**Q4 — Approved restore boundary.** Restore original master separately. Mismatch fails during preflight before mutation; preserve live DB and master. No automatic replacement or implied cross-master rehash.

**Q5 — Resolved bounded ownership.** Only approved compatibility overlaps are required; no whole sibling issue prerequisite or implied Done. Exact next-batch write manifests are in [next batch](./next-batch.md). Implementation is underway; P0 remains under safety repair and is not accepted.

Durable established-security mode after migrated-off is required by user direction; if switch-off is additionally required to remove membership/session enforcement, that conflicts with scoped security and must be raised, not implemented.

## Research References

[External](./research-external.md), [Business](./research-business.md), [Technical](./research-technical.md), [UX](./research-ux.md), [Security](./research-security.md), [Practices](./research-practices.md), [Recommendations](./research-recommendations.md), [Revised staged plan](./parallel-plan.md).

Historical research and prior plan choices may recommend refusals; this full-parity revision supersedes them without altering research. Planning-only evidence/validator caveats recorded in plan. No implementation/test/merge success claimed.
