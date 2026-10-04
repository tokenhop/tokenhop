# Bounded Full-Parity Plan: YAN-363 hashed workspace API keys

Status: **REVISED — implementation underway; P0 crypto under safety repair, not accepted.** Next-batch write contracts: [next batch](./next-batch.md).

Worktree `/home/yandy/Projects/github.com/tokenhop/tokenhop/.claude/worktrees/tokenhop-users-api-keys`, baseline `bf80e10a`. Only this plan, `feature-spec.md`, and `next-batch.md` written. Research files retained unchanged.

## 1. Corrections and decisions

Tracker covers **eight issues total including363**, not seven total:363 + seven neighbors362/364/365/368/370/374/375. All v1.1.0. Neighbor GH mirrors230/232/233/236/238/242/243 respectively.

User approvals: D1 unchanged manager/member/viewer permissions; D2 preserve data and stop on ambiguous presets; D3 explicit hashed create, no silent provision. Q2–Q5 approved (see §8). D4 requires working authorized paths: no blanket migrated-off503, unimplemented-scope403, import/export refusal or remote MITM refusal. Legitimate auth/scope/input/root/provider errors remain.

Previous dependency-first sequence demanding all siblings complete before363 is **withdrawn**. It would introduce circular completion requirements and overstate minimum scope. Also reject “merge incomplete363 first, fix parity through later siblings.” No full sibling issue is automatic prerequisite; no partial sibling marked Done.

[Feature spec](./feature-spec.md) defines final architecture. This plan delivers narrow acceptance-critical bridges against actual baseline source. Full neighbor features are explicitly deferred, not silently broken.

## 2. Required slice versus unrelated sibling scope

| Neighbor             | Acceptance-critical slice inside363                                                                                                                                                                                            | Not required / remains sibling                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| 362 settings GH230   | Durable security-mode read and established authorization survive later switch-off; existing settings still function                                                                                                            | New workspaceSettings/userPreferences tables, full route split, per-user theme/locale/preferences product                             |
| 364 models GH232     | Keep existing global combos/aliases/custom/disabled definitions functioning as current **instance configuration**; enforce canonical target/key scope and workspace credential candidates                                      | New per-workspace combo/name CRUD, UNIQUE(workspace,name), new KV tenancy migration, workspace duplicate-name support                 |
| 365 encryption GH233 | Shared validated master/HKDF loader; separately managed master compatibility                                                                                                                                                   | Provider/settings envelope encryption, DEKs/workspaceKeys, KEK rewrap/rotation; plaintext existing upstream format unchanged until365 |
| 368 routing GH236    | Thread key principal across all existing gateway paths; filter owned connections/nodes/preferred IDs; authorize resolved models/jobs/catalogs; partition existing selection state when shared state alters workspace selection | Full grant integration, new settings/model tenancy APIs, all planned state/SDK audits unrelated to key enforcement                    |
| 370 usage GH238      | Stop new raw-key writes; convert historical gateway-key slots/daily keys/meta; maintain ID joins/counts and existing UI; targeted filter only where363 makes cross-workspace data newly reachable                              | Full rollup redesign, new usage pages, all-modality accounting units,100k benchmark, whole usage product                              |
| 374 tools GH242      | Existing host-tool setup/CLI/QuickConnect works with explicit supplied/new key; no key list recovery or raw config readback; known presets converted; D2 unknown preserved stop                                                | New remote-member config export feature/routes for every tool, generalized workspace presets/host settings tenancy                    |
| 375 transfer GH243   | Existing instance export/import works for actual current schema + hashed/ownership/job metadata; same-root roundtrip, legacy raw input hashing, preflight/rollback                                                             | New workspace export, passphrase portability UI, future-table generalization, full encrypted provider backup redesign                 |

Critical boundary: baseline global model/settings data are not yet workspace-private resources. Reusing them as **instance-owned configuration** is not an unsafe cross-workspace credential fallback. Every expanded leaf still uses only principal-workspace credentials and model permissions; dynamic catalogs never fetch with foreign credentials. Preserve current management restrictions. When364/362 later introduce ownership, replace compatibility lookup through documented ctx seam; do not retain a permanent fallback to someone else's private rows. No false claim363 implements model/settings tenancy.

Existing documented telemetry endpoints remain under current capabilities; no newly introduced bearer management access. If concrete363 integration exposes foreign row data, fix that reachable filter now, not entire370 spec. Raw key secrecy is mandatory independent of later usage feature.

## 3. Acyclic delivery strategy

```text
F0 unused crypto/root helpers + tests
F1 optional inert persistence/context helpers + tests (no runtime activation)
F2 complete363 feature branch: key migration + bounded compatibility integration
F3 final positive/negative parity, UI, transfer/MITM, review and CI
```

F0/F1 may be small separately reviewed PRs if they have **no new enabled behavior** and no irreversible migration; title/description state partial foundation, parent363 stays In Progress. Such merge does not constitute “363 merged.” F2 activates all required behavior only once coherent acceptance passes. If a helper cannot land inert without scaffolding/hidden flags, keep it on363 branch and review incremental commits without merging partial runtime feature.

No cycle involving whole sibling issue Done. No required tracker dependency rewiring. Orchestrator allocates overlaps and tracker records delivered prerequisite slices/remaining scope; ordinary approval Q5, not technical blocker. Do not invoke sibling execution workflow whose prerequisite isn't fulfilled simply by pretending foundation is whole363.

## 4. First executable slice F0 — three files, no exposure

Objective: shared generator/HMAC/HKDF/master-file primitives **unused by runtime**, existing legacy utility untouched behavior. No DB/schema/driver/session/handler/bootstrap/UI edits, no root creation at module import, no reading feature env elsewhere, no migration.

| Writer                | Exact write set                                                            | Dependency                                                    |
| --------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| V                     | New `tests/unit/gateway-key-crypto.test.js`                                | First, failing vectors/filesystem tests under isolated config |
| A                     | New `src/lib/security/masterKey.js`; existing `src/shared/utils/apiKey.js` | V test contract                                               |
| Independent reviewers | Read-only                                                                  | Diff/test evidence                                            |

```js
// existing src/shared/utils/apiKey.js; old exports retained
export function generateGatewayApiKey(); // th_ +32 unbiased base62, rejection bytes<248
export function apiKeyPrefix(raw);       // first7 + ellipsis + last4

// new src/lib/security/masterKey.js; no DB/session import
export async function loadMasterKey({ create = false, expectedKid = null } = {});
// { kid, key: Buffer32 }; expected missing/wrong root never regenerated
export function deriveApiKeyHashKey(master); // HKDF-SHA256 empty salt, fixed info,32
export function hashApiKey(raw, hashKey);    // HMAC-SHA256 hex
export function masterKeyId(master);        // first16 hex SHA256(root)
```

Strict base64 TOKENHOP_MASTER_KEY32B or resolved DATA_DIR/keys/master raw32B, directory0700/file0600; exclusive safe create/fsync; reject partial/corrupt files, concurrent create safe; lazy env read, no new dependency/archive/rotation/secret store. Caller later supplies expectedKid from durable marker; helper cannot invent DB policy.

V tests generator32/alphabet/unbiased construction, fixed vectors, prefix, invalid base64/31/33 bytes, create:false missing, expectedKid mismatch/loss, restart/race/permissions, no-call/import no file, legacy generation unaffected. Real isolated temp files, no production paths. Baseline missing import alone insufficient; assertions must validate actual primitive behaviors.

```bash
npx vitest run -c tests/vitest.config.js tests/unit/gateway-key-crypto.test.js
TOKENHOP_MULTI_USER=off npm test
TOKENHOP_MULTI_USER=on npm test
npm run lint
npm run build
npm run lint:brand
```

F0 must not close363 or justify enabling incomplete migration. P0 crypto remains under safety repair and unaccepted. Code/security reviewers required after implementation; no browser gate for unused helper, full UI later.

## 5. Bounded F2 integration lanes — fresh exact manifests before dispatch

Do not reuse176-path manifest. These responsibility boundaries define required scope; approved next-batch exact per-file manifests live in [next batch](./next-batch.md). No whole-directory write grants. Shared schema/barrel/migration/index edits have one serial owner; tests one owner. If precise enumeration discovers more than bounded compatibility, raise scope instead of quietly absorbing sibling.

| Lane                    | Required responsibility and source hotspots                                                                                        | Must not implement                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| A storage/lifecycle     | apiKeysRepo, schema/migrations/rebuild/state, users/memberships tombstones, private backup/flush, own barrel changes               | Full encryption, budget tables, unrelated settings/models migration |
| B auth/durable mode     | session/principal/guard/shared gateway checks, existing feature-reader integration; cache/live eligibility; legitimate keyless/CLI | Bearer management authority, switch-off bypass, new auth framework  |
| C gateway compatibility | all handlers/model/candidate/catalog wrappers, existing combo/alias context, nodesRepo/connectionsRepo, async job binding          | New workspace model CRUD/grants/full routing product                |
| D telemetry secrecy     | usage key slots/joins/carriers/log redaction/late callback normalization                                                           | Whole370 rollup/performance/new accounting product                  |
| E UI/CLI/setup          | scoped key routes, endpoint/Home/QuickConnect/current CLI tools, explicit typed/new secret, metadata-only readback                 | New remote-member export family374 or silent service provisioning   |
| F MITM                  | startup/manager/base, local fresh verifier, remote explicit runtime handoff                                                        | Local encrypted raw vault, undisclosed remote token reuse profile   |
| G instance transfer     | existing export/import/backup endpoints and actual-current tables, separate root proof/preflight/atomic apply                      | Workspace/passphrase/future encryption transfer375                  |
| V validation            | fixtures/contracts/all positive and negative evidence, browser/review coordination                                                 | Product fixes in unowned files, known-fails loosening               |

A owns schema/index/barrel; G sends schema/transfer requirements rather than concurrently editing. C owns handlers; D owns core usage/sinks and supplies signature. E owns browser/CLI; F owns backend MITM contract. B owns settings PATCH protection; F supplies names. All test files V-only. Exact manifests required at dispatch, not pretended frozen final path count now.

### F2 dependencies and activation barrier

1. V records failing migration/auth/secret/positive parity cases before implementation.
2. A establishes inert schema/hash identity/eligibility/state interfaces; B implements key resolution against them; D/G establish key-ID and transfer document contracts.
3. C replaces all inline key gates/candidate paths; E/F adapt existing consumers using B/A contract. G implements working transfer, not disabled mode.
4. A integrates targeted cleanup/backup/rebuild only after D/E/F/G paths consume hashed mode safely. No enabled migration before all necessary paths ready; do not add temporary public403/503 to call partial implementation complete.
5. V runs transition, HTTP, modalities/jobs, restore, remote/local restart and browser positive tests; independent reviewers; final363 merge only after every required gate passes.

If work too large for one final activation PR, split **behavior-preserving** helper/refactor PRs first. Do not ship irreversible hashing as a small PR and defer broken consumers. No completed sibling issue required to satisfy this ordering.

## 6. Concrete compatibility contracts

### Durable established security

`getSecurityState()` returns storage legacy/pending/hashed and rolloutEnabled/established separately. Only pristine off is legacy; hashed+off remains operational secure mode. Established sessions check status/sessionVersion/membership; CLI peer/keyless cardinality based on actual users/shared workspaces in both on/off. Existing established resource routes remain manageable. Feature switch still sole sanctioned env reader; low-level marker read cannot import recursive DB barrel/session.

Schema sync picks final shape by marker, never recreates key column. Marker includes expected kid even zero rows. No `api_keys_require_multi_user` healthy-state error. Legitimate root/DB errors still503. Positive same-data off/on/off/on with non-owner users prevents fake “compatibility” through owner-only global mode.

### Key lifecycle/cache

`resolveApiKey(raw)` returns one-workspace GatewayPrincipal or null; root/state failure typed error. Immutable digest-to-ID positive cache max1024/TTL5s; live hash match/isActive/revokedAt/expiry/workspace/user/membership/scopes on every request. No raw cache keys. User disable/leave sets permanent revokedAt in existing transaction; rejoin/PUT cannot clear. Manual pause reversible. Service survives creator churn. User-delete cascade only if no history cascade; baseline no usage FK to keys, recheck before changing. No budgetId.

Management existing session/approved local CLI separate. Supplied invalid credential never becomes keyless owner or ignores owner cookie's narrower bearer. Actual expiry401 generic, scope403 genuine, foreign metadata404. No implementation-gap scope error.

### Existing models/config and scoped credentials

Keep current instance definitions as explicit compatibility inputs; do not convert them to Default-only or assume workspace-private. `getModelInfo(modelStr,{principal})`, `getComboModels(modelStr,{principal})` resolve current definitions, authorize canonical targets; stable future seam for364. `getProviderCredentials(provider,...,{principal})` must use SQL workspace filtering before selection, retry, refresh, pinned ID, custom node/catalog. Hash-mode missing principal is programming error, not global fallback. Free provider still model scope checked.

Existing preferences stay instance settings; all currently valid model/strategy features work. Partition existing rotation maps by principal workspace/provider/instance combo ID where needed to prevent selection state crossing; not wholesale368 state redesign. No new duplicate-name workspace CRUD acceptance demanded.

Async video supported multipart inspected non-destructively; explicit/declared provider default normalized; successful job response binds workspace/provider/jobId/connection/model durably. Poll/content/edit/extend use binding/current permissions, not attacker header alone. Old jobs: approved Q3 policy — unrestricted keys poll via authorized workspace connection; restricted keys need recorded or owner-confirmed model; all new jobs mapped durably; no global fallback. Native Gemini/model lists/voices/count tokens/internal probes all positive-functional; authorized in-process probe context replaces raw-key/owner CLI escalation.

### Usage and secret sinks

Immediate raw elimination uses existing history apiKey/daily meta slots as **versioned ID-only compatibility fields**, plus transient context apiKeyId/workspaceId/userId. New canonical370 schema not required. Known raw map preserves row IDs/counts/names; deleted-key history keyed pseudonym, no unkeyed weak-key hash. Every streaming/nonstream/SSE/error/fallback/late-before-enable callback normalizes before sink/event. Redact credential headers/query/cookies/proof at capture; never strip upstream provider credentials.

Current public consumers remain under existing management capabilities. Targeted newly reachable ownership filtering required, not full usage-product tenancy. Exact unique sentinel tests scan real sinks, not regex banning legitimate prefix. Known presets convert to IDs, unknown external D2 stop preserves; typed/new raw only in explicit immediate client-write/config render, never KV or response readback.

### Working current-schema instance transfer

FormatVersion2 separate from actual schemaVersion. Snapshot includes old exported configuration plus identities/workspaces/memberships/hash metadata/security marker and required minimal jobs; preserve existing usage exclusion policy explicitly. Provider credential fields remain current format; **365 encryption is not prerequisite for existing transfer parity**. Root/derived hash key/raw gateway bearer never export. Same-root proof domain-separated HMAC challenge; fingerprint alone not enough, proof not authenticity.

Preflight scratch DB validates format/versions/schema/ownership/FKs/master challenge before live wipe; legacy v1 raw keys accepted as input and hashed into Default. Same-root fresh destination restores existing clients. Existing user/root collision requires clear owner-confirmed supported replacement, no automatic master-file overwrite; wrong root fails preflight before any mutation (approved Q4). No workspace export/passphrase/general vault now.

Successful apply: quiesce concurrent mutation, required backup, one synchronous live transaction with FK/count checks, throw-on-failure flush, cache invalidation after commit. Do not file-swap beneath active adapter. Full DB route works both enabled and migrated-off; no blanket409. No new transfer UI required beyond current flow plus confirmation/error fields essential for safe overwrite.

### Local/remote MITM

Local: new internal token/hash every actual spawn, previous child stopped, old verifier invalidated, failed spawn compare-revokes only its hash; raw only call/child env; zero ordinary key rows. Direct local gateway scope, no owner/admin bearer. Strip client credential/CLI headers before forwarded env Authorization.

Remote: explicit destination credential from operator handoff or approved external runtime source. Bind to remote URL, no local internal token/root sent abroad; saved selector/endpoint only, no local recoverable raw storage or readback. Manual start works; approved Q2: operator-managed env/file/secret injected at parent startup and kept in parent memory for child restarts; local internal token fresh each spawn; no per-spawn remote issuance assumed. Remote URLs not blanket rejected; transport validation/security errors remain real conditions. Q2 profile required before claiming unattended parity.

### UX/CLI

Existing key routes keep permission map, explicit type=user/service and mode/capability metadata even empty. Member creates own user key only, manager service/list/manage, viewer no list. Hashed empty state explicit Create, POST raw transient reveal once, prefix/no row-copy afterward; notice server ack, legacy nudge, expiry/scopes. Migrated-off same functioning metadata UI. QuickConnect/current CLI setup use supplied/new secret, never prefix/first-key/brand default. Existing host config merge preserves on-disk secret without GET readback or asks deliberate replacement. New remote-member tool export remains374, not acceptance addition.

## 7. Positive/negative acceptance matrix

| ID  | Required positive                                                                                      | Required negative/failure                                                                 | Owner |
| --- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ----- |
| A1  | Existing keys/workflows off/on/off/on same DB continue, metadata CRUD/transfer on migrated-off         | No plaintext restoration/session status bypass/global candidates                          | A/B/V |
| A2  | Existing instance combos/aliases/models/settings work with each authorized workspace's own connections | No foreign credentials/nodes/pinned IDs; no Default-only denial                           | C     |
| A3  | Chat/messages/Responses/compact/Ollama/rewrites stream/nonstream/fusion/adapters/fallback work         | Every forbidden leaf/judge/adapter rejected before call                                   | C/D   |
| A4  | Catalog root/list/detail/info/Gemini/voices/count_tokens and internal probes succeed                   | No unauthorized upstream catalog fetch or probe owner escalation                          | C     |
| A5  | Embeddings/images/TTS/STT/search/fetch/native Gemini incl defaults/multipart                           | Key permissions, malformed input and peer boundary enforced                               | C     |
| A6  | Video generate/edit/extend/poll/content with durable new-job model/connection, supported old adoption  | Foreign job/header can't forge model/workspace scope                                      | C, Q3 |
| A7  | Local CLI parity all paths, keyless owner+Default when allowed                                         | Invalid bearer+cookie/CLI no fallback, forged/remote peer rejected                        | B     |
| A8  | Local zero-key MITM each spawn fresh; remote explicit manual/cold/crash per approved profile           | No old internal token after rotation/failure, no raw log/readback/local persisted handoff | F, Q2 |
| A9  | Existing instance same-root export/import roundtrip, legacy raw input restore                          | Bad root/format/FK/diff rollback before wipe; no root in export                           | G, Q4 |
| A10 | Usage counts/history/current views and streams retain existing behavior with key-ID names              | Sentinel absent from key rows/history/daily/meta/response/log/config/transfer             | D/E/G |
| A11 | Current Home/endpoint/QuickConnect/CLI host-tool setup functional with explicit create/supply          | No silent provisioning/secret discard/prefix-as-key/member privilege increase             | E     |
| A12 | Unambiguous migration automatic, D2 ambiguous stop recoverable                                         | Backup/master/rebuild/flush fail no false success; no silent external-data deletion       | A     |
| A13 | Manual pause resumes; tombstone history identity preserved; service survives churn                     | Disable/leave/rejoin never resurrect, warm cache live checks, no history cascade          | A/B   |

Do not demand full362/364/370/374/375 new feature acceptance under these rows. Do not pass A3–A9 by refusing all positive requests. Q1 (raw irrecoverable) is the sole recorded information limit; Q2–Q5 approved.

## 8. Approved decisions and information limit

- **Q1 acknowledged information limit:** raw full key display cannot return from hash after on-to-off. Prefix/new/supplied key exception stated; not re-opened decision.
- **Q2 approved:** operator-managed env/file/secret injected at parent startup; parent-memory handoff for child restart; local internal token fresh every spawn. No general remote feature refusal.
- **Q3 approved:** legacy unrestricted keys poll via authorized workspace connection; restricted keys require recorded or owner-confirmed model; every new job bound durably; no global fallback.
- **Q4 approved:** restore original master separately; mismatch fails preflight with no mutation; no automatic master replacement or cross-root rehash.
- **Q5 resolved:** no whole sibling issue prerequisite or implied Done; only bounded compatibility overlaps. Exact next-batch ownership lanes: storage — new `db/apiKeyState.js` + existing `schema.js`/`repos/apiKeysRepo.js`/`usersRepo.js`/`membershipsRepo.js` + `tests/unit/gateway-key-storage.test.js`; usage — new `db/helpers/usageKeyIdentity.js` + `tests/unit/gateway-key-usage-identity.test.js`; MITM — new `mitm/runtimeCredentials.js` + existing `handlers/base.js` + `tests/unit/mitm-runtime-credentials.test.js`; crypto — `security/masterKey.js` + `tests/unit/gateway-key-crypto.test.js` only. All `src/lib` unless explicit; tests under `tests/unit`. No migration activation/registration/barrel/startup/UI changes this batch.

First feasible action: none pending on questions. P0 crypto safety repair is in progress and unaccepted; next batch proceeds on the approved lane manifests above. No user answer needed to invent new preference/encryption/usage features because those are not required scope.

## 9. Verification gates

V owns isolated tests/evidence, stage/product writers fix their own files. All code gets independent code-reviewer and security review, parent PR review on fresh head/CI. No tests that touch real HOME, no real MITM/DNS/sudo/provider calls. Use tests/vitest.config.js exclusively or root npm test. Temporary HTTP fixture under /tmp/opencode, trusted custom-server peer path, existing rewrites, backup restore rehearsal.

```bash
npx vitest run -c tests/vitest.config.js tests/unit/gateway-key-crypto.test.js
TOKENHOP_MULTI_USER=off npm test
TOKENHOP_MULTI_USER=on npm test
npm run lint
npm run build
npm run lint:brand
```

Later focused tests explicitly allocated by V for auth/cache/lifecycle, same-data transition, all gateway positives, job restart/adoption, usage/preset sentinel, local/remote MITM and current-schema transfer. Red evidence actual assertion failures before code, not import-only all-red. No baseline edits to conceal regressions.

Browser gate E/V: light/dark ×1440/1024/390, RTL, keyboard/focus/copy, manager/member/viewer, pristine-off/enabled/migrated-off, notice, explicit creation/reveal, Home/setup and existing transfer/MITM profile. No new remote-member export page requirement. Network responses prove secrecy, screenshots not enough.

No package/version/changelog/release/translation changes. No implementation/commit/push/merge/tracker mutation by planning lane. Pure F0 foundation does not need browser run; final UI does.

## 10. Planning consistency and history

Research files retained with captured SHA-256 hashes. Existing evidence corrections kept: actual nodesRepo.js, no baseline history FK to keys, MITM forwards rather than compares, Buffer/base62 research sample invalid, conditional stamped hash migration unsafe. Previous all-neighbor sequence superseded; no hidden prerequisite on full encryption or full375 export.

Spec/plan agree on bounded bridges, functioning hashed-compat, scoped candidates using explicit current instance model configuration, positive current-schema transfer, remote handoff, D1–D3 approvals and Q1–Q5 classification. Unmodified installed spec validator has pipefail/grep-q and link-regex defects, reproduced in previous revision's direct run. Current revised spec passed same script with process-local stdin-draining/link-regex correction: **0 errors/0 warnings**,89-word summary,72 table rows,14 links. Internal links/Q1–Q5 consistency passed in both files. All seven research SHA-256 values unchanged. No validator file changed; no product tests/security approval claimed during synthesis.
