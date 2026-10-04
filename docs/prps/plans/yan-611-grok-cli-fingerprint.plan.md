# Plan: YAN-611 — Grok CLI 1.0.x fingerprint alignment

## Summary

Align Grok CLI Responses requests, device onboarding, and refresh with official 1.0.x behavior. Preserve existing model aliases, identity-dependent model discovery, quota handling, and credential persistence; make Grok 4.6 the default without relabeling Grok Build. Merge requires a real chat through an isolated development container running this branch, not mocked tests or a successful account probe alone.

## User Story

As a Grok subscription user, I want tokenhop to send the supported CLI protocol, so that chat, reasoning continuity, login, and token refresh work without fingerprint drift.

## Problem → Solution

YAN-610 fixed version gating only. YAN-611 completes the verified protocol subset: trusted proxy headers, Responses includes/cache identity, workspace scopes, shared auth headers, a separate Grok refresh path, model defaults, and actionable HTTP 426 errors. Unsupported compaction/recovery behavior remains absent, explicitly—not simulated with copied headers.

## Metadata

- **Complexity**: Large, narrow backend change across existing modules.
- **Source PRD**: N/A; Linear YAN-611 and GitHub tokenhop/tokenhop#757, parent-provided verified research.
- **PRD Phase**: Standalone follow-up to YAN-610 / PR #396.
- **Estimated Files**: 13 implementation/test/doc files, plus this plan; optional Grok-only baseline edit if required.
- **Target**: v1.1.0, PR into `master`; no backport, no release/version bump.
- **Base**: `0810f1f0`; branch `providers/yan-611-grok-cli-fingerprint` already exists.
- **Research**: Reuse parent's code map and librarian findings; targeted source checks only, no repeated research fanout.
- **Approval**: Parent owns implementation approval and merge gates. This planning lane may write only this plan.

## Batches

| Batch | Tasks         | Depends On | Parallel Width |
| ----- | ------------- | ---------- | -------------- |
| B1    | 1.1           | —          | 1              |
| B2    | 2.1, 2.2, 2.3 | B1         | 3              |
| B3    | 3.1           | B2         | 1              |
| B4    | 4.1           | B3         | 1              |
| B5    | 5.1           | B4         | 1              |

- **Total tasks**: 7
- **Total batches**: 5
- **Max parallel width**: 3
- Live prerequisites may be prepared independently, but live acceptance uses the final reviewed/tested commit.

## Worktree Setup

- **Parent**: `/home/yandy/Projects/github.com/tokenhop/tokenhop/.claude/worktrees/yan-611-grok-cli-fingerprint` (branch: `providers/yan-611-grok-cli-fingerprint`)

All agents share this existing worktree. Do not create child worktrees or move the plan back into the root checkout. Parallel ownership below is exclusive; integration fixes return to each file's owner or run sequentially after B2.

## UX Design

Internal change — no dashboard, component, locale, or CLI-config-editor changes. Existing callers keep explicit model choices. Only provider default selection changes to `grok-4.6`; an upstream 426 gains operator guidance naming `GROK_CLI_VERSION` and restart requirements.

## Mandatory Reading

| Priority | File                                               | Lines          | Why                                                          |
| -------- | -------------------------------------------------- | -------------- | ------------------------------------------------------------ |
| P0       | `CLAUDE.md`                                        | all            | Commands, isolated tests, SQLite boundary                    |
| P0       | `RELEASING.md`                                     | all            | master/v1.1.0; no backport                                   |
| P0       | `open-sse/AGENTS.md`                               | all            | Config-driven engine conventions                             |
| P0       | `docs/ARCHITECTURE.md`                             | 157-266        | Request dispatch and credential lifecycle                    |
| P0       | `docs/prps/plans/yan-610-grok-cli-version.plan.md` | all            | Scope deliberately deferred to this issue                    |
| P0       | `docs/prps/reviews/pr-396-review.md`               | all            | F006 separate refresh; F007 426 hint                         |
| P0       | `open-sse/config/grokCli.js`                       | all            | Version pin, Build constant, effort guard                    |
| P0       | `open-sse/executors/grok-cli.js`                   | 1-155, 355-579 | Existing identity helpers and transform/header ordering      |
| P0       | `open-sse/services/tokenRefresh/providers.js`      | 1-155          | Existing xAI return/error contract and generic-path mismatch |
| P0       | `open-sse/services/oauthCredentialManager.js`      | 49-164         | Merge, expiry, locks, rotation persistence shape             |
| P1       | `open-sse/providers/registry/grok-cli.js`          | all            | Model ordering, scopes, transport headers                    |
| P1       | `src/lib/oauth/providers/grok-cli.js`              | all            | Device/poll headers and stored identity                      |
| P1       | `open-sse/services/grokCliModels.js`               | all            | Build-only limit fallback and model identity headers         |
| P1       | `open-sse/utils/sessionManager.js`                 | 220-259        | Existing scoped bounded UUID continuation helper             |
| P1       | `open-sse/executors/base.js`                       | 69-175         | Headers built immediately after synchronous transform        |
| P1       | `tests/unit/grok-cli-executor.test.js`             | all            | Existing model/header/session/reasoning regressions          |

## External Documentation

Research checked 2026-10-03. Official source snapshot: `xai-org/grok-build` commit `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`; source is ahead of some released package versions, so live verification remains authoritative for acceptance.

| Topic                 | Source                                                                                                                                         | Key Takeaway                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trusted proxy auth    | <https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/proxy_headers.rs> | Known proxy only: `x-xai-token-auth: xai-grok-cli`, `x-authenticateresponse: authenticate-response`, process client mode                                  |
| Responses and policy  | <https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-sampler/src/client.rs>            | SSE Accept, encrypted continuity, deduplicated includes, optional group ID, genuine trace context, conditional recovery headers; summary none omits field |
| OAuth scopes          | <https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-login/src/config.rs>              | Existing eight scopes plus `workspaces:read workspaces:write`                                                                                             |
| Device/poll surface   | <https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-login/src/device_code.rs>         | `x-grok-client-version` and `x-grok-client-surface`; requested tokenhop headless policy applies to both                                                   |
| Model defaults        | <https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-models/default_models.json>       | Default 4.6, 500000 context, high effort, xhigh supported; 4.5 retained; no evidenced 4.6 output limit                                                    |
| Grok 4.7 availability | <https://x.ai/build/changelog>                                                                                                                 | Build 1.0.40, 2026-09-20: “Grok 4.7 has arrived!”; corroborates issue live catalog, not limits/capabilities                                               |
| Package versions      | <https://registry.npmjs.org/@xai-official/grok>                                                                                                | Observed stable 1.0.46, alpha 1.0.49; do not automatically change tokenhop's 1.0.44 pin                                                                   |

Official refresh source is less strict than onboarding; sharing the complete onboarding fingerprint on refresh is an explicit issue requirement, not a claim that every upstream version does so. `Accept: */*` follows the requested auth wire profile. No captured bearer tokens, cookie values, user IDs, or trace IDs belong in fixtures.

## Patterns to Mirror

| Category / trace             | Existing pattern                                                                                | Required use                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Organization / configuration | `config/grokCli.js`; registry owns scopes/model rows                                            | Plain JS named exports, camelCase helpers, no dependency additions                                |
| Entry points / contracts     | `GrokCliExecutor.transformRequest`, then `buildHeaders` synchronously in `BaseExecutor.execute` | Resolve identity before payload cleanup; do not add an async gap between body/header construction |
| State / cache                | Existing session/turn helpers; `resolveContinuationId` is bounded, scoped, TTL-managed          | Reuse stores, no new process-global map or DB fields                                              |
| Model defaults               | `getDefaultModel` returns first registry model                                                  | Put 4.6 first; retain Build as distinct model and existing aliases                                |
| Service / dependencies       | Models and usage own independent HTTP headers                                                   | Do not apply Responses header removals to discovery/usage                                         |
| Errors / logging             | Refresh returns camelCase tokens or `{ error: "invalid_grant" }` / null                         | Preserve classification and rotation; log category/status, not token response bodies              |
| Tests                        | Vitest mocks, `Response.json`, env reset in version suite                                       | Add checks to focused files; exactly one new refresh test file                                    |
| Persistence                  | `refreshProviderCredentials` merges expiry/ID token; caller persists result                     | No direct DB writes in executor/refresh helper; preserve callbacks                                |

```js
// open-sse/config/providerModels.js:25-27
export function getDefaultModel(aliasOrId) {
  const models = PROVIDER_MODELS[aliasOrId];
  return models?.[0]?.id || null;
}
```

```js
// open-sse/services/tokenRefresh/providers.js:21-24
accessToken: tokens.access_token,
refreshToken: tokens.refresh_token || refreshToken,
expiresIn: tokens.expires_in,
idToken: tokens.id_token,
```

```js
// open-sse/services/grokCliModels.js:98-101
try {
  await onCredentialsRefreshed?.(refreshed);
} catch (error) {
  log?.warn?.("Grok CLI credential persistence failed", error);
}
```

### Architecture: Design Decisions

1. **Separate model identity from default.** Keep `GROK_CLI_MODEL = "grok-build"` unchanged: its consumers attach Build-only 500000/64000 fallback limits. Add `GROK_CLI_DEFAULT_MODEL = "grok-4.6"`, use it in the first registry row and executor's missing-model fallback. Preserve explicit `grok-build`, provider aliases `gcli`, `gb`, `grok-build`, 4.5 rows, and suffix precedence. Give 4.6 context 500000 only; list 4.7 with ID/name only. Extend the existing reasoning guard to known 4.5/4.6 families; 4.7 remains selectable with concise summary but no asserted effort support until verified metadata reaches dispatch. No invented 4.7 limits or effort variants; no need to add 4.6 virtual rows because existing suffix parsing accepts low/medium/high/xhigh.
2. **One auth profile, not one universal profile.** Export `GROK_CLI_AUTH_HEADERS` from existing config: form Content-Type, `Accept: */*`, existing UA, configured version, `x-grok-client-surface: headless`. Device-code, token poll, and dedicated refresh share it. Do not spread form auth headers into JSON Responses/models/usage calls. Registry's scope string gains workspace read/write; client ID, endpoints, and referrer stay unchanged. Update stale comments that say refresh has no fingerprint or stored identity exists for Responses.
3. **Endpoint-specific Responses fingerprint.** Keep registry's common version/identifier/UA headers unchanged. `BaseExecutor.execute` already passes the attempt URL as `buildHeaders(credentials, stream, url, model, body)`; accept that argument and compare `new URL(url).origin` to `new URL(GROK_CLI_BASE_URL).origin` (invalid URL means untrusted). In `GrokCliExecutor.buildHeaders`, emit token auth, `x-authenticateresponse`, and `x-grok-client-mode: headless` only for the built-in trusted proxy origin `https://cli-chat-proxy.grok.com`; do not use hostname suffix matching or raw inbound header forwarding. Remove `x-email`/`x-userid` from Responses construction only. Preserve Authorization, SSE Accept, model override, session, conversation, request, turn, and agent IDs. Models and usage retain their existing identity headers; `postExchange` retains user identity storage.
4. **Honest conversation and tracing semantics.** Derive optional `x-grok-conv-group-id` using existing `resolveContinuationId({ sessionId, connectionId, scope: "grok-cli" })` after session resolution: one UUID per scoped root conversation, no invented subagent hierarchy. Generate a fresh W3C `traceparent` per outbound attempt using `crypto.randomBytes(16)` and `crypto.randomBytes(8)` with version `00` and flags `00` (unsampled); never replay a captured/client trace. IDs must be nonzero; generation can use nonzero UUID hex for trace ID and retry an all-zero span if necessary. Do not add tracing libraries, exporters, or propagate arbitrary `tracestate`.
5. **Cache identity resolves before fallback insertion.** Keep a valid explicit `prompt_cache_key` (nonempty string, trim for validation, at most 256 chars, no control characters) verbatim. Remove malformed keys before invoking the existing resolver; otherwise they could influence identity despite being rejected on the wire. Resolve the existing conversation/session once, then insert that resolved value only if no valid key exists. Never generate a second cache-only UUID. Existing header/session precedence and account/workspace fallback remain; payload cleanup must not strip the key. Preserve the existing documented ceiling: callers without stable thread metadata share connection session; this issue does not invent thread inference.
6. **Body defaults preserve explicit intent.** Default 4.6 to high effort and concise summary, retain effort precedence (`reasoning.effort`, `reasoning_effort`, suffix, high), max-to-xhigh normalization, and Build/unknown effort omission. `reasoning.summary: "none"` means delete summary, not send `none` or reinstate concise. Always merge/deduplicate `reasoning.encrypted_content`; add `no_inline_citations` only in this trusted Grok Responses path (including its hosted backend-search tools), never common translators or third-party-compatible providers. Preserve other valid include strings and existing normalization/allowlist behavior. Keep normalization idempotent across retries: retain original body as `requestKey`, but use local shallow body/reasoning/include copies where deleting summary or inserting cache fallback would otherwise mutate explicit caller intent; do not add another identity store. The endpoint trust check also gates `no_inline_citations` if a test supplies a nonproxy config URL.
7. **Dedicated refresh preserves lifecycle.** Add `refreshGrokCliToken(refreshToken, log, proxyOptions = null)` beside `refreshXaiToken` in `tokenRefresh/providers.js`; use registry OAuth token URL/client ID, `URLSearchParams`, shared auth headers, and `proxyAwareFetch`. Wrap it in `dedupRefresh("grok-cli", oldToken, ...)`; both grok-cli/gcli routing entries use it, while xai remains unchanged. Preserve rotated refresh-token fallback, `expiresIn`, `idToken`, null for transient/malformed successes, and permanent invalid_grant/invalid_request classification. Guard missing access token; do not report successful refresh with an undefined bearer. Keep outer credential lock, expiry merge, persistence callbacks, and selected proxy untouched. No generic refresh-profile substitution: it does not preserve this full return/error contract. Provider-specific dedup intentionally does not coalesce xai with Grok: they have distinct fingerprints; copying one refresh token across provider types is unsupported.
8. **426 is diagnostic, not new retry policy.** In executor `parseError`, keep status 426, preserve short normal upstream message/code when safely extracted, append a stable hint to set `GROK_CLI_VERSION` to a supported official version and restart tokenhop (including compose pin when applicable). Parse defensively across plain text, `{message}`, `{error: string}`, `{error: {message, code}}`, malformed JSON, and empty bodies. Bound detail, strip control characters, redact recognizable bearer/token values and token fields; never echo whole nested objects or HTML. Use generic HTTP 426 detail when no safe message exists. Keep 402 spending-limit behavior and other statuses unchanged.
9. **Do not claim unsupported upstream policies.** Omit compaction headers: tokenhop has no official uncompacted-prefix/remaining-count/threshold state. Omit doom-loop/repetition headers: 1024/64 only apply with a recovery policy tokenhop does not implement. Add a short `ponytail:` comment naming that ceiling and future upgrade path. These omissions are deliberate acceptance criteria, not unchecked TODOs.

### Data Flow

Existing gateway translates requests, then Grok executor resolves conversation identity and normalized model/body. Body and headers are built synchronously from that attempt; native fetch/proxy path sends to the configured built-in proxy. Models/usage remain separate clients. Device onboarding and token refresh import one config auth profile; refresh results pass through existing locks, credential merging, and caller-owned persistence. No new abstraction layer, DB schema, UI, or common translator behavior.

## Files to Change

| File                                          | Action | Justification / owner                                                                    |
| --------------------------------------------- | ------ | ---------------------------------------------------------------------------------------- |
| `open-sse/config/grokCli.js`                  | UPDATE | Shared auth headers/default constant/known effort guard; B1 config owner                 |
| `open-sse/providers/registry/grok-cli.js`     | UPDATE | Default/catalog ordering and workspace scopes; B1 config owner                           |
| `open-sse/executors/grok-cli.js`              | UPDATE | Trusted fingerprint, cache/includes/defaults/426; B2 executor owner                      |
| `tests/unit/grok-cli-executor.test.js`        | UPDATE | Executor, defaults, alias, request-local regression checks; B2 executor owner            |
| `src/lib/oauth/providers/grok-cli.js`         | UPDATE | Shared onboarding headers; retain identity storage; B2 auth owner                        |
| `open-sse/services/tokenRefresh/providers.js` | UPDATE | Dedicated compatible Grok refresh; B2 auth owner                                         |
| `open-sse/services/tokenRefresh.js`           | UPDATE | Route grok-cli/gcli separately from xai; B2 auth owner                                   |
| `tests/unit/grok-cli-version.test.js`         | UPDATE | Auth surface/Accept/scopes, poll, env override; B2 auth owner                            |
| `tests/unit/grok-cli-refresh.test.js`         | CREATE | Refresh request, dedup, errors, proxy and merge contract; B2 auth owner                  |
| `tests/unit/grok-cli-expiresat-2546.test.js`  | UPDATE | Preserve onboarding expiry and identity contract; B2 auth owner                          |
| `tests/unit/grok-cli-models.test.js`          | UPDATE | Keep discovery identity, Build limit fallback, new catalog metadata; B2 regression owner |
| `tests/unit/grok-cli-usage.test.js`           | UPDATE | Retain usage fingerprint and parsing; B2 regression owner                                |
| `README.md`                                   | UPDATE | Short Grok compatibility/426/version notes, no UX expansion; B2 regression owner         |
| `tests/__baseline__/providers-baseline.json`  | UPDATE | Conditional only: exact Grok transport delta if verifier requires it; B3 integrator      |

Existing `open-sse/services/grokCliModels.js`, usage implementation, `src/lib/grokBuildConfig.js`, common session utilities, and xAI service should need no source edits. Config/model rows feed existing registry builders; do not hand-edit generated registry index. If a demonstrated dependency requires touching another source file, stop that implementation lane and obtain parent scope approval first.

## NOT Building

- UI/locale edits, new dependencies, generic header framework, migrations, global tracing, policy recovery/compaction, or new tools.
- RELEASING/CHANGELOG changes, package/version bumps, compose pin churn, release tags, or backports.
- Renaming `grok-build`, migrating saved user choices, rewriting Grok Build CLI TOML configuration, or inferring 4.7 capacity/effort.
- Changing generic xAI refresh/onboarding, third-party Responses payloads, or all providers' error parsing.
- Exporting shared runtime DB, borrowing/rotating its refresh token, or treating mock/local tests as live acceptance.

## Step-by-Step Tasks

### Task 1.1: Establish shared protocol constants and model contract — Depends on none

- **BATCH**: B1
- **ACTION**: Config owner edits only `open-sse/config/grokCli.js` and `open-sse/providers/registry/grok-cli.js`.
- **IMPLEMENT**: Add shared form-auth headers and separate default model, extend known effort support through 4.6, and put 4.6 first with 4.7 listed conservatively. Retain Build identity/limits and all 4.5 rows, append workspace scopes, and fix stale scope/fingerprint comments without broad header additions to registry.
- **MIRROR**: Config/constants and first-model default patterns above.
- **IMPORTS**: Existing config imports; add `GROK_CLI_DEFAULT_MODEL` to registry.
- **GOTCHA**: Never change `GROK_CLI_MODEL` to 4.6; models parser uses it to inject Build-only output limits. Keep default version 1.0.44.
- **VALIDATE**: Run config assertion command below; inspect diff for only two files, no blanket baseline regeneration. Hand off exact export names to B2 owners.

### Task 2.1: Align trusted Responses requests and 426 handling — Depends on 1.1

- **BATCH**: B2
- **ACTION**: Executor owner edits `open-sse/executors/grok-cli.js` and `tests/unit/grok-cli-executor.test.js` only.
- **IMPLEMENT**: Apply decisions 3–6 and 8–9 with existing synchronous transform/header lifecycle, scoped continuation helper, native crypto, and existing allowlist. Add precise regressions for defaults, identity/includes, policy omissions, request isolation/retries, and defensive 426 parsing; preserve explicit model and 402 behavior.
- **MIRROR**: Existing normalization functions, turn/request stores, executor-only error override, test `beforeEach` reset.
- **IMPORTS**: `GROK_CLI_BASE_URL`, `GROK_CLI_DEFAULT_MODEL`, shared protocol constants if defined; `resolveContinuationId` beside existing session import; existing crypto.
- **GOTCHA**: Request/session/turn IDs must not bleed between parallel requests on shared singleton. Headers must not forward attacker-provided raw auth/fingerprint/trace headers; `no_inline_citations` must not leak to a nonproxy URL. Summary none still permits encrypted continuity.
- **VALIDATE**: `npx vitest run -c tests/vitest.config.js tests/unit/grok-cli-executor.test.js`; inspect captured outbound requests, not just helper fields.

### Task 2.2: Share auth headers and split Grok refresh — Depends on 1.1

- **BATCH**: B2
- **ACTION**: Auth owner edits the three auth/refresh source files and three auth tests assigned in Files to Change.
- **IMPLEMENT**: Replace local onboarding `AUTH_HEADERS` with shared config export, retain pending/slow_down and identity mapping, and implement dedicated Grok refresh using dedup plus proxy-aware fetch. Route grok-cli/gcli to it and test version override on device/poll/refresh, canonical dedup, permanent/transient failures, rotation, expiry and ID-token merge without changing generic xai.
- **MIRROR**: `refreshXaiToken` return contract, `dedupRefresh`, `mergeRefreshedCredentials`; do not clone XaiService/discovery into a new service class.
- **IMPORTS**: `GROK_CLI_AUTH_HEADERS`; existing `PROVIDER_OAUTH`, `dedupRefresh`, and `proxyAwareFetch`; new `refreshGrokCliToken` import in dispatcher.
- **GOTCHA**: Failure logs must not dump tokens or response objects. On success absent refresh token retains previous token; invalid_request remains classified as invalid_grant for compatibility. Missing/invalid access token is not successful refresh.
- **VALIDATE**: `npx vitest run -c tests/vitest.config.js tests/unit/grok-cli-version.test.js tests/unit/grok-cli-refresh.test.js tests/unit/grok-cli-expiresat-2546.test.js tests/unit/grok-cli-oauth-probe.test.js`.

### Task 2.3: Protect models/usage compatibility and document scope — Depends on 1.1

- **BATCH**: B2
- **ACTION**: Regression owner edits `tests/unit/grok-cli-models.test.js`, `tests/unit/grok-cli-usage.test.js`, and Grok subsection of `README.md` only.
- **IMPLEMENT**: Assert discovery still emits x-email/x-userid and preserves live metadata with fallback limits only for Build, while usage keeps its existing headers and quota behavior. Document separate default vs Build, 4.7 metadata restraint, 426 env/restart action, and intentional policy-header omissions briefly.
- **MIRROR**: Existing mocked fetch response/selected-proxy tests and README version-pin convention.
- **IMPORTS**: Existing test helpers/config constants; no production dependency changes.
- **GOTCHA**: Do not spread Responses profile into models or usage, and do not replace existing live metadata with static fabricated limits. Keep `grok-build-config` restoration behavior unchanged.
- **VALIDATE**: `npx vitest run -c tests/vitest.config.js tests/unit/grok-cli-models.test.js tests/unit/grok-cli-usage.test.js tests/unit/grok-cli-quota-frame.test.js tests/unit/grok-build-config.test.js`.

### Task 3.1: Integrate, review, and verify local gates — Depends on 2.1, 2.2, 2.3

- **BATCH**: B3
- **ACTION**: Parent integrates completed ownership lanes, requests code-reviewer review, and runs validation budget below.
- **IMPLEMENT**: Resolve cross-file mismatches sequentially, rerun focused tests, then lint/baselines/full regression/build; repair only regressions from this branch. Update provider baseline only if a necessary Grok transport delta exists, with all other JSON entries byte-for-byte unchanged; source decisions avoid such a change by default.
- **MIRROR**: PR #396 review gates and known-fails baseline workflow; F006/F007 close here, F008 remains separate.
- **GOTCHA**: Review findings are not waived because live probing works. Do not update known-fails or OAuth/alias snapshots to hide regressions.
- **VALIDATE**: Review has no unresolved blocking findings; all local commands below pass against final diff. Revalidate changed areas after fixes, and rerun full gates if integration affects runtime behavior.

### Task 4.1: Live acceptance in isolated development container — Depends on 3.1

- **BATCH**: B4
- **ACTION**: Parent/live lane uses isolated container for this worktree, isolated DATA_DIR, isolated fresh credentials, separate port and build/dependency volumes.
- **IMPLEMENT**: Complete fresh device consent, verify catalog and quota endpoints, execute real 4.6 chat plus same-conversation continuation and explicit Build/4.5 compatibility checks, and exercise dedicated refresh only on this disposable connection. Record sanitized status/model/commit evidence and request-shape assertions, not secrets or full private prompts.
- **MIRROR**: PR #396's actual Responses chat evidence, strengthened by isolation and complete fingerprint checks.
- **GOTCHA**: Existing `tokenhop-dev` mounts root checkout/shared data; neither it nor plain compose with fixed names qualifies. Never copy its DB or rotate a shared refresh token. A 200 models/user probe, mock chat, 402, skipped live test, or expired auth is not acceptance.
- **VALIDATE**: Real `/v1/responses` or `/v1/chat/completions` request through `GrokCliExecutor` returns 200 and nonempty model output; continuation succeeds, no 426/400. Dedicated isolated refresh yields usable updated credentials and another successful chat. Missing isolated credentials/consent/credit/container access blocks merge.

### Task 5.1: PR, CI, merge, cleanup and tracker closure — Depends on 4.1

- **BATCH**: B5
- **ACTION**: Parent owns authorized git/tracker workflow after implementation, review, local gates, and live gate are complete.
- **IMPLEMENT**: Commit conventional scoped changes, open PR into master with `Closes YAN-611` and `Closes #757`, include source assumptions and redacted live evidence, and wait for required CI green before squash merge. Clean up only task-owned container/volumes/worktree/branch after confirming merge and no unique work; close tracker with merge/live links and v1.1.0 target, no backport.
- **MIRROR**: Repository release model and previous reviewed PR's validation evidence.
- **GOTCHA**: No release/tag/CHANGELOG/RELEASING modifications. No auto-merge bypass for blocked live credentials, failed CI, or unresolved reviews.
- **VALIDATE**: PR merged by squash into master, CI successful on merged candidate, issues closed, task-owned cleanup confirmed without touching shared runtime data.

## Testing Strategy

### Unit Tests

| Test                     | Input                                                             | Expected Output                                                                   | Edge Case? |
| ------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------- |
| Default model            | no model / `gcli` provider default                                | `grok-4.6`, high effort, concise summary                                          | No         |
| Legacy selection         | `grok-build`, `grok-4.5-medium`, aliases                          | Exact existing upstream IDs/effort rules; Build no effort                         | Yes        |
| Catalog                  | registry/live parser                                              | 4.6 first, 4.7 listed, Build fallback limits only for Build                       | Yes        |
| 4.7 conservative         | `grok-4.7-high` or 4.7 explicit effort                            | Upstream 4.7, concise; effort omitted pending verified metadata                   | Yes        |
| Responses fingerprint    | trusted proxy URL plus email/user metadata                        | token auth, authenticate-response, headless; no email/user headers                | No         |
| Untrusted endpoint       | test config URL outside exact trusted origin                      | no proxy auth/client-mode or no_inline_citations                                  | Yes        |
| Trace/group IDs          | two same-conversation requests                                    | valid fresh nonzero traceparent; stable bounded group UUID per conversation       | Yes        |
| Prompt cache             | valid key; missing key; malformed key                             | valid preserved; missing gets resolved identity; malformed excluded from identity | Yes        |
| Includes and summary     | duplicates, existing include, summary none                        | encrypted plus citation exactly once; summary omitted, continuity retained        | Yes        |
| Retry/concurrency        | repeated transform and interleaved requests                       | stable retry request key/turn, no header bleed                                    | Yes        |
| Policy omission          | any request                                                       | no compaction, doom-loop, or repetition headers                                   | No         |
| HTTP 426                 | text, string/object JSON, malformed, empty, token-shaped content  | status 426; bounded safe detail; GROK_CLI_VERSION/restart hint                    | Yes        |
| Onboarding               | device and poll with env override                                 | shared Accept/surface/version/UA headers and workspace scopes                     | No         |
| Refresh success/rotation | mocked token URL with/without rotated token                       | camelCase result; old token retained when absent; ID/expiry merge                 | Yes        |
| Refresh dedup/proxy      | concurrent same token with proxy options                          | one fetch, proxy passed, routing grok-cli/gcli                                    | Yes        |
| Refresh failures         | invalid_grant, invalid_request, 5xx, invalid JSON, missing access | permanent classification for first two; null/no secret logging otherwise          | Yes        |
| Models/usage             | identity metadata and existing payloads                           | existing x-email/x-userid and quota behavior preserved                            | No         |

### Edge Cases Checklist

- [x] Empty input — absent model/include/reasoning/prompt key/426 body.
- [x] Maximum size input — prompt key over 256 characters and long 426 message.
- [x] Invalid types — non-string prompt key/include entries/error JSON.
- [x] Concurrent access — singleton executor and duplicate refresh requests.
- [x] Network failure — refresh fetch throw/5xx and malformed success response.
- [x] Permission denied — 401/403 compatibility, invalid grant, 426 version gate.

## Validation Commands

Run from the shared worktree. Use Node 22 and never run Vitest with another config.

```bash
cd /home/yandy/Projects/github.com/tokenhop/tokenhop/.claude/worktrees/yan-611-grok-cli-fingerprint
export PATH="$HOME/.local/share/mise/installs/node/22.23.2/bin:$PATH"
node --version
```

### Static Analysis

```bash
npm run lint
git diff --check
```

EXPECT: Zero lint or whitespace errors. Plain JS has no type-check step.

### Unit Tests

```bash
node --input-type=module -e "import { PROVIDER_MODELS, PROVIDER_OAUTH } from './open-sse/providers/index.js'; import { getDefaultModel } from './open-sse/config/providerModels.js'; if (getDefaultModel('gcli') !== 'grok-4.6') throw new Error('default'); for (const id of ['grok-build','grok-4.5','grok-4.7']) if (!PROVIDER_MODELS.gcli.some((m) => m.id === id)) throw new Error(id); for (const s of ['workspaces:read','workspaces:write']) if (!PROVIDER_OAUTH['grok-cli'].scope.includes(s)) throw new Error(s);"
npx vitest run -c tests/vitest.config.js tests/unit/grok-cli-executor.test.js tests/unit/grok-cli-version.test.js tests/unit/grok-cli-refresh.test.js tests/unit/grok-cli-expiresat-2546.test.js tests/unit/grok-cli-oauth-probe.test.js tests/unit/grok-cli-models.test.js tests/unit/grok-cli-usage.test.js tests/unit/grok-cli-quota-frame.test.js tests/unit/grok-build-config.test.js
```

EXPECT: Config assertion succeeds and all focused Grok/compatibility tests pass.

### Full Test Suite

```bash
node tests/__baseline__/verify-providers.mjs
node tests/__baseline__/verify-oauth-urls.mjs
node tests/__baseline__/verify-alias.mjs
npm test
npm run build
```

EXPECT: No unexpected provider/OAuth/alias baseline diff, known-fails regression gate green, production build succeeds. Budget: one full run after integrated review; rerun focused tests for each fix and full gates again only when fixes affect runtime/shared behavior or before final PR if prior full run is stale.

### Database Validation (if applicable)

No schema change. Live gate must create disposable isolated SQLite data, not open, copy, export, or rotate credentials from root/shared `tokenhop-dev` data.

### Browser Validation (if applicable)

Not required: no UI changes. Live API/OAuth gate below is mandatory.

### Manual Validation

- [ ] Isolated runtime: unique container/project name, unique port, this worktree mounted, separate DATA_DIR and dependency/build volumes.
- [ ] Shared container safety: confirm no mount of root checkout/shared data; no copied DB; no shared refresh token rotated.
- [ ] Fresh OAuth: device-code and token-poll succeed with expected scopes/headers; credentials stored only in isolated data.
- [ ] Discovery: catalog shows 4.6 and Build/4.5; 4.7 visibility follows upstream entitlement; quota call works or produces genuine soft billing state.
- [ ] Chat: real 4.6 request through `GrokCliExecutor` returns HTTP 200 and nonempty output with no 426/400.
- [ ] Continuation: same conversation succeeds and request evidence shows stable cache/session/group identity with encrypted continuity include.
- [ ] Legacy: explicit Build and 4.5 requests remain accepted (or report a genuine entitlement condition with no fingerprint error).
- [ ] Refresh: force dedicated refresh on isolated credential; updated credentials persist, then another real chat succeeds.
- [ ] Evidence: commit SHA and sanitized request/response metadata recorded; no secrets, IDs, private prompts, or full response bodies.

## Acceptance Criteria

- [ ] Trusted Responses requests match the verified official proxy subset; no email/user headers on Responses.
- [ ] Discovery and usage keep identity/proxy behavior; Build parser limit fallback remains Build-only.
- [ ] Device/poll and dedicated refresh share version, UA, form content type, `Accept: */*`, and headless surface; workspace scopes are requested.
- [ ] Encrypted continuity and `no_inline_citations` are present once only on the trusted Grok Responses path.
- [ ] Prompt cache identity is valid, explicit-first, conversation-stable, and safely bounded.
- [ ] 4.6 is default with high/concise; 4.7 listed conservatively; Build/4.5 and aliases keep working.
- [ ] Refresh preserves dedup, selected proxy, error classification, rotation, expiry/id-token merge, and persistence.
- [ ] HTTP 426 remains 426 and gives safe actionable GROK_CLI_VERSION/restart guidance.
- [ ] No UI/locale, dependency, RELEASING/CHANGELOG, version, migration, or unrelated provider change.
- [ ] Focused tests, lint, baselines, full regression gate, build, review, isolated live chat/refresh, CI, squash merge, cleanup, and tracker closure all completed.

## Completion Checklist

- [ ] Code follows existing config/executor/refresh/test patterns.
- [ ] Error handling preserves status/classification and secret-safe logging.
- [ ] Shared state is bounded and request isolation is tested.
- [ ] Tests follow isolated Vitest config.
- [ ] No hardcoded Grok values outside config/registry except clearly scoped protocol literals mandated by official source.
- [ ] README concise; no changelog/release docs.
- [ ] No speculative compaction, recovery, subagent tree, or 4.7 limits.
- [ ] Plan remains enough for implementors without another research pass.

## Risks

| Risk                                                     | Likelihood | Impact   | Mitigation                                                                                   |
| -------------------------------------------------------- | ---------- | -------- | -------------------------------------------------------------------------------------------- |
| Upstream rejects new header/include combination          | Medium     | High     | Live gate before merge; adjust only verified fields, retain 426 diagnostic                   |
| Account lacks 4.6/4.7 entitlement or credits             | Medium     | Medium   | Separate entitlement from fingerprint failures; live acceptance requires successful 4.6 chat |
| Prompt key or session collisions mix users               | Low        | High     | Explicit key validation, existing account/workspace/connection scoping, concurrency tests    |
| Grok and xAI refresh duplicate in flight                 | Low        | Low      | Provider-specific dedup by design; outer per-connection lock remains authoritative           |
| Refresh compatibility regresses persisted token rotation | Low        | High     | Contract tests, live forced refresh, follow-up chat                                          |
| Trusted headers leak to untrusted endpoint               | Low        | High     | Exact built-in origin check plus negative test                                               |
| Baseline drift hides unrelated changes                   | Medium     | Medium   | Do not regenerate snapshots; only exact Grok-only delta if needed                            |
| Live container touches shared data                       | Low        | Critical | Isolated project/volumes/data/credentials; stop if isolation is not proven                   |

## Notes

- Source refs and assumptions are in External Documentation. Version pin remains 1.0.44 unless live evidence proves a newer pin is required; operators can still override GROK_CLI_VERSION.
- “Workspace scopes” means only `workspaces:read workspaces:write`, appended to existing scopes; team-specific auth is out of scope.
- `x-grok-client-mode` and auth `x-grok-client-surface` are both `headless` because tokenhop is a noninteractive gateway; neither is used as authentication or authorization.
- Group ID is per resolved root conversation only. True subagent grouping can be added when callers carry durable parent/child metadata.
- Compaction and doom-loop headers stay absent until tokenhop implements their official server-assisted state and recovery semantics.
- Unresolved blocker: final acceptance depends on isolated, consented Grok credentials with enough credits and a live container; parent-owned live prerequisite lane must supply it.
- Decision for parent approval: 4.7 effort and capacity remain unasserted until official metadata or live upstream metadata is verified.

## Implementation Validation Record

- Independent code reviews approved; no unresolved blocking findings reported.
- Focused executor/refresh tests: 47 passed (executor 36, refresh 11); final lint exited 0 after formatting-only changes.
- Full suite: 5,186 passed, 0 failed, 63 pending. Production build passed. Provider baseline (82 entries), OAuth baseline, and alias baseline (118 entries) remained exact.
- Isolated `yan-611-dev` runtime on port `20131` used this worktree and isolated data. Fresh onboarding included workspace scopes. `/v1/chat/completions` Grok 4.6 chat and same-cache continuation returned 200 with output; explicit Build and 4.5 requests returned 200; model catalog included 4.7; quota endpoint returned 200 with genuine state.
- In-container direct refresh through `refreshTokenByProvider` → `refreshGrokCliToken` → `mergeRefreshedCredentials` rotated and persisted credentials in isolated SQLite; follow-up 4.6 chat returned 200. Dashboard force-refresh route was not exercised end-to-end; refresh validation is direct service-path evidence, not route evidence.
- Invalid-token probe returned 400/null; not an acceptance criterion. No credential, identity, or private payload evidence recorded. Isolated API key was deleted; runtime cleanup is handled separately.
- Validation logs: `/tmp/opencode/yan-611-validation`.
- PR, CI, merge, cleanup, and tracker-closure gates remain parent-owned and unchecked.
