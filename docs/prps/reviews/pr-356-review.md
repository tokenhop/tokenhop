# PR Review #356 — feat(dashboard): shared period control and smart quiet-period empty states

**Reviewed**: 2026-09-29
**Mode**: PR (parallel: correctness, security, quality reviewers)
**Author**: yandy-r
**Branch**: redesign/yan-397-period-control → re-design
**Decision**: REQUEST CHANGES → all findings resolved in the fix commit (see Status)

## Summary

No security issues. The new route is covered by the deny-by-default `/api/*` guard, takes no input, and uses the `idx_uh_ts` index. `?period` and localStorage values are validated on the client and the server. The failure paths needed work: a failed last-activity fetch left a permanent skeleton, Home could briefly show a mislabeled quiet row during a period switch, and two literals were invisible to the i18n extractor.

## Findings

### HIGH

- **[F001]** `src/shared/hooks/useLastActivity.js:31` — A last-activity fetch error was swallowed; `QuietPeriod` rendered its skeleton forever, and on Home that replaced the whole stats row.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Expose `error` and `retry`, and have `QuietPeriod` render the quiet title with "Couldn't load the last request time." and a Retry button.
- **[F002]** `src/app/(dashboard)/dashboard/token-saver/SavingsHero.js:211` — A ternary in the `title` attribute is invisible to the i18n extractor; "No savings in this period" was in 0 of 34 locales.
  - **Status**: Fixed
  - **Category**: i18n
  - **Suggested fix**: Move both titles into an extractor-visible `EMPTY_COPY` map and add the locale entries.

### MEDIUM

- **[F003]** `src/app/(dashboard)/dashboard/home/HomePageClient.js:71` — `quiet` did not check that the stats payload belongs to the selected period, so one frame showed a mislabeled "Quiet in the last 7d" and started a stray last-activity fetch.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: `useHomeUsage` returns `currentPeriod`, and `quiet` requires `currentPeriod === period && !loading`.
- **[F004]** `src/app/(dashboard)/dashboard/usage/page.js:50` — Last activity was refetched on every quiet→quiet period switch, even though the value doesn't depend on the period.
  - **Status**: Fixed
  - **Category**: Performance
  - **Suggested fix**: `useLastActivity` fetches once, then reuses the value (retry only after an error).
- **[F005]** `src/app/(dashboard)/dashboard/token-saver/useSavingsWithFallback.js:58` — The fallback chain ran serially without an AbortSignal, so hero paint waited on up to 3 heavy queries and in-flight requests leaked on a period change.
  - **Status**: Fixed
  - **Category**: Performance
  - **Suggested fix**: Fetch the larger periods with `Promise.allSettled`, pick the smallest non-empty one, and abort all requests in cleanup.
- **[F006]** `src/app/(dashboard)/dashboard/token-saver/SavingsHero.js:190` / `src/shared/components/QuietPeriod.js:94` — The `??` default literals ("Saved in this period", "Quiet in this period") were invisible to the extractor.
  - **Status**: Fixed
  - **Category**: i18n
  - **Suggested fix**: Add `default` entries to the keyed copy maps and translate them.
- **[F007]** `src/app/(dashboard)/dashboard/token-saver/SavingsHero.js:199` — The fallback hero's heading and "None today" note looked like a sentence built from fragments.
  - **Status**: Fixed
  - **Category**: i18n
  - **Suggested fix**: Both are standalone phrases in separate elements (heading and caption), not joined into a sentence. Documented in the copy-map JSDoc.

### LOW

- **[F008]** `src/shared/utils/period.js:108` — `periodStart` subtracted 24 h multiples, so a DST change moved the start off local midnight.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Use calendar `setDate` math. A regression test runs under `TZ=America/New_York`.
- **[F009]** `src/shared/hooks/usePeriod.js:43` — A non-canonical `?period` (60d on a subset page, or `bogus`) was never rewritten.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Also skip the early return when the URL value differs from the canonical one.
- **[F010]** `src/app/(dashboard)/dashboard/token-saver/SavingsHero.js:27` — `periodOptions(SUMMARY_PERIODS)` built a new array on every render.
  - **Status**: Fixed
  - **Category**: Performance
  - **Suggested fix**: Hoist it to a module constant `SAVINGS_OPTIONS`.
- **[F011]** `src/app/fonts/material-symbols-glyphs.json:80` — "eyebrow" and "note" glyphs were shipped because the icon scanner matched backticked JSDoc words.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Reword the JSDoc and re-run `node scripts/icons-subset.mjs` (subset is back to 266 icons).
- **[F012]** `src/shared/utils/period.js:85` — `DAY_COUNTS` had dead `today`/`24h` keys.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Delete them.
- **[F013]** `src/shared/components/QuietPeriod.js:86` — The jump logic assumed `allowed` is in ascending order.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Canonicalize with `PERIOD_VALUES.filter(...)` before matching.
- **[F014]** `src/shared/utils/period.js:22` — `SUMMARY_PERIODS` and the server's `SAVINGS_PERIODS` are hand-synced copies.
  - **Status**: Fixed
  - **Category**: Pattern Compliance
  - **Suggested fix**: Cross-referencing comments in both places. YAN-428 unifies them.
- **[F015]** `src/lib/db/repos/usageRepo.js:511` — The `last10Minutes` query still runs even though nothing reads it now.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: Kept deliberately to preserve the `/api/usage/stats` payload contract. Drop it with the YAN-407 stream work.
- **[F016]** `src/app/(dashboard)/dashboard/home/HomePageClient.js:103` — A never-used install also shows the pre-existing "No recent requests" card next to "No traffic yet".
  - **Status**: Open
  - **Category**: Completeness
  - **Suggested fix**: Out of scope (the Recent requests card isn't in YAN-397's Home scope, which is the stats row only). It is a different widget, so it isn't a duplicate of the same empty state.

## Validation Results

| Check      | Result             |
| ---------- | ------------------ |
| Type check | Skipped (plain JS) |
| Lint       | Pass               |
| Tests      | Pass               |
| Build      | Pass               |

## Files Reviewed

- `src/shared/utils/period.js` (Added)
- `src/shared/hooks/usePeriod.js` (Added)
- `src/shared/hooks/useLastActivity.js` (Added)
- `src/shared/hooks/useEndpointShell.js` (Added, moved)
- `src/shared/components/PeriodControl.js` (Added)
- `src/shared/components/QuietPeriod.js` (Added)
- `src/shared/components/EmptyState.js` (Modified)
- `src/app/api/usage/last-activity/route.js` (Added)
- `src/lib/db/repos/usageRepo.js`, `src/lib/db/index.js`, `src/lib/usageDb.js` (Modified)
- Home, Usage and Token saver pages/components (Modified)
- `public/i18n/literals/*.json`, `src/app/fonts/*` (Modified)
- `tests/unit/period.test.js`, `tests/unit/usage-last-activity.test.js` (Added); `usage-chart`, `usage-shapes` tests (Modified)
