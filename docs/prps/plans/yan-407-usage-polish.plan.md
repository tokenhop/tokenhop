# Plan: YAN-407 lighter live stream, stat-tile trends and a consistent request log

## Summary

Put the Usage live stream on a diet: it sends only the live fields the page renders, computed without scanning history, sends each update once, and closes on hidden tabs and the Request log tab, resuming with one catch-up fetch. Give each Usage stat tile a sparkline for the selected period and a delta against the previous equal period. Move the request log onto the shared form, table-header and state primitives, with logical alignment and keyboard-reachable rows.

## User Story

As a 9router operator watching Usage, I want the page to stay light and quiet in the background, show at a glance whether usage is trending up or down, and have a request log that looks and behaves like the rest of the app (including RTL and keyboard), so I can trust and navigate it quickly.

## Problem → Solution

- **Stream:** every update recomputes all-time stats and sends the whole object twice. The client keeps 4 fields; the stream stays open when hidden or on the logs tab; every message re-sorts the breakdown. → A slim payload `{activeRequests, lastProvider, errorProvider}` from the in-memory tracker, one message per event, a lifecycle reducer, and live fields held in their own state.
- **Tiles:** a bare number. → A sparkline from the chart buckets (one shared fetch with the chart) plus "+12% vs prior 7d" from a cheap previous-window totals query.
- **Request log:** raw inputs, Title Case, mismatched headers, physical alignment, plain "Loading…". → Shared `Select`/`Input`, one `TABLE_HEAD` style in `displayPrimitives`, `text-start`/`text-end`, shared Loading/Error/Empty views, and a model-named row button that opens the drawer.

## Metadata

- **Complexity**: Large
- **Source PRD**: N/A (Linear YAN-407, GitHub #318)
- **PRD Phase**: N/A
- **Estimated Files**: ~20

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/yandy-r/9router/.config/opencode/worktrees/9router-redesign-yan-407-usage-polish/ (branch: redesign/yan-407-usage-polish, base origin/re-design)

## Batches

| Batch | Tasks         | Depends on            |
| ----- | ------------- | --------------------- |
| B1    | 1.1, 1.2, 1.3 | none (disjoint files) |
| B2    | 2.1           | B1                    |

---

## UX Design

### Before

```text
Tiles: Requests 18,902 · "In this period" (no trend, no sparkline)
Chart: its own fetch + plain "Loading…"
Request log: raw <select>/<input datetime-local>, "Start Date / End Date / Clear Filters",
  header with no style, text-left/right, spinner + "Loading…", fetch errors only logged,
  identical "Detail" buttons on every row
SSE: ~3 messages of the full stats object per gateway request, forever, even on hidden tabs
```

### After

```text
Tiles: Requests 18,902 · "+8% vs prior 7d" (ok/err colored) · sparkline (tile accent color)
       Input/Cached/Output/Cost keep their context line; the delta is added as a second line
Chart: shares the page's chart fetch; skeleton + ErrorState with Retry
Request log: Select "Provider" (All providers) · Input "From" / "To" (datetime-local) with a
  from ≤ to check · "Clear filters"; TABLE_HEAD header; text-start/end; LoadingState/ErrorState
  (Retry)/EmptyState; row button "View details for <model>, <time>"
SSE: ≤ 1 message (~150 B) per event, closed when hidden or on the Request log tab
```

### Interaction Changes

| Touchpoint            | Before       | After                   | Notes                                                |
| --------------------- | ------------ | ----------------------- | ---------------------------------------------------- |
| Hidden tab / logs tab | stream open  | stream closed           | resumes with one catch-up fetch of stats             |
| Tile delta            | none         | "+x% vs prior <period>" | neutral "No prior data" when the previous total is 0 |
| Filter change         | page kept    | page reset to 1         | fixes the empty-page bug                             |
| Request log error     | console only | ErrorState + Retry      |                                                      |

---

## Mandatory Reading

| Priority | File                                                                            | Lines                     | Why                                           |
| -------- | ------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------- |
| P0       | `src/app/api/usage/stream/route.js`                                             | all                       | Rewrite target                                |
| P0       | `src/lib/db/repos/usageRepo.js`                                                 | 130-290, 420-560, 700-860 | `getActiveRequests`, live fields, totals math |
| P0       | `src/app/(dashboard)/dashboard/usage/lib/useUsageStats.js`                      | all                       | Client stream + stats                         |
| P0       | `src/app/(dashboard)/dashboard/usage/page.js`                                   | all                       | Page wiring                                   |
| P0       | `src/app/(dashboard)/dashboard/usage/components/RequestLog.js`                  | all                       | Rewrite target                                |
| P1       | `src/app/(dashboard)/dashboard/console-log/useConsoleStream.js`                 | 30-70                     | Visibility close/reopen pattern               |
| P1       | `src/shared/utils/consoleLog.js`                                                | 149-164                   | Pure connection reducer pattern               |
| P1       | `src/app/(dashboard)/dashboard/home/HomeStats.js`                               | 1-60                      | Sparkline + delta pattern                     |
| P1       | `src/shared/components/{StatTile,Select,Input,StateViews,displayPrimitives}.js` | all                       | Primitives                                    |
| P2       | `docs/redesign/boards/project/Usage.dc.html` (main checkout)                    | 135-145                   | Tile design                                   |

## External Documentation

No external research needed; everything uses existing internal patterns.

---

## Patterns to Mirror

### NAMING_CONVENTION

Pure helpers live in non-JSX modules so node tests can import them (`src/shared/utils/consoleLog.js`, `src/shared/utils/period.js`). Hooks go in `usage/lib/use*.js`. Copy maps use extractor-visible keys (`label`, `caption`, `title`, `emptyTitle`).

### ERROR_HANDLING

```js
// src/app/api/usage/savings/route.js
} catch (error) {
  console.error("[API] Failed to get usage savings:", error);
  return NextResponse.json({ error: "Failed to fetch savings" }, { status: 500 });
}
```

The client checks `res.ok` and shows `ErrorState` with Retry; errors are never only logged.

### LOGGING_PATTERN

`console.error("[API] …:", error)` in routes and `console.error("[usageRepo] …", e.message)` in the repo.

### REPOSITORY_PATTERN

```js
const db = await getAdapter();
const rows = db.all(`SELECT data FROM usageDaily WHERE dateKey >= ? AND dateKey <= ?`, [from, to]);
```

### SERVICE_PATTERN

```js
// console-log/useConsoleStream.js — visibility-driven EventSource
if (document.hidden) {
  streamRef.current?.close();
  dispatchConnection({ type: "hidden" });
}
```

### TEST_STRUCTURE

```js
// tests/unit/usage-last-activity.test.js — DB-backed route test
const { GET } = await import("../../src/app/api/usage/last-activity/route.js");
const res = await GET(new Request("http://localhost/api/usage/last-activity"));
```

Pure reducer tests follow `tests/unit/console-log.test.js`. The node env has no DOM.

---

## Contracts (all tasks code against these; do not deviate)

**`src/lib/usage/livePayload.js`** (pure, new):

- `export const LIVE_ACTIVE_CAP = 12`
- `export function buildLivePayload({ activeRequests = [], recentRequests = [], errorProvider = "" })` returns `{ activeRequests: activeRequests.slice(0, LIVE_ACTIVE_CAP).map(({model, provider, account, count}) => ({model, provider, account, count})), lastProvider: recentRequests[0]?.provider || "", errorProvider: errorProvider || "" }`. Deterministic; no DB.

**`/api/usage/stream`**: on connect it sends one message, `buildLivePayload(await getActiveRequests())`. On each `pending` or `update` event it sends one message with the same builder. It never calls `getUsageStats`. It keeps the 25 s heartbeat and removes listeners on cancel and on `request.signal` abort. Payload shape: `{ activeRequests, lastProvider, errorProvider }` (breaking change is acceptable: the only consumer is `useUsageStats`).

**`src/app/(dashboard)/dashboard/usage/lib/streamLifecycle.js`** (pure, new):

- `export function streamReducer(state, action)` over state `{ open: boolean, needsCatchUp: boolean }`, with actions `{type:"visibility", hidden}` and `{type:"tab", tab}` (`"overview"` or `"logs"`). The stream should be open iff `!hidden && tab === "overview"`. Going from closed to open sets `needsCatchUp: true`; `{type:"caughtUp"}` clears it. The reducer keeps the latest `hidden` and `tab`. An unknown action throws. Initial state: `initialStreamState({hidden, tab})` returns `{hidden, tab, open, needsCatchUp:false}`.

**`useUsageStats(period, { tab })`**: REST owns `stats` (identity changes only when period data is fetched). The stream owns `live = { activeRequests: [], lastProvider: "", errorProvider: "" }` in separate state. The stream is opened or closed from the reducer (visibility + tab). On `needsCatchUp` it re-fetches `/api/usage/stats?period=` once, then dispatches `caughtUp`. Returns `{ stats, statsPeriod, live, loading, fetching, error }`. The page passes `live.*` to `UsageTopology` and no longer reads `stats.activeRequests`/`recentRequests`/`errorProvider`.

**Previous-period totals**:

- `usageRepo.getUsageTotals({ start, end })` (ms) returns `{ requests, promptTokens, completionTokens, cachedTokens, cost }` from a single `usageHistory` range scan over `timestamp >= ? AND timestamp < ?` (reads the promptTokens/completionTokens/cost columns and `json_extract(tokens,'$.cached_tokens')` or the JS-parsed `tokens`). Export it via `src/lib/db/index.js` and `src/lib/usageDb.js`.
- `src/shared/utils/period.js`: add `export function previousPeriodRange(period, now = Date.now())` returning `{ start, end }` for the window of equal length immediately before the current one:
  - today: `[midnight − 24h, midnight − 24h + elapsed)`, i.e. the same time slice yesterday (matches the "vs same time yesterday" copy)
  - 24h: `[now − 48h, now − 24h)`
  - 7d/30d/60d: `[periodStart − (now − periodStart), periodStart)`
- `/api/usage/stats?compare=previous` adds `previous` and `currentTotals` (both `{requests, promptTokens, completionTokens, cachedTokens, cost}` from `getUsageTotals`, so both windows use the same source) to the response. It is additive and backward compatible; without the param the response is unchanged. `compare` is validated: only `previous` is allowed, anything else returns 400.

**Tile trends** (`src/app/(dashboard)/dashboard/usage/lib/tileTrends.js`, pure, new):

- `export const PRIOR_LABELS = { today: {caption:"vs same time yesterday"}, "24h": {caption:"vs prior 24h"}, "7d": {caption:"vs prior 7d"}, "30d": {caption:"vs prior 30d"}, "60d": {caption:"vs prior 60d"}, default: {caption:"vs prior period"} }`, plus `NO_PRIOR = { caption: "No prior data" }`. The copy must be extractor-visible (keyed `caption`).
- `export function trendDelta(current, previous)` (current and previous both come from `currentTotals`/`previous`) returns `{ kind: "none" }` when either value is not finite or previous ≤ 0, else `{ kind: "up"|"down"|"flat", pct }`, where pct is an integer (rounded) and flat means pct === 0.
- `export function bucketSeries(buckets, field)` returns `number[]|undefined`: the values of `field` from buckets, or undefined when there are fewer than 2 buckets.
- Tile → field: Requests→`requests`, Input→`input`, Cached→`cached`, Output→`output`, Est. cost→`cost`.

**Tiles UI**: every StatTile keeps its existing context line and adds a trend line: `<span class="font-semibold text-ok|text-err">+8%</span> <span class="text-muted">vs prior 7d</span>`, or muted "No prior data" for kind none. "Flat" renders `0%` in muted. The sparkline goes in the StatTile `sparkline` prop; its color comes from the tile `className` text color (Requests `text-sky`… mirror the value accents: input sky, cached lime-ink, output coral-ink, cost and requests `text-muted`). StatTile gets an optional `trend` node prop rendered under `delta` (keeps both lines). Document it with PropTypes.

**Shared chart data**: `usage/lib/useChartBuckets.js`: `useChartBuckets(period, enabled)` returns `{ buckets, loading, error, retry }` and fetches `/api/usage/chart?period=` with abort. The page calls it once and passes it to `UsageStatsCards` (sparklines) and `UsageTokensChart` (props `buckets`, `loading`, `error`, `onRetry`; the inner component no longer fetches).

**Table header primitive** (`src/shared/components/displayPrimitives.js`):

- `export const TABLE_HEAD_ROW = "border-b border-line"` and `export const TABLE_HEAD_CELL = "whitespace-nowrap text-xs font-semibold text-muted"` (board style: 12px, 600, muted, no uppercase, no background). Cell padding stays on each table. Numeric columns add `text-end`, others `text-start`.
- Apply to RequestLog, UsageBreakdown (drop `bg-raised/30 uppercase`) and PricingModal (drop `bg-line/40 uppercase`). Add one assertion to `tests/unit/signal-display-primitives.test.js`.

**Request log**:

- `Select` gains an optional `placeholder={null}` mode that omits the disabled placeholder option (backward compatible: the default is unchanged). The provider filter uses `Select label="Provider"` with options `[{value:"", label:"All providers"}, ...providers]`.
- Date range: two `Input type="datetime-local"` labeled "From" and "To", in a `fieldset` whose `legend` is "Date range" (visually small label). Client validation: when both are set and from > to, show the `error` "Start must be before end" on To and don't fetch. The button reads "Clear filters".
- A filter change resets page to 1. The fetch checks `res.ok`; on failure show `ErrorState` with Retry. Loading uses `LoadingState label="Loading requests"`. Empty uses the existing EmptyState copy.
- The row button shows a visible "Details" label and uses `aria-describedby` pointing at the row's model and timestamp cells (per-row ids), so screen readers hear which request it opens without building a translated sentence. The "Action" header becomes "Actions" in a `sr-only` span.
- Logical alignment everywhere (`text-start`/`text-end`).
- `UsageTokensChartInner`: loading uses `LoadingState label="Loading chart"`; errors use `ErrorState` with Retry (`onRetry`).
- `PricingModal`: "Loading pricing data..." becomes `LoadingState`, and the Title Case copy it contains becomes sentence case. Check that each changed literal exists in `public/i18n/literals` (add translations for changed or new ones).

---

## Files to Change

| File                                                                         | Action | Justification                                                                |
| ---------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------- |
| `src/lib/usage/livePayload.js`                                               | CREATE | Pure slim payload builder                                                    |
| `src/app/api/usage/stream/route.js`                                          | UPDATE | Stream diet                                                                  |
| `src/lib/db/repos/usageRepo.js`                                              | UPDATE | `getUsageTotals`                                                             |
| `src/lib/db/index.js`, `src/lib/usageDb.js`                                  | UPDATE | Export `getUsageTotals`                                                      |
| `src/app/api/usage/stats/route.js`                                           | UPDATE | `compare=previous`                                                           |
| `src/shared/utils/period.js`                                                 | UPDATE | `previousPeriodRange`                                                        |
| `src/app/(dashboard)/dashboard/usage/lib/streamLifecycle.js`                 | CREATE | Lifecycle reducer                                                            |
| `src/app/(dashboard)/dashboard/usage/lib/useUsageStats.js`                   | UPDATE | Separate live state, lifecycle, catch-up, compare                            |
| `src/app/(dashboard)/dashboard/usage/lib/useChartBuckets.js`                 | CREATE | Shared chart fetch                                                           |
| `src/app/(dashboard)/dashboard/usage/lib/tileTrends.js`                      | CREATE | Delta + series helpers                                                       |
| `src/app/(dashboard)/dashboard/usage/page.js`                                | UPDATE | Wiring                                                                       |
| `src/app/(dashboard)/dashboard/usage/components/UsageStatsCards.js`          | UPDATE | Trends + sparklines                                                          |
| `src/app/(dashboard)/dashboard/usage/components/UsageTokensChart{,Inner}.js` | UPDATE | Props instead of fetch; shared states                                        |
| `src/app/(dashboard)/dashboard/usage/components/RequestLog.js`               | UPDATE | Shared primitives                                                            |
| `src/app/(dashboard)/dashboard/usage/components/UsageBreakdown.js`           | UPDATE | Table header                                                                 |
| `src/shared/components/{StatTile,Select,displayPrimitives,PricingModal}.js`  | UPDATE | Primitives                                                                   |
| `public/i18n/literals/*.json`                                                | UPDATE | New or changed copy                                                          |
| `tests/unit/usage-live-stream.test.js`                                       | CREATE | Payload builder + route + reducer                                            |
| `tests/unit/usage-trends.test.js`                                            | CREATE | previousPeriodRange, getUsageTotals, trendDelta, bucketSeries, compare route |
| `tests/unit/signal-display-primitives.test.js`                               | UPDATE | Table header constants                                                       |

## NOT Building

- Comparisons for other pages or a chart overlay of the previous period (YAN-429).
- Server-side status or model filters in the request log (the API supports them, but they're out of scope).
- Replay/cURL work in the drawer.
- Changes to the routes map (YAN-406) or the period logic (YAN-397).

---

## Step-by-Step Tasks

### Task 1.1: Stream diet (server + client lifecycle)

- **BATCH**: B1
- **Depends on**: none
- **ACTION**: Create `livePayload.js` and `streamLifecycle.js`; rewrite `stream/route.js`; update `useUsageStats.js` (live state, lifecycle, catch-up, `compare=previous` fetch param) and the page's topology props. Write `tests/unit/usage-live-stream.test.js` first: payload shape, cap and `< 2048` bytes with a worst case; route sends exactly one `data:` frame per emitted event with the slim shape and never calls getUsageStats (spy/mock); reducer transitions (hidden → closed, visible on overview → open + needsCatchUp, logs tab → closed, caughtUp).
- **IMPLEMENT**: Per Contracts. The page passes `tab: activeTab` into `useUsageStats`. Also measure before/after: with a seeded DB (≥ 50k rows), record `getUsageStats("all")` ms vs `getActiveRequests`+builder ms, and bytes per message. Write the numbers to `docs/prps/plans/.prp-research/yan-407-usage-polish/measurements.md`.
- **MIRROR**: SERVICE_PATTERN, TEST_STRUCTURE
- **VALIDATE**: `cd tests && npx vitest run unit/usage-live-stream.test.js`

### Task 1.2: Previous-period totals + tile trends

- **BATCH**: B1
- **Depends on**: none
- **ACTION**: `previousPeriodRange` in period.js; `getUsageTotals` in usageRepo plus exports; `compare=previous` in the stats route; `tileTrends.js`; `useChartBuckets.js`; `StatTile` `trend` prop; `UsageStatsCards` sparklines + trends (props `stats`, `previous`, `buckets`, `period`); `UsageTokensChart{,Inner}` take `buckets/loading/error/onRetry` and use LoadingState/ErrorState. Tests first in `tests/unit/usage-trends.test.js`.
- **IMPLEMENT**: Do NOT edit `useUsageStats.js` or `page.js` (Task 1.1 owns them); expose a clear props API and document it. Task 2.1 wires them.
- **MIRROR**: REPOSITORY_PATTERN, NAMING_CONVENTION
- **VALIDATE**: `cd tests && npx vitest run unit/usage-trends.test.js unit/period.test.js unit/usage-chart.test.js`

### Task 1.3: Request log consistency

- **BATCH**: B1
- **Depends on**: none
- **ACTION**: `TABLE_HEAD_*` in displayPrimitives (+ test assertion); `Select` `placeholder={null}`; RequestLog rewrite per Contracts; UsageBreakdown and PricingModal headers; PricingModal loading + sentence case; logical alignment; translations for new or changed literals.
- **IMPLEMENT**: Keep RequestLog < 500 lines (extract `RequestLogFilters.js` if helpful). Don't touch the stat tiles, the chart, page.js or useUsageStats.
- **MIRROR**: NAMING_CONVENTION, ERROR_HANDLING
- **VALIDATE**: `cd tests && npx vitest run unit/signal-display-primitives.test.js unit/signal-form-primitives.test.js unit/i18n-coverage.test.js unit/request-details-tab.test.js`

### Task 2.1: Page wiring

- **BATCH**: B2
- **Depends on**: 1.1, 1.2, 1.3
- **ACTION**: In `usage/page.js`, call `useChartBuckets(period, overview && !quiet)` once; pass buckets to tiles and chart; pass `stats.previous` and `period` to tiles; make sure `useUsageStats` requests `compare=previous`. Grep for leftover "Loading…" in usage/.
- **MIRROR**: SERVICE_PATTERN
- **VALIDATE**: `rg -n "Loading…|Loading\.\.\.|text-left|text-right" "src/app/(dashboard)/dashboard/usage" src/shared/components/PricingModal.js` returns nothing; `npm run build`

---

## Testing Strategy

### Unit Tests

| Test                | Input                  | Expected                                        | Edge case   |
| ------------------- | ---------------------- | ----------------------------------------------- | ----------- |
| buildLivePayload    | 30 active, 20 recent   | ≤ 12 active, lastProvider = recent[0], < 2048 B | yes         |
| stream route        | emit pending ×2        | 2 frames, slim shape, no getUsageStats          | yes         |
| streamReducer       | hidden / logs / back   | open flags + needsCatchUp                       | yes         |
| previousPeriodRange | each period            | equal-length window just before                 | DST         |
| getUsageTotals      | seeded rows            | sums in range only                              | boundary ms |
| trendDelta          | prev 0, prev 100 → 108 | none, up 8                                      | yes         |
| stats route compare | `?compare=bogus`       | 400                                             | yes         |

### Edge Cases Checklist

- [x] No previous data
- [x] Hidden-tab resume
- [x] Worst-case payload size
- [x] Invalid compare param
- [x] from > to in the request log filters

## Validation Commands

### Static Analysis

```bash
npm run lint
```

### Unit Tests

```bash
cd tests && npx vitest run unit/usage-live-stream.test.js unit/usage-trends.test.js unit/signal-display-primitives.test.js unit/i18n-coverage.test.js
```

### Full Test Suite

```bash
npm test
```

### Build

```bash
npm run build
```

### Browser Validation

```bash
DATA_DIR=<seeded> npx next dev --webpack --port <free>
```

Check: dark + light at 1440/1024/390, keyboard only, `ar`, empty/loading/error, zero console errors. SSE frames are inspected with `curl -N`.

### Manual Validation

- [ ] The stream closes on the logs tab and on a hidden tab (DevTools network), and resumes with one stats fetch.
- [ ] Tiles show a sparkline and a delta for every period.
- [ ] The request log looks correct in RTL; the keyboard opens the drawer; Esc returns focus.

## Acceptance Criteria

- [ ] The SSE payload is under 2 KB per message (measured) and computed without scanning history; closed on hidden tabs and the logs tab; unit-tested.
- [ ] Stat tiles show a sparkline and a delta for the selected period.
- [ ] The request log uses shared form primitives and one table-header style (also on Breakdown and Pricing), with logical alignment; RTL renders correctly.
- [ ] No plain "Loading…" text in Usage.

## Completion Checklist

- [ ] Contracts followed
- [ ] PropTypes + JSDoc on new or changed exports
- [ ] No new dependencies; files < 500 lines
- [ ] i18n coverage guard green

## Risks

| Risk                                                 | Likelihood | Impact | Mitigation                                                                                           |
| ---------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------- |
| Removing stream fields breaks a hidden consumer      | L          | M      | Research: the only consumer is useUsageStats                                                         |
| Totals mismatch between history and the daily rollup | M          | L      | Deltas use the same source for current and previous (`getUsageTotals` for both, called by the route) |
| Two stats calls cost more                            | L          | L      | The compare query is a single indexed range scan                                                     |

## Notes

- Tiles keep the existing headline numbers from `stats`; only the percentage uses `currentTotals` vs `previous`, so both sides of the delta come from the same source.
