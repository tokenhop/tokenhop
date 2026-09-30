# YAN-56, YAN-57, YAN-59: /v1 model ids and metadata

GitHub: tokenhop/tokenhop#407, #408, #409 · Linear: YAN-56, YAN-57, YAN-59 · Target: v0.5.x patch (PR into `master`,
then `backport:0.5` to `release/0.5`). Every touched file is identical on `release/0.5`, so the cherry-pick applies cleanly.

## Problem

- **YAN-56:** `buildModelsList` advertises web ids `{alias}/search` and `{alias}/fetch`. `/v1/search` and `/v1/web/fetch`
  pass the id to `resolveProviderId`, which knows only bare ids and aliases, so `tavily/search` returns
  `400 Unknown provider`. Inside a web combo the same 400 ends the combo without trying the next member.
- **YAN-57:** `/v1/models/info` reports `webFetch` models at `/v1/fetch`. The route is `/v1/web/fetch`.
- **YAN-59:** no `/v1/models` entry has the OpenAI Model `created` field, so strict clients fail to parse the list.

## Design

- **YAN-56:** `handleSingleProviderSearch` strips a trailing `/search`, and `handleSingleProviderFetch` strips a trailing
  `/fetch`, before `resolveProviderId`. Only the suffix matching the endpoint is stripped, so `tavily/fetch` on
  `/v1/search` is still rejected. Doing it in the single-provider handler covers direct calls and combo members.
  Error messages keep the id the client sent.
- **YAN-57:** `KIND_ENDPOINT.webFetch = "/v1/web/fetch"`.
- **YAN-59:** `buildModelsList` adds `created` to each entry in its dedup loop, so all six entry builders are covered in
  one place. No per-model creation date exists (static catalog, live catalogs, combos), so the value is the gateway's
  start time in Unix seconds: fixed for the life of the process, the same on every call.

Out of scope (pre-existing, not a regression): custom connection prefixes and extra registry `aliases` (e.g. `pplx-agent`)
don't resolve in the web handlers even without a suffix; `searchViaChat` providers are not listed as `{alias}/search`.

## Tasks

1. `src/sse/handlers/search.js`: strip `/search` before `resolveProviderId` in `handleSingleProviderSearch`.
2. `src/sse/handlers/fetch.js`: strip `/fetch` before `resolveProviderId` in `handleSingleProviderFetch`.
3. `src/app/api/v1/models/info/route.js`: fix the `webFetch` endpoint.
4. `src/app/api/v1/models/route.js`: module constant for the start time; add `created` in the dedup loop.
5. Test `tests/unit/v1-web-model-ids.test.js`:
   - `/v1/search` with `tavily/search` reaches the search core as `tavily`; `/v1/web/fetch` with `tavily/fetch` reaches
     the fetch core as `tavily`; `tavily/fetch` on `/v1/search` is still `400 Unknown provider`.
   - `buildModelsList(["llm"])` entries all carry the same integer `created`.
   - `GET /v1/models/info?id=tavily/fetch` reports `endpoint: "/v1/web/fetch"`.

## Validation

- `npm run lint`
- `cd tests && npx vitest run unit/v1-web-model-ids.test.js unit/fetch-success-clears-account.test.js unit/live-model-resolvers.test.js unit/codex-live-models.test.js`
- `npm test` (known-fails gate), `npm run build` (CI)
