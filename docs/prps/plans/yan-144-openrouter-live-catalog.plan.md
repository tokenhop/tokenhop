# Plan: OpenRouter live model catalog (YAN-144, #701)

Target: v1.1.0 (next minor). Base `master`, PR into `master`, no backport.
Branch: `feat/yan-144-openrouter-live-models` (worktree `../tokenhop-yan-144`).

## Summary

`openrouter` joins the YAN-135 live-catalog rollout. The dashboard and `/v1/models` show
OpenRouter's live catalog (~650 entries across modalities). The generic **Fetch models**
button imports it, and the provider page gets search, Free-only and input-modality filters
for large catalogs. If the fetch fails, the static list is kept and a warning is shown.

As a user with an OpenRouter key, I want to see and pick from OpenRouter's current
catalog, so that new upstream models are usable without a tokenhop release.

## UX Design

Before: the page lists 0 chat models (the static registry is media-only), plus a row of
"Suggested free models (≥200k context)" chips.
After: the page lists every live chat model, with the existing `Free` badge on free ones.
A filter bar above the list (shown when the live list has more than 30 entries) has a
search box (id/name), a `Free only` checkbox and an `Input` select (Any / Image / Audio /
Video / File). The chips go away on their own once live ids cover them: the existing
`hardcodedIds` filter in `ModelsSection.js` already drops them. They still show when no
connection exists.

## Mandatory Reading

- `src/lib/providerModels/liveResolvers.js`: resolver contract, `LIVE_MODEL_RESOLVERS`, cache
- `src/lib/providerModels/openaiModels.js`: closest pattern (API-key list, kind classifier, timeout)
- `src/lib/providerModels/staticExtras.js`: `withStaticNonChatModels`
- `open-sse/providers/registry/openrouter.js`, `open-sse/providers/registry/openai.js` (`features.liveModels`)
- `src/app/api/providers/[id]/models/route.js`: `PROVIDER_MODELS_CONFIG.openrouter` entry
- `src/app/api/v1/models/route.js`: live merge (`liveLimits`, `kindsById`)
- `src/app/(dashboard)/dashboard/providers/detail/ModelsSection.js`, `src/app/(dashboard)/dashboard/providers/[id]/ModelRow.js`
- `tests/unit/xai-live-models.test.js`: test template (fetch stub, DB connection, GET route, `buildModelsList`)

## Patterns to Mirror

- Resolver returns `{ models }` or `{ models: [], warning }` and never throws on HTTP errors. Bound the fetch with `AbortSignal.timeout(10_000)` (as `openaiModels.js` does).
- Kind is set only when it isn't llm: `{ id, name, ...(kind !== "llm" ? { kind } : {}) }`.
- An id listed under several kinds produces one entry per kind (as in `parseOpenAIModels`).
- Registry opt-in: `features: { liveModels: true }`. Once a resolver exists, remove the route's `PROVIDER_MODELS_CONFIG` entry (#699 did this for openai).
- Dashboard strings are plain English JSX. Don't edit `public/i18n/literals/*` (the i18n bot handles it).

## Files to Change

| File                                                              | Change                                            |
| ----------------------------------------------------------------- | ------------------------------------------------- |
| `src/lib/providerModels/openrouterModels.js`                      | NEW: `parseOpenRouterModels`, `resolveOpenRouter` |
| `src/lib/providerModels/liveResolvers.js`                         | register `openrouter: resolveOpenRouter`          |
| `open-sse/providers/registry/openrouter.js`                       | `features: { liveModels: true }`                  |
| `src/app/api/providers/[id]/models/route.js`                      | delete `openrouter:` config line                  |
| `src/app/(dashboard)/dashboard/providers/detail/ModelsSection.js` | filter bar (search, Free only, Input)             |
| `tests/unit/openrouter-live-models.test.js`                       | NEW: mapping + fallback + `/v1/models`            |

## NOT Building

- Live catalogs on the media-provider pages (they render the static catalog by design).
- Live `capabilities` mapping. The pattern table stays the source; a partial live caps object would hide `thinkingFormat` and similar fields.
- Removing `modelsFetcher` (the side panel and the no-connection state still use it).
- Trimming `/v1/models` to a static subset. Live ids are listed like every other live provider, and users trim with Disable or `enabledModels`.

## Step-by-Step Tasks

### Task 1: OpenRouter resolver (backend)

- **ACTION**: Create `src/lib/providerModels/openrouterModels.js`, register it, flag the registry, drop the route config.
- **IMPLEMENT**: `resolveOpenRouter(connection)` fetches `https://openrouter.ai/api/v1/models/user?output_modalities=all` with `Authorization: Bearer <apiKey>` when a key exists. If there's no key or that call fails, it fetches the public `https://openrouter.ai/api/v1/models?output_modalities=all`. If both fail, it returns `{ models: [], warning }`. `parseOpenRouterModels(body)` maps each entry's `architecture.output_modalities` to kinds: text→llm, embeddings→embedding, speech→tts, image→image, video→video. rerank, decisions and transcription are dropped (no route serves them), and entries with no servable kind are dropped too. Each entry gets `name`, `contextLength` (`context_length`), `maxOutputTokens` (`top_provider.max_completion_tokens`), `isFree` (prompt and completion pricing both `"0"`), `inputModalities` and `description`. Result: `withStaticNonChatModels("openrouter", models)`.
- **MIRROR**: `openaiModels.js` `resolveOpenAI`/`parseOpenAIModels`.
- **VALIDATE**: `npx vitest run -c tests/vitest.config.js tests/unit/openrouter-live-models.test.js`

### Task 2: Dashboard filter bar (frontend)

- **ACTION**: Add the filter bar to `ModelsSection.js` and filter `models.enabledModels` before rendering.
- **IMPLEMENT**: Local state `query`, `freeOnly`, `inputModality`. Show the bar only when `isLiveCatalog && models.enabledModels.length > 30`. Search matches id/name case-insensitively. `freeOnly` keeps `model.isFree`. The Input select keeps models whose `inputModalities` include the chosen value. "Disable all" still acts on every active id. If nothing matches, show a muted "No models match the filters." line.
- **MIRROR**: existing `Select` usage in the same file. Use the shared `Input` component if one exists in `@/shared/components`, otherwise a styled `<input>`.
- **VALIDATE**: `npm run lint`; check visually on the dev server.

### Task 3: Unit test

- **ACTION**: Create `tests/unit/openrouter-live-models.test.js`.
- **IMPLEMENT**: Stub fetch for `https://openrouter.ai/`. Cover: (a) kind mapping, free flag and limits; (b) `/models/user` 401 falls back to public `/models`; (c) both failing gives a warning and keeps the static list; (d) `buildModelsList(["llm"])` includes live ids with `context_length`.
- **MIRROR**: `tests/unit/xai-live-models.test.js`.
- **VALIDATE**: `npm test`

## Testing Strategy

One focused unit file (Task 3). The full `npm test` run is the regression gate. Check the UI manually on the dev server.

## Validation Commands

```bash
npm run lint
npx vitest run -c tests/vitest.config.js tests/unit/openrouter-live-models.test.js tests/unit/live-model-resolvers.test.js
npm test
```

## Acceptance Criteria

- The dashboard shows the full live catalog with search/filter, and the Free filter replaces the suggestion chips.
- `/v1/models` includes live ids unless `enabledModels` is set (choice documented in the PR).
- Unit tests cover the mapping and the fallback.

## Completion Checklist

- [ ] Lint clean
- [ ] Unit tests pass, no `npm test` regressions
- [ ] PR body has `Closes YAN-144` and `Closes #701`

## Risks

- A large `/v1/models` list for OpenRouter users. Mitigation: Disable / `enabledModels`, documented.
- `/models/user` may reject some keys. Mitigation: fall back to the public list.
