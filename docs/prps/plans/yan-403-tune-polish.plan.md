# YAN-403 — Token saver, Skills and Proxy pools polish

Linear: YAN-403 · GitHub: #314 · Branch: `fix/yan-403-tune-polish` from `master`.

## Research findings

- **Token saver**: `useHeadroomExtras.refresh()` awaits `/api/headroom/status` with no timeout.
  The route runs `which headroom` + `pip show/list` via `execSync` (up to 8 s each), so the pill
  sits on "Checking…" for 10 s+. Failures map to `installed:false` ("Not installed"), which lies.
  The page itself is not gated on the probe (only on `/api/settings`). Header title is "Token Saver".
- **Skills**: hero uses `CopyField` (inline copy icon) plus `HeroCopyButton` (lime Copy). Cards
  already have one copy (`SkillCopyButton`) plus an external-open link. Names come from
  `src/shared/constants/skills.js` (Title Case); the `/skills/[...slug]` route only uses ids.
- **Proxy pools**: `page.js` 588 lines, subscribes to the whole notification store
  (`useNotificationStore()`), header subtitle "Manage your proxy pool configurations" plus a page
  paragraph, empty state repeats the lime "Add proxy", select-all checkbox shows (disabled) with
  zero rows, relays use CF/VC/DN monograms. Logos exist for `cloudflare-ai` and `vercel`, none for
  Deno.

## Design

1. **Headroom probe**: `refresh()` fetches with `AbortSignal.timeout(HEADROOM_STATUS_TIMEOUT_MS = 3000)`
   and ignores stale responses (request sequence ref). Any failure/timeout sets
   `{ unreachable: true, loading: false }`. `headroomStatusLabel` maps `unreachable` to
   "Unreachable" (checked before other states, after loading); `headroomPillProps` maps it to `err`.
   The Compress-context card shows, when unreachable, "Couldn't reach Headroom at {url}." with a
   Retry button (Manage Headroom stays in the footer).
2. **Skills**: replace hero `CopyField` with a read-only mono value box (no inline icon); keep the
   lime Copy. Sentence-case names: "9router entry skill", "Image generation", "Text to speech",
   "Speech to text", "Video generation", "Web search", "Web fetch".
3. **Proxy pools**: move state + handlers into `useProxyPools.js` (notification functions via
   selectors); page keeps layout only. Header subtitle becomes the page sentence, page paragraph
   removed. Empty-state action becomes `secondary`. Select-all checkbox rendered only when
   `pools.length > 0`. Relays render `ProviderTile` (`cloudflare-ai`, `vercel`); Deno keeps the
   monogram (no logo asset, avoids a 404).
4. **Titles** (`Header.js` `getPageInfo`): "Token saver", "Proxy pools".

## Tasks (parallel)

| #   | Task                                         | Files                                                                                                                        |
| --- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| A   | Headroom timeout + Unreachable state + tests | `token-saver/{useHeadroomExtras,tokenSaverUtils,HeadroomControls,TokenSaverPageClient}.js`, `tests/unit/token-saver.test.js` |
| B   | Skills copy + sentence case                  | `skills/SkillsPageClient.js`, `src/shared/constants/skills.js`                                                               |
| C   | Proxy pools split + polish                   | `proxy-pools/page.js`, new `proxy-pools/useProxyPools.js`, `proxy-pools/components/{PoolList,RelayCards}.js`                 |
| D   | Titles/subtitle                              | `src/shared/components/Header.js`                                                                                            |

## Validation

`npm run lint`, `npm test`, `npm run build`; browser check of the three pages (Headroom
unreachable, no pools), dark/light.

## Out of scope

Savings hero, count-up animation, server-side speed-up of `getHeadroomStatus` (sync `execSync`),
provider pages' store selectors (YAN-405), `public/i18n/literals/*.json`.
