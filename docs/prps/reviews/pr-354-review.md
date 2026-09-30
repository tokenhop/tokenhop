# PR Review #354 — fix(home): one primary, clickable recent requests, client-side links and one focus refresh

**Reviewed**: 2026-09-29
**Mode**: PR (parallel: correctness, security, quality)
**Author**: yandy-r
**Branch**: redesign/yan-404-home-polish → re-design
**Decision**: REQUEST CHANGES → fixed (17/20 Fixed; F013, F015, F020 Open by design)

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/yandy-r/9router/.config/opencode/worktrees/9router-redesign-yan-404-home-polish/ (branch: redesign/yan-404-home-polish)

## Summary

The scope is delivered and verified in the browser, and redaction, XSS and listener or memory bounds are all clean. One HIGH race in the new GET store: a superseded request can overwrite newer data, a regression from the old abort-based hook. The rest is DRY placement of the new link and value patterns, plus small correctness and doc nits.

## Findings

### HIGH

- **[F001]** `src/app/(dashboard)/dashboard/home/homeResourceStore.js:88` — When a request with a new key (refreshKey bump, focus refresh, poll) starts while an older one is in flight, both fetches run and the last to resolve writes `entry.data`/`entry.error`. An older response can therefore overwrite post-mutation data.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Commit results only while the request is current (`entry.inflight === request`, or a per-entry sequence). Add an out-of-order store test.

### MEDIUM

- **[F002]** `src/app/(dashboard)/dashboard/home/homeResourceStore.js:119` — `refreshStaleResources` skips entries with `subs.size === 0`. During a refreshKey bump the deferred-delete window briefly empties `subs`, so a focus event in that window misses the URL.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Also treat entries with a pending re-subscribe as watched. Simplest: skip only entries that were actually deleted (the microtask delete) and let the resubscribe path cover the rest.
- **[F003]** `src/app/(dashboard)/dashboard/home/RecentRequests.js:83` — If only `/api/usage/request-details` fails, the list silently falls back to static usage-stats rows with no error affordance.
  - **Status**: Fixed
  - **Category**: Completeness
  - **Suggested fix**: When fallback rows are shown because request details failed, show a short muted note that details are unavailable.
- **[F004]** `src/app/(dashboard)/dashboard/home/useHomeResource.js:43` — The poll key `poll:${Date.now()}` is unique per tick, so a hung poll never dedupes and requests stack.
  - **Status**: Fixed
  - **Category**: Performance
  - **Suggested fix**: Use a stable `{ key: "poll" }` so an in-flight poll is joined.
- **[F005]** `src/app/(dashboard)/dashboard/home/WidgetStates.js:19` — `CardLink` is a generic primitive living in a Home-only module. The handbook requires shared primitives under `src/shared/components/`.
  - **Status**: Fixed
  - **Category**: Pattern Compliance
  - **Suggested fix**: Move it to `src/shared/components/CardLink.js` with `className` and `showArrow` props.
- **[F006]** `src/app/(dashboard)/dashboard/home/LiveRoutes.js:399` — The RTL arrow span duplicates the `CardLink` body.
  - **Status**: Fixed
  - **Category**: Pattern Compliance
  - **Suggested fix**: Use `CardLink` with a `className` override.
- **[F007]** `src/app/(dashboard)/dashboard/home/EndpointHero.js:94` — The "Endpoint settings" link hand-copies the `CardLink` classes.
  - **Status**: Fixed
  - **Category**: Pattern Compliance
  - **Suggested fix**: Use `CardLink` with `showArrow={false}`.
- **[F008]** `src/app/(dashboard)/dashboard/home/EndpointHero.js:103` — The URL block reimplements the display half of `CopyField`.
  - **Status**: Fixed
  - **Category**: Pattern Compliance
  - **Suggested fix**: Add a `showCopyButton` prop to `CopyField` (default `true`) and use it here.
- **[F009]** `src/app/(dashboard)/dashboard/home/HomeHeader.js:57` — The in-page H1 classes duplicate `ProviderDetailHeader.js:52`.
  - **Status**: Fixed
  - **Category**: Pattern Compliance
  - **Suggested fix**: Extract a shared `PageTitle` used by Home and provider detail.

### LOW

- **[F010]** `src/app/(dashboard)/dashboard/home/RecentRequests.js:100` — Request-detail error rows have `status: "error"`, so the row shows lowercase "error" with no visible "Error" label.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Map "error" to "Error" and numeric codes to `Error <code>`.
- **[F011]** `src/app/(dashboard)/dashboard/home/useHomeResource.js:21` — Initial state forces `loading: true` even when the store already holds data.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Initialize from the snapshot and set loading only when there is no data.
- **[F012]** `src/app/(dashboard)/dashboard/home/RecentRequests.js:15` — The `normalizeRecentRequest` JSDoc omits `provider`.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Add `provider: string`.
- **[F013]** `src/app/(dashboard)/dashboard/home/RecentRequests.js:7` — The static drawer import grows the Home chunk.
  - **Status**: Open
  - **Category**: Performance
  - **Suggested fix**: Not applied, by design. The impact is single-digit KB gzipped (per the security reviewer), and a `next/dynamic` split would still statically pull the module for `providerLabel`. Revisit if Home route weight becomes a budget item.
- **[F014]** `src/app/(dashboard)/dashboard/home/RecentRequests.js:47` — Fallback rows without an id can produce duplicate React keys.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Append the list index for rows without an id.
- **[F015]** `src/app/(dashboard)/dashboard/home/KeysSummary.js:50` — Keys, Quota, Provider health and Combos still blank to an error state when a background refresh fails with stale data present. This matches pre-PR behaviour.
  - **Status**: Open
  - **Category**: Completeness
  - **Suggested fix**: Out of scope for YAN-404 (unchanged behaviour). Follow up if needed: render `WidgetError` only when there is no data.
- **[F016]** `src/app/(dashboard)/dashboard/home/RecentRequests.js:137` — The row-button bleed hard-codes `w-[calc(100%+1rem)]` against `px-2`.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Put the padding on the button inside a full-width row instead of using negative margins.
- **[F017]** `src/app/(dashboard)/dashboard/home/HomeHeader.js:17` — The component JSDoc doesn't mention the in-page H1.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Update the summary line.
- **[F018]** `src/app/(dashboard)/dashboard/home/homeResourceStore.js:116` — `refreshStaleResources` is exported but has no importers.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Make it module-private.
- **[F019]** `src/app/(dashboard)/dashboard/home/ProviderHealth.js:9` — The named-import order differs from the sibling files.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Match the sibling order (this goes away with the `CardLink` move).
- **[F020]** `src/app/(dashboard)/dashboard/home/WidgetStates.js:21` — Card header text links are about 18 px tall, below the 44 px hit-area rule. This pattern predates the PR.
  - **Status**: Open
  - **Category**: Pattern Compliance
  - **Suggested fix**: Deviation documented in the PR. Card header actions match the board's text-link style; changing header rhythm is out of scope.

## Validation Results

| Check      | Result                                    |
| ---------- | ----------------------------------------- |
| Type check | Skipped (plain JS, no tsconfig)           |
| Lint       | Pass                                      |
| Tests      | Pass (`npm test`: no regression, 0 known) |
| Build      | Pass                                      |

## Files Reviewed

- `public/i18n/literals/*.json` (Modified, 34)
- `src/app/(dashboard)/dashboard/home/homeResourceStore.js` (Added)
- `src/app/(dashboard)/dashboard/home/useHomeResource.js` (Modified)
- `src/app/(dashboard)/dashboard/home/useHomePollingResource.js` (Deleted)
- `src/app/(dashboard)/dashboard/home/{useHomeData,HomePageClient,HomeHeader,EndpointHero,KeysSummary,HomeStats,QuotaWatch,CombosTop,ProviderHealth,LiveRoutes,RecentRequests,WidgetStates}.js` (Modified)
- `src/app/(dashboard)/dashboard/usage/components/{RequestDetailDrawer,RequestLog}.js` (Modified)
- `src/shared/components/Header.js` (Modified)
- `tests/unit/home-resource-store.test.js` (Added)
- `docs/prps/plans/yan-404-home-polish.plan.md` (Added)
