# Plan: YAN-190 OpenCode Free live model catalog

Target: v1.1.0, PR into `master`, no backport. GitHub #743. Part of YAN-135. No
feature switch needed: if the fetch fails, the dashboard and `/v1/models` keep
the static registry list and the dashboard shows the warning.

## Upstream

`GET https://opencode.ai/zen/v1/models` returns the whole Zen catalog in
OpenAI style (ids only, `owned_by: "opencode"`) and answers 200 with or without
a key. On 2026-10-03 it listed 86 ids. After the `opencode-free` filter
(`-free` suffix, `big-pickle`, minus `DEAD_FREE_OPENCODE_MODELS`) 13 were left:
`big-pickle`, `jev-1.13-free`, `muse-spark-1.2/1.3-contributor-free`,
`mimo-v2.6-flash-free`, `mimo-v2.5-free`, `space-bunny-free`,
`longcat-2.5-preview-free`, `ling-3.0-flash-fin-free`, `ling-3.1-flash-free`,
`nemotron-3-ultra-free`, `nemotron-3.5-lightning-free` and `fledge-alpha-free`.
`union-alpha`, a registry model, is no longer listed.

## Transport for ids the registry lacks

No inference helper is needed, unlike `inferOpencodeGoModel`. The Zen docs
endpoint table (<https://opencode.ai/docs/zen/>) puts every current free model on
`/zen/v1/chat/completions` except these:

| Id              | Endpoint            | Already handled by                                                                |
| --------------- | ------------------- | --------------------------------------------------------------------------------- |
| `muse-spark-*`  | `/responses`        | `isMuseSparkModel` (executor `isResponsesModel`, `getModelTargetFormat` for `oc`) |
| `union-alpha`   | `/messages`         | `MESSAGES_MODELS` + registry `targetFormat: "claude"`                             |
| `jev-1.13-free` | `/zen/v1/systemone` | nothing. Upstream returns 500 for it on chat/completions anyway                   |

Unknown ids fall to chat/completions, which is the documented default.
`jev-1.13-free` uses an endpoint the executor can't serve, so the filter drops
it: add it to `DEAD_FREE_OPENCODE_MODELS` with a comment.

## Design

The `opencode` provider is noAuth and has no connection row, so the live
plumbing, which is keyed on connections, never reaches it. A synthetic
connection `{ id: "noauth", provider }` (the same id `src/sse/services/auth.js`
already uses for noAuth providers) stands in wherever a connection is needed.
The resolver cache key is `opencode:noauth`, with the same 60 s TTL.

## Changes

1. `open-sse/executors/opencode.js`: export
   `OPENCODE_PUBLIC_HEADERS = { Authorization: "Bearer public", "User-Agent": OPENCODE_UA }`.
   `buildHeaders` is unchanged.
2. `src/app/api/providers/[id]/test/testUtils.js` (`case "opencode"`): use
   `headers: OPENCODE_PUBLIC_HEADERS`. That leaves one copy of the UA/version
   literal in the codebase.
3. `src/app/api/providers/suggested-models/filters.js`: add `"jev-1.13-free"`
   to `DEAD_FREE_OPENCODE_MODELS`, with a comment that it is served on
   `/zen/v1/systemone`, which the executor can't reach.
4. `src/lib/providerModels/apiKeyModels.js`: add an "OpenCode Free" section.
   - `parseOpencodeFreeModels(body) = FILTERS["opencode-free"](entries(body))`
   - `resolveOpencode()`: fetch `https://opencode.ai/zen/v1/models` with
     `{ ...OPENCODE_PUBLIC_HEADERS, Accept: "application/json" }` and
     `AbortSignal.timeout(FETCH_TIMEOUT_MS)`. A non-OK response returns
     `{ models: [], warning: "Failed to fetch OpenCode Free models: <status> <text≤300>" }`.
     An empty result returns the "returned no live models" warning.
   - The existing `resolver()` factory requires `apiKey`, so this is a small
     standalone function. Update the header comment.
5. `src/lib/providerModels/liveResolvers.js`:
   - import `resolveOpencode` and register `opencode: resolveOpencode`
   - export `noAuthConnection = (provider) => ({ id: "noauth", provider, isActive: true })`
6. `open-sse/providers/registry/opencode.js`: add `features: { liveModels: true }`
   and delete `modelsFetcher`. That retires the suggested chips and the side-panel
   prefetch for this provider only; OpenRouter, Kilo and others keep theirs.
   `passthroughModels` stays.
7. `src/app/api/v1/models/route.js` (`buildModelsList`): after building
   `activeConnectionByProvider`, add:
   `for (const p of VISIBLE_NO_AUTH_PROVIDERS) if (hasLiveModelResolver(p.id) && !activeConnectionByProvider.has(p.id)) activeConnectionByProvider.set(p.id, noAuthConnection(p.id));`
   - The existing per-provider loop then handles it unchanged: kind filter,
     disabled models, aliases, custom models, live override, static fallback.
     The block is not duplicated.
   - `VISIBLE_NO_AUTH_PROVIDERS` skips `hidden` providers. That is the same
     gate the model picker uses (`useModelSelectData.js`), and noAuth providers
     have no other disable switch.
   - The zero-connection branch is untouched. It already lists static `oc/*`.
8. `src/app/api/providers/[id]/models/route.js`: fall back to the synthetic
   connection when no row matches:
   `getProviderConnectionById(id) || (FREE_PROVIDERS[id]?.noAuth && hasLiveModelResolver(id) ? noAuthConnection(id) : null)`.
   Any other id still returns 404. The live branch is reached as before and
   returns `connectionId: "noauth"`.
9. `src/app/(dashboard)/dashboard/providers/[id]/useLiveCatalog.js`: add a
   `noAuth` param. The fetch key becomes
   `enabled ? (noAuth ? providerId : firstActive?.id) : null`; the variable
   `connectionId` keeps its name, and the doc comment gets one line.
10. `src/app/(dashboard)/dashboard/providers/detail/ProviderDetailPage.js`: pass
    `noAuth: authFlags.isFreeNoAuth` to `useLiveCatalog`.
11. `src/app/(dashboard)/dashboard/providers/detail/ModelsSection.js:288`: show
    `FetchModelsButton` when `isLiveCatalog && (hasActiveConnection || isFreeNoAuth)`.
    The suggested-chips block stays; without a fetcher it renders nothing for
    `opencode`.

## Tasks (order, parallelism)

- **A** (parallel): steps 1–2, the shared headers.
- **B** (parallel with A, needs step 1's export to merge): steps 3–6, the
  resolver and registry.
- **C** (after B, needs `noAuthConnection`): steps 7–8, the server wiring.
- **D** (parallel with B and C): steps 9–11, the dashboard. It only depends on
  the route contract in step 8, not on any import.
- **E** (after A–D): the tests below.

## Tests

New `tests/unit/opencode-free-live-models.test.js`, modelled on
`opencode-go-live-models.test.js`. It stubs `fetch` for the Zen URL only and
calls `clearLiveModelsCache()` in `beforeEach`.

- **Filter.** `parseOpencodeFreeModels` keeps `-free` ids and `big-pickle`. It
  drops paid ids and the dead ids (`deepseek-v4-flash-free`, `jev-1.13-free`),
  and tolerates a bare array or `{ data }`.
- **Dashboard without a row.** `GET /api/providers/opencode/models` returns 200
  with the filtered ids and no `warning`. The request carries
  `Authorization: Bearer public` and `User-Agent: OPENCODE_PUBLIC_HEADERS["User-Agent"]`.
- **`/v1/models` without a row.** Seed one unrelated connection so the
  non-empty branch runs. Use a provider with no live resolver (for example
  `cohere` with an API key) so it makes no fetch of its own.
  `buildModelsList(["llm"])` contains `oc/space-bunny-free` and not `oc/gpt-5`
  (paid).
- **Failure fallback.** Upstream returns 503. The dashboard response has
  `models: []` and a `warning` matching `/503/`. `buildModelsList` still lists
  the static `oc/union-alpha`. A later 200 is not served from cache.
- **Unknown id.** `GET /api/providers/nope/models` still returns 404.

Update the exact-list tests:

- `tests/unit/live-models-utils.test.js`: add `"opencode"` before `"opencode-go"`.
- `tests/unit/live-model-resolvers.test.js`: add `"opencode"` to the registry
  coverage list.

`tests/__baseline__/providers-baseline.json` doesn't snapshot `features` or
`modelsFetcher`, so no baseline change is expected; `verify-providers` confirms
it.

## Validation

```bash
npm run lint
npx vitest run -c tests/vitest.config.js \
  tests/unit/opencode-free-live-models.test.js \
  tests/unit/opencode-go-live-models.test.js \
  tests/unit/live-models-utils.test.js \
  tests/unit/live-model-resolvers.test.js \
  tests/unit/opencode-session.test.js \
  tests/unit/opencode-free-tool-choice.test.js
node tests/__baseline__/verify-providers.mjs
npm test          # app code changed: full suite + known-fails gate
```

Manual check: `PORT=20128 npm run dev`, then open `/dashboard/providers/opencode`.

- With no connection row, the live free list appears.
- Fetch Models imports new ids.
- Offline, the static list shows with the red warning.
- `curl localhost:20128/v1/models` lists `oc/*` next to other connected
  providers.

## Risks

- **Proxy pool not applied.** The resolver fetches directly through the global
  `proxyFetch` patch and ignores the per-provider noAuth proxy pool that
  `auth.js` applies to chat. That's acceptable for a public, unauthenticated
  GET. Mark it with `ponytail:` and resolve via `resolveConnectionProxyConfig`
  if a rate-limit or geo block shows up.
- **New rotated ids on an unknown endpoint.** They default to chat/completions.
  A future id on another endpoint fails at request time until it's added to the
  dead set or the executor. Upstream is visible, so the failure is too.
- **Registry-only models drop out when absent upstream.** Today that's
  `union-alpha`. They disappear from `/v1/models` and from the dashboard catalog
  while the live fetch succeeds, which is the intended behaviour for rotation.
  Chat still routes them because `passthroughModels` is set.
- **One extra upstream GET per `/v1/models` call.** The 60 s cache and the 10 s
  timeout bound it; failures aren't cached, matching the other resolvers.
- **`/v1/models` lists `oc/*` by default.** That change is intended: the
  provider needs no credentials. Hiding the provider (`hidden`) opts it out.
- **Synthetic id in the URL.** The route only accepts a registry noAuth id that
  has a resolver. The upstream URL is fixed, so there is no SSRF surface.

## Not done

- **Model picker** (`useModelSelectData` `liveCatalogRequestKey`): still keyed
  on connections, so it shows the static `oc` rows. Nothing regresses: the chips
  were only on the provider page. Follow up if wanted.
- **Live catalogs for other noAuth providers** (mimo-free etc.): they have no
  resolver. Step 7's loop picks them up once one is registered.
