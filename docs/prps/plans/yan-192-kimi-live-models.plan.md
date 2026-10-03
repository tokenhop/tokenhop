# Plan: YAN-192 — Kimi Coding live models

## Summary

Add account-scoped Kimi Coding model discovery through existing shared live-catalog plumbing. Dashboard Fetch Models and public `/v1/models` use authenticated `GET https://api.kimi.com/coding/v1/models`; failures keep static models and show dashboard warnings without changing public response schema.

Planning artifact only. Parent approves plan, then delegates implementation; no application edits, commits, pushes, or release changes during planning.

## User Story

As a Kimi connection owner, I want available Coding models and upstream metadata discovered automatically, so dashboard choices and client catalogs reflect my account instead of stale static entries.

## Problem → Solution

Current Kimi registry supplies static models and lacks live-catalog registration. Add one Kimi resolver, register it, enable registry capability, and reuse existing dashboard/public consumers, cache, refresh persistence, and proxy-aware transport.

## Metadata

- **Complexity**: Medium
- **Source PRD**: N/A — YAN-192 / GitHub #754 and parent research brief
- **PRD Phase**: Standalone
- **Estimated Files**: 7 backend/test files; 3 designer-owned UI files; this plan
- **Target release**: v1.1.0
- **Base**: `master` at `bf80e10a`
- **Branch**: `feat/yan-192-kimi-live-models`
- **Backport**: None
- **Approval gate**: Parent approves before application changes; designer owns UI decisions and edits
- **Plan validation owner**: PRP planning subagent
- **Implementation validation owner**: Backend implementer for resolver/security/tests; designer for UI; parent for integration, browser E2E, full suite/build, and final acceptance

## Worktree Setup

- **Parent**: `/home/yandy/Projects/github.com/tokenhop/tokenhop/.claude/worktrees/tokenhop-yan-192` (branch: `feat/yan-192-kimi-live-models`)

Existing worktree is mandatory. Do not create another, write into main checkout, rebase, or commit. Paths below are relative to Parent.

## Batches

| Batch | Tasks    | Depends On | Parallel Width |
| ----- | -------- | ---------- | -------------- |
| B1    | 1.1, 1.2 | none       | 2              |
| B2    | 2.1, 2.2 | B1         | 2              |
| B3    | 3.1      | B2         | 1              |
| B4    | 4.1      | B3         | 1              |

- **Total tasks**: 6
- **Total batches**: 4
- **Max parallel width**: 2

## UX Design

### Before

Kimi provider page shows curated static rows. Generic live Fetch Models flow is unavailable. Static capability heuristics can differ from account catalog.

### After

Existing provider page loads live models for first active connection. Existing Fetch Models action forces refresh; new IDs show upstream names, matching static IDs retain curated names, and rows show live context and declared capability metadata. Video input gains existing-style input badge, never video-generation classification. Failure leaves usable static list plus amber fallback Callout; no custom Kimi screen.

### Interaction Changes

| Touchpoint            | Before                         | After                                            | Notes                                                                                 |
| --------------------- | ------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Kimi provider models  | Static only                    | Live membership with static fallback             | `features.liveModels` activates generic flow                                          |
| Fetch Models          | Kimi unsupported               | Existing loading/refresh/import interaction      | No polling or new control                                                             |
| Matching static ID    | Curated fields overwrite live  | Keep curated-name merge behavior                 | Upstream name still present in dashboard API; no merge helper edit                    |
| Row capability badges | `getCaps(providerId, id)` only | Per-key live capabilities override fallback caps | `{ ...getCaps(key), ...model.capabilities }` preserves false and unknown-key fallback |
| Video input           | No capacity badge              | `CAPACITY_META.videoInput` badge                 | Existing input capability; not generation                                             |
| Discovery failure     | No account catalog             | Static rows and amber fallback Callout           | `liveFallback` passed from ProviderDetailPage; public API remains OpenAI list         |

Parent supplied designer decision: task 2.2 applies per-key capability override, video-input badge, and explicit static-fallback Callout. Designer owns exactly three UI files; backend owns test expectation. Existing curated-name merge remains unchanged.

## Mandatory Reading

| Priority | File                                                                   | Lines                 | Why                                                    |
| -------- | ---------------------------------------------------------------------- | --------------------- | ------------------------------------------------------ |
| P0       | `CLAUDE.md`                                                            | all                   | JavaScript, DB, safety, test commands                  |
| P0       | `RELEASING.md`                                                         | all                   | Master base, v1.1.0, no backport                       |
| P0       | `open-sse/AGENTS.md`                                                   | all                   | Registry/engine conventions                            |
| P0       | `docs/ARCHITECTURE.md`                                                 | all                   | Request, OAuth, persistence boundaries                 |
| P0       | `src/lib/providerModels/xaiModels.js`                                  | 50-110                | Dual-auth branch, API-key precedence                   |
| P0       | `src/lib/providerModels/oauthResolver.js`                              | all                   | One 401/403 refresh, persist rotation, retry           |
| P0       | `src/lib/providerModels/liveResolvers.js`                              | 249-419               | Proxy precedent, registration, TTL/cache               |
| P0       | `open-sse/providers/registry/kimi.js`                                  | all                   | Identity, endpoints, auth, features                    |
| P0       | `open-sse/config/appConstants.js`                                      | 243-269               | Exact executor header builder                          |
| P0       | `open-sse/executors/default.js`                                        | 55-75,500-531         | Kimi header hook and proxy-aware refresh               |
| P0       | `open-sse/services/tokenRefresh.js`                                    | 149-226               | Engine refresh dispatcher accepts proxy options        |
| P0       | `open-sse/services/tokenRefresh/providers.js`                          | 95-175                | Refresh transport, dedup, optional logger              |
| P0       | `src/lib/network/connectionProxy.js`                                   | 54-170                | Pool/relay/strict proxy resolution                     |
| P0       | `open-sse/utils/proxyFetch.js`                                         | 344-435               | Transport and no-direct-fallback strict policy         |
| P1       | `src/sse/services/tokenRefresh.js`                                     | 145-213               | Existing SQLite credential persistence                 |
| P1       | `src/app/api/providers/[id]/models/route.js`                           | 73-95,173-195         | Dashboard response/warning contract                    |
| P1       | `src/app/api/v1/models/route.js`                                       | 76-84,290-455,477-523 | Public IDs, limits, filters, schema                    |
| P1       | `src/shared/utils/liveModels.js`                                       | all                   | Read-only curated-name precedence and import selection |
| P1       | `src/shared/constants/models.js`                                       | 43-57                 | Designer-owned CAPACITY_META video-input badge         |
| P1       | `src/shared/components/Callout.js`                                     | all                   | Existing warn variant and status semantics             |
| P1       | `src/app/(dashboard)/dashboard/providers/detail/ModelsSection.js`      | all                   | Designer-owned row capability composition              |
| P1       | `src/app/(dashboard)/dashboard/providers/detail/ProviderDetailPage.js` | 71-91                 | Catalog selection and merging                          |
| P1       | `src/app/(dashboard)/dashboard/providers/[id]/useLiveCatalog.js`       | all                   | Refresh query, warnings, first active connection       |
| P1       | `tests/unit/xai-live-models.test.js`                                   | all                   | Dual-auth route integration pattern                    |
| P1       | `tests/unit/venice-bazaarlink-llm7-sambanova-live-models.test.js`      | all                   | Metadata and public catalog assertions                 |
| P1       | `tests/unit/proxy-strict-fetch.test.js`                                | all                   | Stub fetch before proxy module imports                 |
| P1       | `tests/vitest.config.js`                                               | all                   | Required isolated test configuration                   |
| P1       | `tests/setup/isolateDataDir.js`                                        | all                   | Disposable HOME/DATA_DIR                               |
| P2       | `tests/e2e/upgrade-from-9router.mjs`                                   | 1-110                 | Stdlib process/isolation/cleanup precedent             |

## External Documentation

| Topic                              | Source                                                                                                                | Key Takeaway                                                                                                                                                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Official model wire contract       | <https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/auth/platforms.py> | Parent verified: GET Coding `/models`, Bearer for either credential, `data` entries with `id`, nullable `display_name`, positive integer `context_length`, boolean `supports_reasoning`, `supports_image_in`, `supports_video_in` |
| Official fixtures                  | <https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/tests/auth/test_platforms.py>   | Use pinned fields, not guessed OpenAI names                                                                                                                                                                                       |
| Current CLI docs (Context7 lookup) | <https://github.com/moonshotai/kimi-cli/blob/main/docs/en/configuration/config-files.md>                              | OAuth managed display names refresh from `/models`; CLI capabilities include thinking/image/video input                                                                                                                           |

Official client only sends Bearer; issue explicitly requires executor device headers too. Follow issue and `buildKimiHeaders`, not CLI header minimalism. Do not copy CLI name heuristics over explicit false flags. CLI environment overrides are not gateway requirements.

## Patterns to Mirror

### NAMING_CONVENTION — provider-local module and plain JS result

```js
// src/lib/providerModels/xaiModels.js:91-98
export async function resolveXai(connection) {
  if (!connection.accessToken && !connection.apiKey) {
    return { models: [], warning: "No valid token found" };
  }
```

Add `parseKimiModels(body)` and `resolveKimi(connection)` in `kimiModels.js`. Return `{ models, warning? }`; no new type framework.

### SERVICE_PATTERN — shared refresh and rotation persistence

```js
// src/lib/providerModels/oauthResolver.js:15-19
let response = await fetchFn(accessToken, connection);
if (!response.ok && (response.status === 401 || response.status === 403) && refreshToken) {
  const refreshed = await refreshFn(connection);
  if (refreshed?.accessToken) {
```

Helper persists `accessToken`, rotated `refreshToken`, `expiresIn`, then mutates connection and retries once. Reuse unchanged; do not create refresh loop, proactive-refresh path, or parallel persistence implementation.

### ERROR_HANDLING / LOGGING_PATTERN — safe provider-local boundary

```js
// src/lib/providerModels/liveResolvers.js:58
const noModels = (label) => ({ models: [], warning: `${label} returned no live models.` });
```

Mirror empty-result contract, not raw upstream logging. Existing OAuth helper logs response text and exception messages: prevent sensitive raw material reaching it. Kimi fetch wrapper must return bodyless non-OK Responses retaining HTTP status, and replace transport/JSON exceptions with fixed safe messages. Top-level Kimi resolver catches all unexpected failures and returns generic warning. Never interpolate response bodies, tokens, refresh bodies, connection records, proxy URLs, or raw errors.

### REPOSITORY_PATTERN — shared catalog/cache

```js
// src/lib/providerModels/liveResolvers.js:395-397
const key = `${connection.provider}:${connection.id}`;
const cached = cache.get(key);
if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.result;
```

Register `kimi: resolveKimi`; reuse 60-second success cache and `refresh=1`. Failures evict cache. No credential-bearing cache key, extra cache, persistent catalog, or cross-account memoization.

### TRANSPORT_PATTERN — connection-resolved proxy, never bare fetch

```js
// src/lib/providerModels/liveResolvers.js:250
const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
```

Use `proxyAwareFetch(url, requestOptions, proxyOptions)` from `open-sse/utils/proxyFetch.js`. Resolve once per uncached Kimi attempt; pass same selected proxy fields to initial GET, token refresh, and retry. Include `connectionProxyEnabled`, `connectionProxyUrl`, `connectionNoProxy`, `vercelRelayUrl`, `strictProxy`, and mapped `connectionProxyPoolId: proxy.proxyPoolId`.

### TEST_STRUCTURE — real isolated DB with mocked upstream

```js
// tests/unit/xai-live-models.test.js:49-54
const res = await GET(new Request(`http://localhost/api/providers/${id}/models`), {
  params: Promise.resolve({ id }),
});
return res.json();
```

Reuse route handlers/public builder against actual disposable DB. Unlike xAI fixture, do not delegate unmatched URLs to native network. Mock proxy transport explicitly or stub global fetch before dynamic imports, as `proxy-strict-fetch.test.js` does.

## Architecture: Kimi Coding live catalog

### Design Decisions

1. **Minimal integration:** one provider module plus resolver-map entry and registry feature. Existing API routes, static registry models, public filtering, and cache remain unchanged.
2. **Credential priority:** use nonempty API key before OAuth access token, matching executor. API-key rejection never triggers OAuth refresh, even when access/refresh tokens coexist. Missing credentials produce warning without network.
3. **Secure transport:** use connection proxy resolver and `proxyAwareFetch`, not xAI's bare-fetch transport. OAuth `refreshFn` calls engine `refreshTokenByProvider("kimi", conn, null, proxyOptions)` imported from `open-sse/services/tokenRefresh.js`; app wrapper lacks proxy argument and is unsuitable here. Optional null logger prevents raw refresh-response logging; `buildOAuthResolver` still owns DB persistence. Abort with safe warning if proxy resolution returns `source: "error"`; do not add a direct retry or change shared proxy policy.
4. **Endpoint/header contract:** fixed module constant `https://api.kimi.com/coding/v1/models`, explicit GET, `Authorization: Bearer ...`, `Accept: application/json`, and `...buildKimiHeaders(connection.providerSpecificData?.deviceId)`. No Moonshot platform fallback, arbitrary base URL, copied header values, or CLI env support. Reject redirects on catalog GET (`redirect: "error"`) rather than following credentials to another location.
5. **Timeout:** `AbortSignal.timeout(10_000)` per catalog GET, covering fetch/body parsing. Existing refresh helper's duration/retry behavior remains unchanged; this is not a guaranteed 10-second total across OAuth refresh. No refresh overhaul or timeout race that leaves work running.
6. **Metadata contract:** parser accepts only `body.data` arrays; trim nonblank string IDs, deduplicate in upstream order (first valid ID wins), trim usable display names or fall back to ID. Keep positive integer numeric `context_length` as `contextLength`; no string coercion or speculative output limit. Emit `kind: "llm"` explicitly, preventing ID/video heuristics from misclassifying chat models. Map declared boolean reasoning/image/video flags into existing `capabilities.reasoning` / `capabilities.vision` / `capabilities.videoInput`, preserving false; include valid context as `capabilities.contextWindow` for existing consumers. Emit `inputModalities: ["text", ...imageWhenTrue, ...videoWhenTrue]`. Ignore invalid/missing optional flags rather than treating strings as truthy; omit absent capability keys. Video uses existing input capability plus modalities, never `kind: "video"` or a new public API field.
7. **Failures:** non-OK, missing/invalid JSON, malformed/empty catalog, all-invalid rows, timeout, refresh failure, or strict proxy failure return empty models and nonempty safe warning. Dashboard API remains HTTP 200 `{ provider, connectionId, models: [], warning }`, dashboard renders static rows, public endpoint returns existing static list without warning field. Valid catalog replaces static membership; do not union all static IDs back into success.
8. **UI boundary:** keep `mergeLiveWithStatic` unchanged, including curated names for known IDs. In `ModelsSection`, use per-key `{ ...getCaps(key), ...model.capabilities }` for live rows so false overrides and unspecified keys retain fallback; do not replace entire capability object. Add `CAPACITY_META.videoInput` with input-specific label/description. `ProviderDetailPage` passes `liveFallback` when live-catalog failure leaves static catalog; `ModelsSection` renders sanitized warning with `Callout variant="warn"`. No new category/control or backend schema field.

### Alternatives Rejected

- Adding Kimi to generic API-key resolver: loses OAuth refresh/header behavior.
- Copying xAI transport unchanged: ignores per-connection strict proxy policy.
- Using app `refreshTokenByProvider` wrapper: cannot pass selected strict proxy configuration.
- Changing generic refresh, proxy, auth, cache, or API schema: unnecessary scope; existing helpers suffice.
- Browser-only mocked `/api/providers/.../models`: bypasses backend endpoint; insufficient E2E evidence.
- New Playwright dependency: existing browser tool can validate real running UI; stdlib harness supplies deterministic server/DB/upstream fixtures.

### Data Flow

Registry `features.liveModels` enables generic Kimi UI. Dashboard route resolves connection and calls shared cache; public builder selects active connection and uses same resolver unless explicit enabled-model allowlist applies. Resolver selects credential, resolves proxy, fetches Coding catalog, optionally refreshes OAuth once through existing helper and persists rotation, parses whitelist metadata, and returns normalized list. Cache stores normalized models only. Dashboard hook merges catalog and renders rows; public builder maps IDs/capabilities/context into existing OpenAI-compatible list, retaining aliases, custom models, disabled-model filtering, and prefix handling.

## Files to Change

| File                                                                   | Action                     | Justification                                                                                  |
| ---------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/lib/providerModels/kimiModels.js`                                 | CREATE                     | Parser, dual-auth resolver, sanitized proxy-aware catalog transport                            |
| `src/lib/providerModels/liveResolvers.js`                              | UPDATE                     | Import and register Kimi resolver; no cache rewrite                                            |
| `open-sse/providers/registry/kimi.js`                                  | UPDATE                     | Add `features.liveModels: true` only                                                           |
| `tests/unit/kimi-live-models.test.js`                                  | CREATE                     | Parser/auth/refresh/proxy/security/cache/dashboard/public integration                          |
| `tests/e2e/kimi-live-models.mjs`                                       | CREATE                     | Stdlib isolated running-app/relay fixture with endpoint assertions and browser mode            |
| `tests/README.md`                                                      | UPDATE                     | Exact offline test and browser fixture commands, safety/cleanup                                |
| `tests/unit/live-models-utils.test.js`                                 | UPDATE (backend/test only) | Required `LIVE_MODEL_PROVIDERS` expectation adds `kimi`; keep curated-name behavior regression |
| `src/app/(dashboard)/dashboard/providers/detail/ModelsSection.js`      | UPDATE (designer only)     | Per-key live capability override and amber fallback Callout                                    |
| `src/shared/constants/models.js`                                       | UPDATE (designer only)     | `CAPACITY_META.videoInput` input badge                                                         |
| `src/app/(dashboard)/dashboard/providers/detail/ProviderDetailPage.js` | UPDATE (designer only)     | Pass `liveFallback` into model section                                                         |

### Exact File Ownership

- **Backend/test lane:** only first seven paths above. Backend must not edit UI lane or OAuth/proxy helpers, API routes, DB schema, registry generated index, test config, or package manifests.
- **Designer UI lane:** only last three paths above. `src/shared/utils/liveModels.js` is read-only. If `ModelRow.js`, hooks, or another file truly needs changes, parent must approve lane extension before editing; do not silently expand scope.
- **Plan lane:** `docs/prps/plans/yan-192-kimi-live-models.plan.md` only, planning subagent owns structural validation.
- **Integration lane:** parent runs commands/browser tools and records evidence in handoff; no overlapping edits. Any necessary scope change returns to parent first.

## NOT Building

- No dependencies, schema/migrations, new endpoints, public warning/name/video fields, persistent model cache, model-name heuristics, or scheduler.
- No Kimi executor/refresh/header rewrite; no shared OAuth-helper overhaul, proxy bypass, automatic platform fallback, or configurable upstream URL.
- No metadata precedence rewrite or curated-name merge change, dashboard redesign, locale edits, CHANGELOG, RELEASING edits, version bump, commits, or backports.
- No production credentials, real provider requests, real home/data access, or tests using alternate Vitest configuration.

## Step-by-Step Tasks

### Task 1.1: Define normalized Kimi catalog and secure resolver — Depends on [none]

- **BATCH**: B1
- **Owner**: Backend implementer
- **ACTION**: CREATE `src/lib/providerModels/kimiModels.js` and parser/auth tests in `tests/unit/kimi-live-models.test.js`.
- **IMPLEMENT**: Implement `parseKimiModels(body)` and `resolveKimi(connection)` using Architecture contracts, API-key-first branching, safe errors and fixed URL/header builder. Resolve proxy once inside resolver and construct existing OAuth helper with closures that carry proxy config into both catalog fetch and engine refresh dispatcher; parse successful response inside sanitized fetch boundary and return normalized JSON Response if needed so malformed JSON cannot leak raw contents through helper logs.
- **MIRROR**: `xaiModels.js` dual-auth branch, `oauthResolver.js` refresh/persist contract, Grok CLI proxy forwarding, `apiKeyModels.js` 10-second timeout.
- **IMPORTS**: `buildKimiHeaders` from `open-sse/config/appConstants.js`; `proxyAwareFetch` from `open-sse/utils/proxyFetch.js`; `refreshTokenByProvider` from `open-sse/services/tokenRefresh.js`; `buildOAuthResolver` from `@/lib/providerModels/oauthResolver.js`; `resolveConnectionProxyConfig` from `@/lib/network/connectionProxy`.
- **GOTCHA**: Non-OK catalog Response must retain 401/403 but discard body before OAuth helper sees it. Use null refresh logger; no raw credential logs. Do not use app refresh wrapper, `fetch` alone, or a catalog URL override. Missing device ID follows existing builder behavior; do not generate/persist new identity machinery.
- **VALIDATE**: Backend runs isolated Kimi test command below. Assert exact GET URL, Bearer key/token selection, executor device headers, timeout signal and redirect rejection; parser false/type/dedup/video cases; one refresh/retry and actual rotated credentials in disposable SQLite. API-key 401 must show zero refresh calls.

### Task 1.2: Confirm designer UI contract — Depends on [none]

- **BATCH**: B1
- **Owner**: Designer
- **ACTION**: Read UI lane and provide decision to parent; no backend edits.
- **IMPLEMENT**: Confirm approved three-file change: per-key live caps in ModelsSection, videoInput badge in CAPACITY_META, and amber fallback Callout driven by ProviderDetailPage `liveFallback`. Keep curated-name merge unchanged; backend owns required `kimi` addition to exact `LIVE_MODEL_PROVIDERS` test expectation.
- **MIRROR**: `ProviderDetailPage.js:71-91`, `liveModels.js:44-60`, `ModelsSection.js` visible-model row, existing `ModelRow.js` context rendering.
- **IMPORTS**: No new dependency or UI abstraction.
- **GOTCHA**: Explicit false is authoritative; video-input metadata does not warrant generation UI. Required key-list assertion belongs to backend/test lane; no overlapping edits.
- **VALIDATE**: Designer returns approved file-level recommendation to parent, covering curated known-ID name, upstream unknown-ID name, false badges, unknown-capability fallback, video-input badge and amber empty-live fallback.

### Task 2.1: Wire resolver and prove shared API behavior — Depends on [1.1]

- **BATCH**: B2
- **Owner**: Backend implementer
- **ACTION**: UPDATE `src/lib/providerModels/liveResolvers.js`, `open-sse/providers/registry/kimi.js`, `tests/unit/live-models-utils.test.js`, and extend `tests/unit/kimi-live-models.test.js`.
- **IMPLEMENT**: Add Kimi resolver import/map entry, `features.liveModels: true` and `kimi` in exact LIVE_MODEL_PROVIDERS test expectation; leave static models, curated merge behavior and endpoints unchanged. Extend real-DB route tests for dashboard success/warning, public catalog membership and existing schema, metadata, filtering, cache reuse/force refresh/TTL/account separation, missing credentials and transient failures.
- **MIRROR**: `xai-live-models.test.js`, `venice-bazaarlink-llm7-sambanova-live-models.test.js`, `liveResolvers.js` cache contract.
- **IMPORTS**: `resolveKimi` in resolver registry; route handlers, `buildModelsList`, DB connection getters/creators, cache clear/TTL constants in tests.
- **GOTCHA**: Do not edit either API route, auth gates, registry generated index, cache algorithm, or static list. No new aliases in resolver map: DB normalization already canonicalizes legacy Kimi IDs. Public enabled-model allowlist must keep bypassing discovery.
- **VALIDATE**: Backend runs targeted regressions; asserts live ID appears with `kimi/` or configured prefix, `context_length` and declared false capability flags survive, warnings stay out of public envelope, and failed refresh retains static membership. Assert no credential sent to wrong account, no raw secrets in warnings/models/cache-visible results or captured logs.

### Task 2.2: Apply approved live badges and fallback Callout — Depends on [1.1, 1.2]

- **BATCH**: B2
- **Owner**: Designer only
- **ACTION**: UPDATE only `src/app/(dashboard)/dashboard/providers/detail/ModelsSection.js`, `src/shared/constants/models.js`, and `src/app/(dashboard)/dashboard/providers/detail/ProviderDetailPage.js`.
- **IMPLEMENT**: Compose visible-row caps with `{ ...getCaps(key), ...model.capabilities }` where key is provider/model ID, preserving false and unspecified-key fallback, and add `videoInput` badge metadata with input-specific wording. Derive `liveFallback` in ProviderDetailPage from live-enabled non-compatible provider, nonempty warning and empty live catalog; pass prop into ModelsSection, declare/default prop, and use existing amber `Callout variant="warn"` to identify static fallback while retaining safe warning text.
- **MIRROR**: Existing ModelsSection row props, CAPACITY_META entries, Callout warn variant, and ProviderDetailPage catalog selection; no new Kimi component.
- **IMPORTS**: Existing components/helpers only; no change to `src/shared/utils/liveModels.js`.
- **GOTCHA**: Backend/test agent must not touch these three UI files. Curated known-ID names stay unchanged; API still returns upstream name. Custom import behavior may create additional rows after Fetch models; inspect corresponding live row, not exact global row count. Video badge describes input, never generated output.
- **VALIDATE**: Designer captures curated known-ID name, upstream new-ID name, live context, explicit false badges, fallback for unspecified caps, video-input badge and amber static-fallback Callout. Backend runs registry/merge test regressions; parent/designer run browser checks after B2.

### Task 3.1: Build deterministic endpoint-to-dashboard fixture — Depends on [2.1, 2.2]

- **BATCH**: B3
- **Owner**: Backend implementer creates harness; parent and designer run browser checks
- **ACTION**: CREATE `tests/e2e/kimi-live-models.mjs`, UPDATE `tests/README.md` with offline fixture commands.
- **IMPLEMENT**: Use Node stdlib `assert/strict`, `http`, `child_process`, `fs`, `path`, `os` to launch production app plus mock relay, allocate disposable state and assert real HTTP dashboard/public endpoints. Add `--serve` mode retaining fixture until SIGINT for existing browser tool; provide loopback-only scenario controls, request counts and ready URL, keeping fixture alive without a new dependency.
- **MIRROR**: `tests/e2e/upgrade-from-9router.mjs` process lifecycle, ephemeral ports, throwaway HOME, cleanup; existing relay proxy protocol in `proxyFetch.js:344-356`.
- **IMPORTS**: Node stdlib only; no direct production DB manipulation required.
- **GOTCHA**: This must exercise real Next HTTP routes and actual browser UI, not only `buildModelsList`, SSR text or mocked dashboard responses. Do not set `RUN_REAL=1` / `RUN_E2E=1`. Child process must inherit explicit disposable HOME/DATA_DIR and loopback egress guard before app imports.
- **VALIDATE**: Harness exits zero for positive/failure HTTP scenarios; parent runs browser acceptance protocol below on `--serve`, designer checks visual/accessible state. Stop child processes and mock relay; remove only fixture-owned temp directory. Save request-count/assertion evidence, not credentials.

### Task 4.1: Review and release-target validation gate — Depends on [3.1]

- **BATCH**: B4
- **Owner**: Parent integration owner; backend/designer fix only assigned lanes
- **ACTION**: Run code-reviewer after code changes, targeted tests, lint, full `npm test`, production build, offline E2E and browser protocol; audit diff and record outcomes.
- **IMPLEMENT**: Parent delegates code review, resolves findings through correct owner, and records command exit codes plus verified UI/API/security behavior. Document only scoped test instructions; no release docs, locales, dependencies or commits.
- **MIRROR**: `CLAUDE.md` test/regression policy and `RELEASING.md` trunk feature policy.
- **IMPORTS**: None.
- **GOTCHA**: Existing baseline failures are not new failures; never bless new failures or rewrite baseline to make gate pass. Block completion if dependencies/environment prevent required build/E2E; report blocker rather than claiming success.
- **VALIDATE**: Parent signs all acceptance criteria with concrete evidence, branch remains feature branch in specified worktree, and changed files remain within approved lanes. Planning subagent separately owns structural validator, not application acceptance.

## Testing Strategy

### Unit Tests

Keep one focused Kimi test file with table-driven edge cases; reuse installed Vitest, no new test framework. Hoist mock of `proxyAwareFetch` before resolver imports to avoid native network capture; default unmatched calls throw. Exercise real DB persistence, not only a spy on `updateProviderCredentials`. Mock engine refresh dispatcher for routine cases and verify fourth argument receives strict proxy options; add one real engine refresh-path case with mocked transport if needed to prove refresh POST header/body and rotated-token persistence.

| Test                     | Input                                                                                                           | Expected Output                                                                            | Edge Case? |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------- |
| Metadata                 | Known and unknown IDs; custom display name; context 262144; true flags                                          | `kind: llm`, proper name/context, reasoning/vision/videoInput, text/image/video input list | No         |
| Explicit false           | Model name includes `thinking`/`image` but upstream flags false                                                 | No heuristic override; all declared false survive dashboard/public/merge                   | Yes        |
| Parser boundary          | Null body, missing/nonarray data, null/primitive rows, blank/numeric IDs, duplicate IDs                         | Empty/warning or valid first entries only; no throw                                        | Yes        |
| Optional types           | Null/blank/numeric name; negative/fractional/string/NaN context; missing/nonboolean flags                       | ID fallback, omitted invalid limits/keys, no coercion                                      | Yes        |
| Auth                     | API key only, OAuth only, both, neither                                                                         | Bearer selected key/token; key wins; neither makes zero calls                              | Yes        |
| Refresh                  | OAuth 401 or 403 then success, rotated refresh token, expiresIn                                                 | Exactly one refresh then retry; DB updated; same proxy and headers                         | Yes        |
| Refresh denied           | Key 401 with OAuth also present; absent refresh token; retry 401; refresh throws/null                           | No inappropriate refresh or loop; safe warning/static fallback                             | Yes        |
| Transport                | Network error, timeout, invalid JSON, empty success, 5xx, redirect rejection                                    | Models empty, safe nonempty dashboard warning, no public warning                           | Yes        |
| Proxy                    | Strict pool/relay resolution, initial GET/retry/refresh, failed strict proxy                                    | Same options all calls; no direct fallback from new resolver                               | Yes        |
| Secret containment       | Error body/exception echoes synthetic key/token/proxy password                                                  | No echoes in response, logs, parsed models, warnings                                       | Yes        |
| Cache                    | Repeat dashboard/public, force refresh, advance clock past TTL, two connection IDs, success then forced failure | Shared success cache; refresh bypass; isolation; failed result not held; recovery retries  | Yes        |
| Public existing contract | Disabled IDs, custom/prefix, explicit enabledModels                                                             | Existing filtering/schema preserved; allowlist bypasses upstream                           | Yes        |
| UI composition           | Known-ID curated name; live flags false; other caps missing                                                     | Curated name remains; false overrides badge heuristics; unspecified caps retain fallback   | Yes        |

### Edge Cases Checklist

- [ ] Data/model/metadata types validated at upstream boundary; upstream object extras never spread into result.
- [ ] Empty and all-invalid catalogs produce warning, not success cache.
- [ ] OAuth 401 and existing-helper 403 retry exactly once; rejected API key never refreshes.
- [ ] Refresh-token rotation persists through existing helper; existing PSD/device ID retained.
- [ ] Strict proxy passed to refresh as well as catalog; no locally introduced fallback.
- [ ] Cached models cannot leak per-account credentials; no secret in cache key.
- [ ] Public list keeps schema and existing limit fallback; no new video generation model.
- [ ] Existing shared cache allows duplicate concurrent cold requests; no new single-flight abstraction required.

### Deterministic HTTP and Browser E2E Protocol

1. Harness verifies built app exists, creates `/tmp/opencode/yan-192-e2e-*` with HOME, DATA_DIR, APPDATA, XDG directories and log files inside it. Spawn app bound to `127.0.0.1` on free port via `node custom-server.js --hostname 127.0.0.1 --port PORT`. Set random fixture JWT/API secrets, `TOKENHOP_MULTI_USER=off`, and nondefault `INITIAL_PASSWORD`; clear inherited proxy variables, provider tokens and real-test flags. Never seed from real DB.
2. Generate temporary Node preload inside fixture directory, load with child `--import` before app. Wrap global fetch to reject non-loopback destinations; this also protects against background models.dev sync and accidental direct Kimi fetch. Use controlled child environment; browser automation can also block its own non-loopback requests, but this does not intercept server fetch. Failure scenarios must change mock relay's server-side response, not block `api.kimi.com` in browser. No production code switch or upstream override is added.
3. Loopback mock relay uses existing `x-relay-target` and `x-relay-path` protocol. It asserts `https://api.kimi.com` and `/coding/v1/models`, GET, synthetic Bearer, X-Msh headers; handles only allowlisted catalog/fixture control requests. No relay request is forwarded to external network; unknown target fails fixture. Control mode supports success, 503 body containing synthetic secret, empty and invalid JSON; keep counts but never print Authorization.
4. Authenticate against real `/api/auth/login` using fixture password and capture cookie. Create `type: "vercel"`, `strictProxy: true`, active proxy pool through POST `/api/proxy-pools` with loopback relay URL; read `proxyPool.id`. Create fake API-key Kimi connection through POST `/api/providers` with `provider: "kimi"`, `apiKey: "kimi-fixture-only"`, `name`, `testStatus: "active"`, `proxyPoolId` and PSD device ID; read returned connection ID. These are disposable rows only. No test-connection/chat/quota action is clicked.
5. Success fixture returns known `kimi-for-coding` renamed `Fixture Coding Live`, context 262144 and explicit false flags, plus unknown `kimi-fixture-next` with true reasoning/image/video input flags. Assert real `/api/providers/ID/models?hidden=1&refresh=1` has normalized metadata; `/v1/models` has prefixed IDs, context and existing capability keys, no warnings/credentials; repeat without refresh verifies relay count unchanged.
6. In `--serve` mode, open printed `/dashboard/providers/kimi`, log in using fixture password, wait for actual model request completion. Assert known ID retains curated `Kimi for Coding` name and displays live context; API separately exposes `Fixture Coding Live`. False reasoning/vision/video-input badges stay absent on known live row; unknown row displays upstream name and supported reasoning/vision/video-input badges. Include fixture with omitted capability key to verify heuristic fallback remains for that key. Generic Fetch models button exists and works by keyboard. Activate button, verify `refresh=1` request and mock count increase, loading settles and no console/runtime error. Existing import side effect may add unknown IDs as custom entries; account for it.
7. Switch relay to 503 using printed loopback control URL, press Fetch models again. Assert dashboard shows amber Callout explaining static-model fallback, safe warning text and static known rows; no echoed synthetic secret. Real `/v1/models` still returns static catalog with OpenAI list envelope and no warning. Switch success back, force refresh, verify recovery without reload or account edits. Unknown imported custom IDs can legitimately remain; assert static fallback presence, not total absence of all custom IDs.
8. Designer captures row/video-badge/amber-callout screenshots or DOM evidence and keyboard result; parent records HTTP assertions and relay counters. Stop fixture with SIGINT; harness kills and awaits child, closes relay and removes only its own temp tree. Failure paths perform same cleanup. No browser E2E claimed if only harness HTTP assertions ran.

## Validation Commands

Run from Parent worktree only. Application commands below belong to implementation phase, not planning. Root/test dependencies must already be installed; if unavailable, parent handles normal dependency installation without manifest/lockfile changes. Never invoke Vitest without required config. Clear `RUN_REAL` / `RUN_E2E` so existing live-provider suites stay skipped.

### Plan Structural Validation — planning subagent

```bash
/home/yandy/.config/opencode/skills/prp-plan/scripts/validate-prp-plan.sh \
  docs/prps/plans/yan-192-kimi-live-models.plan.md
```

EXPECT: Exit 0; all task fields, dependencies and existing paths valid. Check CREATE paths manually if generic validator treats them as existing.

### Static Analysis — backend/designer, parent aggregate

```bash
npm run lint
```

EXPECT: No new lint failures; no dependency or broad formatting changes. JavaScript repository has no dedicated TypeScript check; build is module/compilation gate.

### Unit Tests — backend/designer

```bash
env -u RUN_REAL -u RUN_E2E TMPDIR=/tmp/opencode npx vitest run -c tests/vitest.config.js \
  tests/unit/kimi-live-models.test.js \
  tests/unit/xai-live-models.test.js \
  tests/unit/venice-bazaarlink-llm7-sambanova-live-models.test.js \
  tests/unit/live-models-utils.test.js \
  tests/unit/live-model-resolvers.test.js \
  tests/unit/proxy-strict-fetch.test.js \
  tests/unit/kimi-chat-search.test.js \
  tests/unit/kimi-usage.test.js
```

EXPECT: All targeted tests pass offline with setup-owned disposable DB/HOME. These tests must stub unmatched upstream calls rather than defer to native fetch.

### Full Test Suite — parent

```bash
env -u RUN_REAL -u RUN_E2E TMPDIR=/tmp/opencode npm test
node tests/__baseline__/verify-providers.mjs
node tests/__baseline__/verify-alias.mjs
node tests/__baseline__/verify-oauth-urls.mjs
```

EXPECT: Existing regression gate passes, no new baseline failures; aliases/OAuth URLs/provider identity unchanged. Do not update baseline artifacts to hide regressions. Required because app module/registry/UI integration changes, not docs-only implementation.

### Production Build — parent

Build can initialize app modules. Isolate build storage too; keep original HOME out of child environment. Example runnable shell block:

```bash
(
  set -eu
  scratch=$(mktemp -d /tmp/opencode/yan-192-build-XXXXXX)
  trap 'rm -rf -- "$scratch"' EXIT
  mkdir -p "$scratch/home" "$scratch/data" "$scratch/config" "$scratch/cache"
  env -u RUN_REAL -u RUN_E2E HOME="$scratch/home" USERPROFILE="$scratch/home" \
    DATA_DIR="$scratch/data" APPDATA="$scratch/data" \
    XDG_CONFIG_HOME="$scratch/config" XDG_CACHE_HOME="$scratch/cache" \
    TOKENHOP_MULTI_USER=off NEXT_TELEMETRY_DISABLED=1 npm run build
)
```

EXPECT: Production build succeeds. No seeded connections during build; no live provider calls. Do not fall back to running app/build against real data if environment prevents this.

### Database Validation — backend

Covered by required-config tests: create synthetic Kimi connection in disposable SQLite, receive OAuth 401, mock rotated access/refresh tokens with expiry, inspect saved row and unchanged device/proxy metadata. No migrations or production DB checks.

### HTTP and Browser Validation — parent/designer

```bash
node tests/e2e/kimi-live-models.mjs
node tests/e2e/kimi-live-models.mjs --serve
```

EXPECT: First command exits zero after real endpoint assertions and cleanup. Second prints loopback app/control URLs and fixture-only login guidance; run browser protocol above through existing browser tool, then SIGINT for cleanup. Harness validates nondefault isolated DATA_DIR/HOME before starting app and enforces loopback-only egress. No downloaded browser/library dependency.

### Manual Validation Checklist

- [ ] Browser logs into disposable app only and opens `/dashboard/providers/kimi`.
- [ ] Known-ID curated name retained; new-ID upstream name and live context shown; explicit false badges stay off.
- [ ] Unknown supported live model appears; video input never creates video-generation section.
- [ ] Keyboard Fetch models issues real refresh request and completes loading/import flow.
- [ ] Failure warning is visible and sanitized; static list remains; public JSON schema unchanged.
- [ ] Recovery succeeds after force refresh; API/UI/cache evidence agrees.
- [ ] Fixture processes and owned temporary state cleaned up; no real provider/home access.

## Acceptance Criteria

- [ ] Exact official Coding URL queried by GET for API-key or OAuth connections with Bearer credential and executor `buildKimiHeaders`.
- [ ] API key wins when both credentials exist; rejected key never initiates OAuth refresh or switches credentials.
- [ ] OAuth 401 and existing-helper 403 refresh once at most, persist rotation/expiry through existing helper, then retry with fresh token.
- [ ] Initial GET, refresh and retry carry same selected connection proxy/relay/strict configuration; strict failure never triggers a resolver-owned direct retry.
- [ ] Catalog GET timeout is approximately 10 seconds per attempt; refresh semantics remain unchanged and documented.
- [ ] Parser exposes name/context/reasoning/vision/video-input metadata and preserves false; malformed fields rejected; chat kind explicit.
- [ ] Kimi live resolver registered and feature flag enables generic Fetch models flow without custom route/UI.
- [ ] Shared cache keeps per-connection success TTL/forced refresh semantics and does not cache raw credentials or warnings from failed accounts.
- [ ] Dashboard/public catalogs see live models; explicit enabled models, aliases, custom entries, prefixes and disabled filtering preserve existing behavior.
- [ ] Any discovery failure retains static models and sanitized dashboard warning only; public response shape unchanged.
- [ ] Designer implements per-key capability override, video-input badge and amber fallback Callout in own lane; backend updates registry expectation; curated-name merge unchanged.
- [ ] Deterministic real HTTP and browser E2E completed using disposable DB and mocked upstream, not route mocks masquerading as browser proof.
- [ ] Targeted tests, existing baselines, lint, full `npm test`, build and reviewer findings pass or have explicit parent-approved pre-existing exceptions with evidence; required E2E not waived silently.
- [ ] No dependencies, locale/release docs, schema, production data, live calls, commits or backports touched.

## Completion Checklist

- [ ] Parent approval obtained before implementation.
- [ ] All six tasks completed; parent-supplied designer decision applied.
- [ ] Code follows provider-local patterns; no needless abstraction or refresh/proxy rewrite.
- [ ] Upstream trust boundary validates whitelisted fields and sanitizes errors before shared logging.
- [ ] One focused Kimi test file leaves runnable auth/metadata/security regression checks.
- [ ] Actual DB token rotation, API cache behavior and UI badge behavior verified separately.
- [ ] Code-reviewer used after code edits; ownership lanes respected during fixes.
- [ ] Test README documents safe offline fixture lifecycle.
- [ ] Parent records command exit codes, browser evidence and residual risks.
- [ ] Git diff contains only approved files; plan remains in existing feature worktree until parent workflow decides archival.

## Risks

| Risk                                                                   | Likelihood                    | Impact                                                        | Mitigation                                                                                                                                                               |
| ---------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| App refresh wrapper drops proxy options                                | High if copied mechanically   | Strict-proxy credential request could go direct               | Import engine dispatcher with explicit fourth proxy argument; test both GET and refresh                                                                                  |
| Shared OAuth helper logs response/error text                           | High                          | Credential/proxy detail leak                                  | Strip non-OK body before helper, sanitize exceptions, null refresh logger, adversarial synthetic-secret tests                                                            |
| Heuristic badges override live false                                   | High                          | Misleading capabilities                                       | Designer-owned per-key row-cap merge, false/unknown-capability browser checks; curated names intentionally retained                                                      |
| Proxy resolver itself fails open on DB errors/missing pool             | Existing                      | Privacy expectation mismatch                                  | Abort Kimi on explicit `source: error`; preserve documented existing missing/inactive-pool semantics, no shared redesign; flag future strict-pool policy work separately |
| Static curated metadata later includes capability overrides            | Low for present Kimi registry | Shared unchanged merge could supersede live capability fields | Current Kimi static entries have only ID/name; test current contract, escalate future precedence changes rather than rewrite now                                         |
| OAuth refresh not bounded by catalog's 10-second signal                | Existing                      | Slow failure if auth service hangs                            | Explicit per-GET timeout contract; no claim of total wall-clock bound or refresh overhaul                                                                                |
| Existing credential update helper returns false on persistence failure | Existing                      | Rotated token may not persist during DB outage                | Prove normal real-DB persistence; document existing helper limitation, no scope-creep refresh rewrite                                                                    |
| Shared cache not fingerprinted by credential/proxy version             | Existing                      | Up to 60 seconds stale catalog after edit                     | Preserve existing cache; explicit refresh bypass and per-connection tests; no new credential-bearing cache keys                                                          |
| Proxy module captures native fetch at import                           | High                          | Tests accidentally contact provider                           | Hoisted module mock or pre-import stub; fixture preload rejects external destinations                                                                                    |
| Official CLI auto-capability heuristics copied                         | Medium                        | False flags become true                                       | Map explicit fields only; fixture IDs deliberately conflict with heuristic names                                                                                         |
| Platform API key lacks Coding entitlement                              | Medium                        | Catalog request rejected                                      | Safe warning/static fallback; no automatic different-host request with credential                                                                                        |
| Browser Fetch models imports custom IDs                                | Expected                      | Duplicate rows affect brittle assertions                      | Assert targeted live row metadata and static fallback presence, not global exact counts                                                                                  |
| Background catalog sync during E2E                                     | Expected after 60 seconds     | Unintended external request                                   | Child preload blocks non-loopback fetch before app imports; no production toggle                                                                                         |

## Notes

- Updated after parent designer handoff: exactly three designer-owned UI files, per-key capability spread, videoInput metadata badge, `liveFallback` amber Callout, unchanged curated-name merge. Backend owns test changes. Server interception lives in deterministic fixture, never browser-only route blocking.

- Plan research read required repo rules and inspected current branch/HEAD: `feat/yan-192-kimi-live-models`, `bf80e10a`; initial worktree clean.
- External pinned wire contract supplied by parent as verified research. Context7 lookup independently confirms managed `/models` display-name refresh and input capability terminology, not gateway env override requirements.
- Plain JavaScript + existing installed dependencies suffice. No new domain types, general resolver factory, schema, or configuration surface.
- `capabilities.videoInput` already exists in `open-sse/providers/capabilities.js`; preserve that vocabulary rather than adding public fields. Existing public builder may fill unspecified output limits from static capability table; this feature must not claim upstream output-token data exists.
- Boundaries deliberately unchanged: `buildOAuthResolver` shared 401/403 refresh/persist behavior; `resolveLiveModels` cache; public route schema/auth. Fixed Coding URL follows current gateway config; no existing Kimi catalog URL override was found.
- No application tests/build or application changes executed during planning. Structural plan validation is separate from implementation proof.
