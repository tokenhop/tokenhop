# PR Review #357 — perf(usage): lighter live stream, stat-tile trends and a consistent request log

**Reviewed**: 2026-09-29
**Mode**: PR (parallel: correctness, security/performance, quality reviewers)
**Author**: yandy-r
**Branch**: redesign/yan-407-usage-polish → re-design
**Decision**: REQUEST CHANGES → findings resolved in the fix commit (see Status)

## Summary

No security regressions. Both routes stay behind the deny-by-default `/api/*` guard, `period`/`compare` are allowlisted, the SQL is parameterized and indexed, and the slim payload stops broadcasting account names/emails. The findings covered data freshness and re-render churn in the new stream/stats split, one stale-sparkline bug, an alias precedence mismatch in the totals SQL, and some duplication and dead code.

## Findings

### HIGH

- **[F001]** `src/app/(dashboard)/dashboard/usage/lib/useChartBuckets.js:13` — Buckets were never cleared on a period switch, so tiles painted the previous period's sparkline, permanently if the new chart fetch failed.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Track `bucketsPeriod` (set on success only). The page passes buckets to tiles only when it matches, and the chart shows its skeleton during the switch.

### MEDIUM

- **[F002]** `src/lib/usage/livePayload.js:20` — Provider ids were clipped before aggregation, so distinct long ids merged and topology highlighting broke.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Aggregate on the full id and clip (to 40 chars) only when emitting. Worst case is 1,865 B.
- **[F003]** `src/lib/db/repos/usageRepo.js:1020` — The `COALESCE` alias fallback treated a present-but-zero `prompt_tokens`/`cached_tokens` as final, unlike the JS `||` convention.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: `NULLIF(json_extract(...), 0)` on the primary alias. Covered by a test row.
- **[F004]** `src/app/(dashboard)/dashboard/usage/lib/useUsageStats.js:104` — The EventSource had no `onerror`/`onopen`, so after a reconnect the tiles froze while the topology looked live.
  - **Status**: Fixed
  - **Category**: Completeness
  - **Suggested fix**: Warn once per disconnect. `onopen` after an error dispatches a new `reconnected` reducer action, which triggers one catch-up.
- **[F005]** `src/app/(dashboard)/dashboard/usage/lib/useUsageStats.js:110` — Every stream frame re-rendered the tiles, chart and breakdown (up to ~11/s).
  - **Status**: Fixed
  - **Category**: Performance
  - **Suggested fix**: Skip identical frames (`sameLive`), and `memo` UsageStatsCards, UsageBreakdown and UsageTokensChart.
- **[F006]** `src/app/(dashboard)/dashboard/usage/page.js:65` — A visibility catch-up refreshed the stats but not the chart or sparklines.
  - **Status**: Fixed
  - **Category**: Performance
  - **Suggested fix**: `catchUpKey` from useUsageStats feeds `useChartBuckets(…, refreshKey)` as a background refresh.
- **[F007]** `src/app/(dashboard)/dashboard/usage/lib/tileTrends.js:32` — `trendDelta` duplicated delta math; `usageShapes.periodDelta` was dead.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: `trendDelta` reuses the shared `commandCenter.periodDelta`. The dead `usageShapes.periodDelta` and its tests are removed.
- **[F008]** `src/lib/db/repos/usageRepo.js:243` — `getActiveRequests` built the full recent ring and connection map per frame for one string.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: A new `getLiveSnapshot()` (pending counts + an end-scan of the ring). `getActiveRequests` and its connection cache are deleted (no other callers).
- **[F009]** `public/i18n/literals/*.json` — The sentence-case renames orphaned "Reset to Defaults", "Pricing Rates Format" and "Cache Creation".
  - **Status**: Fixed
  - **Category**: i18n
  - **Suggested fix**: Delete them from all locales (74 entries).
- **[F010]** `src/app/(dashboard)/dashboard/usage/lib/useChartBuckets.js:22` — A third copy of the abort/loading/error/retry fetch skeleton.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: Accepted as the cap for this PR; extract a shared `useJsonFetch` if a fourth appears.

### LOW

- **[F011]** `src/app/(dashboard)/dashboard/usage/lib/useUsageStats.js:37` — A hidden-tab mount opened a doomed EventSource.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Init the reducer from `document.hidden` (client only).
- **[F012]** `src/app/(dashboard)/dashboard/usage/components/RequestLog.js:119` — An in-flight fetch for a now-invalid range still landed.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Abort before returning.
- **[F013]** `src/app/api/usage/stream/route.js:13` — `cleanup()` didn't close the controller or remove the abort listener, and stalled clients were never reaped.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Close in cleanup, remove the listener, and reap after 3 backed-up sends.
- **[F014]** `src/lib/usage/livePayload.js:19` — Null entries threw.
  - **Status**: Fixed
  - **Category**: Type Safety
  - **Suggested fix**: `item || {}` guard, with a test.
- **[F015]** `src/app/(dashboard)/dashboard/usage/page.js:152` — The Breakdown rendered the previous period's stats during a switch.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Gate on `statsPeriod === period`.
- **[F016]** `src/app/(dashboard)/dashboard/usage/page.js:61` — Quiet loads fired, then aborted, a chart fetch.
  - **Status**: Fixed
  - **Category**: Performance
  - **Suggested fix**: Enable only when stats for the period are loaded and not quiet.
- **[F017]** `src/shared/components/StatTile.js:47` — O(n²) min/max inside the points map.
  - **Status**: Fixed
  - **Category**: Performance
  - **Suggested fix**: Hoist min/max; share the line markup helper.
- **[F018]** `src/app/api/usage/stats/route.js:30` — The two aggregates were awaited sequentially.
  - **Status**: Fixed
  - **Category**: Performance
  - **Suggested fix**: `Promise.all`.
- **[F019]** `src/app/(dashboard)/dashboard/usage/components/RequestLog.js:58` — The providers/nodes fetch wasn't aborted on unmount.
  - **Status**: Fixed
  - **Category**: Performance
  - **Suggested fix**: AbortController.
- **[F020]** `src/app/(dashboard)/dashboard/usage/components/RequestLog.js:29` — `rowDomId` could collide.
  - **Status**: Fixed
  - **Category**: Accessibility
  - **Suggested fix**: Collapse character runs and add a row index suffix.
- **[F021]** `src/app/(dashboard)/dashboard/usage/components/UsageTokensChart.js:25` — Loose `PropTypes.array` and a JSDoc/PropTypes mismatch; rows keyed by label.
  - **Status**: Fixed
  - **Category**: Type Safety
  - **Suggested fix**: A precise bucket shape and `${label}-${i}` keys.
- **[F022]** `tests/unit/usage-live-stream.test.js:1926` — A source-text assertion.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Replace it with a mocked `getLiveSnapshot` behavioral test.
- **[F023]** `src/lib/usage/livePayload.js:2` — The shipped payload deviated from the plan contract.
  - **Status**: Fixed
  - **Category**: Completeness
  - **Suggested fix**: An "As shipped" note at the plan's Contracts.
- **[F024]** `src/app/(dashboard)/dashboard/usage/components/UsageStatsCards.js:38` — Trend up/down uses ok/err colors.
  - **Status**: Open
  - **Category**: Pattern Compliance
  - **Suggested fix**: Kept deliberately: the board shows `+8%` in ok-green, Home's `deltaLine` sets the precedent, and the sign means color is never the only cue.
- **[F025]** `src/app/(dashboard)/dashboard/usage/components/UsageStatsCards.js:9` — Formatters duplicated with UsageBreakdown.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: Pre-existing; extract to `usage/lib/format.js` in a follow-up.
- **[F026]** `src/app/api/usage/stream/route.js` — Repo-wide slow growth for many long-lived SSE tabs.
  - **Status**: Fixed
  - **Category**: Performance
  - **Suggested fix**: Covered by the F013 reaping.

## Validation Results

| Check      | Result             |
| ---------- | ------------------ |
| Type check | Skipped (plain JS) |
| Lint       | Pass               |
| Tests      | Pass               |
| Build      | Pass               |

## Files Reviewed

- `src/lib/usage/livePayload.js` (Added)
- `src/app/api/usage/stream/route.js`, `src/app/api/usage/stats/route.js` (Modified)
- `src/lib/db/repos/usageRepo.js`, `src/lib/db/index.js`, `src/lib/usageDb.js`, `src/shared/utils/period.js` (Modified)
- `src/app/(dashboard)/dashboard/usage/lib/{streamLifecycle,tileTrends,useChartBuckets}.js` (Added)
- `src/app/(dashboard)/dashboard/usage/lib/{useUsageStats,usageShapes}.js`, `page.js`, `components/*` (Modified)
- `src/shared/components/{StatTile,Select,displayPrimitives,PricingModal}.js` (Modified)
- `public/i18n/literals/*.json`, `src/app/fonts/*` (Modified)
- `tests/unit/usage-live-stream.test.js`, `tests/unit/usage-trends.test.js` (Added); `signal-display-primitives`, `usage-shapes` tests (Modified)
