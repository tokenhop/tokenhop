# Security Research: YAN-363 — Hashed workspace-scoped API keys

## Executive Summary

Security lane: Oracle, read-only review of worktree bf80e10a, GH #231 and approved ADR-0002/0005/0008. Orchestrator transcribed findings; no implementation security validation yet. ADR-0005 supersedes stale SHA-256/service-key bullets: HMAC with HKDF-derived secret and dedicated internal MITM credential. Gateway bearer authority must remain separate from dashboard membership authority.

## Findings by Severity

### CRITICAL — Hard Stops

| Finding                                        | Evidence                                                                        | Required mitigation                                                                                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cookie or bearer authority confusion           | session.js:167–180 prefers cookie/CLI before API-key hook                       | Dedicated gateway resolution; presented key fixes workspace/scopes; API-key principal cannot administer dashboard or host                                                                               |
| Boolean validation leaves global routing       | apiKeysRepo.js:73–78; dashboardGuard.js:46–55; sse/services/model.js:34–95      | Carry principal through aliases/combos/nodes/candidates or reject execution paths lacking isolation until YAN-368                                                                                       |
| CLI bypass of peer boundary                    | requireClientApiKey.js bare hasValidCliToken vs session.js cliTokenAccepted     | Shared resolver uses trusted direct peer; chat parity without remote CLI acceptance                                                                                                                     |
| User keys survive lifecycle changes            | usersRepo.js invalidates sessions only; membership removal lacks key revocation | Transactionally deactivate user keys on disable/delete/leave; no SET NULL conversion to service key; re-enable/rejoin cannot revive; live eligibility checks                                            |
| Hash-only MITM cannot recover raw credential   | base.js forwards ROUTER_API_KEY, does not compare incoming keys as ADR claims   | Fresh internal token/hash before controlled spawn/restart; raw only parent memory/child env; stop old process before replacement; fail closed on spawn failure; never fallback first client key/default |
| Hash migration leaves raw usage/presets/export | usageRepo.js:174–179,374–380; apiKeyUsageRepo.js; db/index.js exportDb          | Immediate ID-only writes and history remediation or block affected enabled paths; no acceptance-critical leak deferred                                                                                  |
| Off-after-on undefined                         | Irreversible dropped key column vs runtime flag                                 | Durable storage state; never resume plaintext/global authority. Refuse migrated off-state with restore guidance unless compatible secure mode explicitly designed and tested                            |

### WARNING — Must Address

| Finding                                     | Mitigation                                                                                                                                                        | Alternative                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Cache staleness across modules/processes    | Prefer indexed lookup; if cache required cache immutable metadata only, live eligibility on every request, invalidation on all mutations/import; expiry every hit | No resolver cache, disclose deviation for decision      |
| Backup contains raw keys                    | Restrict permissions, document secret-bearing backups, separate master key from DB distribution                                                                   | Rotate legacy keys after upgrade                        |
| Late observability redaction                | Remove credentials/cookies/CLI proof before capture; scrub URL key; sentinels in real sinks                                                                       | Existing sink redaction defense-in-depth                |
| Member-created service key evades lifecycle | Own user keys by default; service keys require workspace.keys.manage; reject foreign user selection                                                               | No new role system                                      |
| Legacy export/import incompatible           | Reject unsupported enabled-state operations before destructive SQL; never export master/hash key material                                                         | Narrow versioned round-trip with hashKid/key validation |
| Query credentials enter access logs         | Preserve compatibility, redact app URLs; document proxy filtering/header preference                                                                               | Compatibility change requires separate approval         |

### ADVISORY — Best Practices

Reuse limiter for weak legacy keys if appropriate; rotation notice recommended. Rich audit storage deferred to YAN-367. Legacy keys supported through v1.x per ADR.

## Authentication and Authorization

Bearer possession grants gateway authority within its workspace, not dashboard membership. B cannot obtain A keys via management, override workspace, or enlarge scopes; a legitimate holder of A bearer necessarily has A authority. Dashboard CRUD requires session/approved local CLI, current membership and capability. Foreign key IDs return 404.

Do not reuse principalScope's one-active-user unscoped shortcut for keys: one user can own multiple workspaces. Service principal has null user and one workspace, never synthesized owner/manager capabilities. Invalid supplied credentials never fall back to keyless owner, even when requireApiKey=false. Keyless owner+Default needs proven local socket peer and multiUserActive denial unless explicit admin opt-in.

### Gateway coverage

Cover chat/Claude/Responses/compact/Ollama; embeddings/image/TTS/STT; search/fetch; video create/edit/extend/poll/content; native Gemini and translated chat; models list/info/detail/voices/count-tokens; rewrite aliases and direct API paths. Consolidate resolver, not unrelated routing.

Check allowedModels after canonical alias resolution and every upstream attempt; allowedCombos before expansion. Include nested combos, fusion/judge, capacity adapters, provider/account fallback. Internal probes carry authorized workspace; skipApiKeyCheck must not bypass resource isolation.

## Data Protection

HMAC-SHA256(HKDF(masterKey, "tokenhop/api-key-hash"), key), not plain SHA-256: legacy entropy about 31 bits. Generate th_ plus 32 base62 via rejection sampling or randomInt, not modulo-biased bytes/Math.random.

Shared loader uses validated 32-byte TOKENHOP_MASTER_KEY or atomic DATA_DIR/keys/master 0600; never regenerate missing/corrupt master for migrated DB. No master key/hash material in responses/logs/DB. Metadata projection excludes raw key and keyHash; creation alone reveals raw with Cache-Control: no-store. CLI display/copy is intentional credential handoff, not logging.

Logical migration cannot prove forensic erasure from SQLite free pages/WAL, legacy JSON, backups or external configs. Define live-data/sink guarantee honestly and protect retained recovery artifacts.

## Dependency Security

node:crypto and existing SQLite adapters only; no new dependencies. No advisory scan performed and no CVE-free claim. Password-hashing/native dependencies add unneeded hot-path cost; approved HMAC suffices.

## Input Validation

Allowlist mutable fields; prohibit credential/hash/workspace/user reassignment. Strict booleans; bounded scope arrays, canonical identifiers and valid expiry. NULL expiry unrestricted; invalid/malformed JSON never becomes unrestricted. Parameterized SQL. Bound token length before hash. Never forward gateway bearer as upstream credential.

## Infrastructure Security

Use custom-server.js/trustedPeer.js authenticated peer proof, not Host/Origin/XFF. Production lacking proof fails closed. Preserve CSRF/dashboard boundaries despite gateway CORS compatibility. Internal MITM principal explicit owner+Default, direct-local restricted, not universal bearer bypass. Host compromise can read process env and is outside approved at-rest threat model.

## Secure Coding Guidelines

Immutable gateway principal, repo scope enforcement, handler capabilities. Durable revocation plus current expiry/eligibility; no unbounded negative cache. Switch-on migration requires backup, stable master, owner/Default, atomic rebuild and completion marker only after success. Restart cannot hash hashes.

## Trade-off Recommendations

1. Approved ADR beats stale checklist.
2. Indexed lookup simplest; cache only immutable metadata if issue requirement retained.
3. Pristine switch-off stays unchanged; off-after-on is irreversible-state transition.
4. Fix minimum YAN-368/370/374/375 boundary pieces or reject unsupported enabled paths.
5. Keep recovery backup; document secret-bearing nature and rotation rather than promise no raw bytes anywhere.

## Open Questions

- Restart-time MITM regeneration versus approved unrecoverable storage/restart prose.
- Fail-closed off-after-on versus tested compatible mode.
- Service-key creation requires manage capability.
- Immediate usage-ID writes/history migration ownership.
- Enabled import/export refusal until YAN-375.
- Multi-process revocation staleness and cache policy.

## Verification

Owner: security lane; static threat model only. Required implementation evidence: cross-workspace CRUD/use; cookie/key conflict; lifecycle revoke without resurrection; expired cache; all modalities/rewrites; alias/combo/fallback escapes; off/on/off-after-on; MITM restart with zero client rows; master loss; unique sentinel absence across responses/logs/live DB/export. Tests run only with isolated repository config.
