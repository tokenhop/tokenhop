# PR Review #611 — feat(usage): unify period windows and support 24h/60d on every usage endpoint

**Reviewed**: 2026-10-02
**Mode**: PR
**Author**: yandy-r
**Branch**: feat/yan-428-unify-usage-periods → master
**Decision**: REQUEST CHANGES (F001–F006 fixed in follow-up commit; F007/F008 intentionally left as-is)

## Summary

The windows are right and nothing is left over: no importer of a removed export remains, chart and stats behave exactly as before, and the current and previous windows meet without a gap or a double count. Allowing 60d makes the savings scan's pricing lookup per row more costly, and the Token saver fallback has a few performance and copy problems.

## Findings

### HIGH

- **[F001]** `src/lib/db/repos/usageRepo.js:1190` — `getUsageSavings` awaits `savedTokensCost` for each savings row, and every call reads the pricing again from SQLite with no cache. A 60d window doubles the number of rows scanned.
  - **Status**: Fixed
  - **Category**: Performance
  - **Suggested fix**: Cache the pricing for each provider/model pair inside a single `getUsageSavings` call.

### MEDIUM

- **[F002]** `src/app/(dashboard)/dashboard/token-saver/useSavingsWithFallback.js:54-55` — A quiet `today` now sends 4 parallel savings requests. The windows are nested, so when 60d is empty every smaller period is empty too.
  - **Status**: Fixed
  - **Category**: Performance
  - **Suggested fix**: Fetch the largest candidate first. If it is empty, set `neverSaved` and stop; only fetch the smaller candidates when it has savings.
- **[F003]** `src/app/(dashboard)/dashboard/token-saver/useSavingsWithFallback.js:54-64` — When 60d is selected there are no candidates, so `neverSaved` becomes true without any check and the page says "No savings recorded yet".
  - **Status**: Fixed
  - **Category**: Completeness
  - **Suggested fix**: `neverSaved: candidates.length > 0 && hit < 0 && !failed`.
- **[F004]** `src/lib/db/repos/usageRepo.js:1344-1353` — `previousRequests` uses `getUsageTotals` (a COUNT plus 4 SUMs with `json_extract`) but only reads `.requests`.
  - **Status**: Fixed
  - **Category**: Performance
  - **Suggested fix**: Use a half-open `COUNT(*)` for the previous window.
- **[F005]** `tests/unit/home-savings.test.js:265-290` — The new DB test runs `DELETE FROM usageHistory` partway through a describe whose earlier tests add rows to the same table, so the tests depend on their order.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Move it into its own `describe` with its own temp `DATA_DIR`.

### LOW

- **[F006]** `src/shared/utils/period.js:40` — The `coercePeriod` doc still says "(24h→7d, 60d→30d on summary pages)", but no page uses a subset any more.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Drop "on summary pages".
- **[F007]** `src/lib/db/repos/usageRepo.js:1338` vs `:1088` — The current window includes `now` (`<=`), but the previous window uses a half-open range.
  - **Status**: Open
  - **Category**: Maintainability
  - **Suggested fix**: Keep both as they are. Including `now` keeps a row written in the same millisecond, and the windows meet with no overlap (confirmed by the correctness review).
- **[F008]** `src/lib/db/repos/usageRepo.js:1026` — `PERIOD_DAYS[period]` is `undefined` for an invalid period. `master` behaves the same way, and the routes validate the period first.
  - **Status**: Open
  - **Category**: Correctness
  - **Suggested fix**: None needed, because the route validates first.

## Validation Results

| Check      | Result                |
| ---------- | --------------------- |
| Type check | Skipped (JS project)  |
| Lint       | Pass                  |
| Tests      | Pass (no regressions) |
| Build      | Pass                  |

## Files Reviewed

- `src/shared/utils/period.js` (Modified)
- `src/lib/db/repos/usageRepo.js` (Modified)
- `src/lib/home/savings.js` (Modified)
- `src/lib/home/summary.js` (Modified)
- `src/app/api/usage/stats/route.js` (Modified)
- `src/app/api/usage/chart/route.js` (Modified)
- `src/app/api/usage/savings/route.js` (Modified)
- `src/app/api/home/summary/route.js` (Modified)
- `src/app/(dashboard)/dashboard/home/HomeHeader.js` (Modified)
- `src/app/(dashboard)/dashboard/home/HomePageClient.js` (Modified)
- `src/app/(dashboard)/dashboard/home/HomeStats.js` (Modified)
- `src/app/(dashboard)/dashboard/home/useHomeData.js` (Modified)
- `src/app/(dashboard)/dashboard/token-saver/SavingsHero.js` (Modified)
- `src/app/(dashboard)/dashboard/token-saver/TokenSaverPageClient.js` (Modified)
- `src/app/(dashboard)/dashboard/token-saver/useSavingsWithFallback.js` (Modified)
- `tests/unit/home-savings.test.js` (Modified)
- `tests/unit/period.test.js` (Modified)
- `docs/prps/plans/yan-428-unify-usage-periods.plan.md` (Added)
