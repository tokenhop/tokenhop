# Plan: YAN-175 Venice, YAN-180 Bazaarlink, YAN-181 LLM7, YAN-183 SambaNova live model catalogs

Target: v1.1.0, PR into `master`, no backport. GitHub #748 (Venice), #749
(Bazaarlink), #750 (LLM7), #751 (SambaNova). Part of YAN-135. No switch needed:
every failure keeps the static catalog plus a warning.

## Upstream (probed 2026-10-03, lists are public; the key is still sent)

| Provider   | Endpoint                                           | Useful fields                                                                                                                                     |
| ---------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Venice     | `GET https://api.venice.ai/api/v1/models?type=all` | `type` (text/embedding/image/video/tts/asr/…), `model_spec.{name,availableContextTokens,maxCompletionTokens,capabilities.supportsVision,offline}` |
| Bazaarlink | `GET https://bazaarlink.ai/api/v1/models`          | `name`, `description`, `context_length`, `architecture.{input,output}_modalities`                                                                 |
| LLM7       | `GET {baseUrl \|\| https://api.llm7.io/v1}/models` | `model_type` (chat/image/video/audio_to_text/systemone), `context_window.tokens`, `modalities.input`                                              |
| SambaNova  | `GET https://api.sambanova.ai/v1/models`           | `context_length`, `max_completion_tokens` (ids only otherwise)                                                                                    |

## Decisions

- **Venice:** `text` → llm, `embedding` → embedding, `image` → image (the
  registry has `embeddingConfig` and `imageConfig`). Video, music, TTS, ASR,
  upscale, inpaint have no route here and are dropped, as are `offline` rows.
  Static image rows keep their `params` through `mergeLiveWithStatic`.
- **Bazaarlink:** rows without text output are dropped; everything else is chat.
- **LLM7:** only `model_type: "chat"`; the rest has no route. The custom
  `providerSpecificData.baseUrl` the connection test already honours moves into
  one helper (`llm7ModelsUrl`) used by both.
- **SambaNova:** ids only, all chat; registry names kept.
- `resolver()` accepts a URL function of the connection (LLM7 only).
- `modelsFetcher` stays on Venice: the side panel uses it without a connection,
  and the chips drop out once live ids cover them (OpenRouter precedent).

## Files

- `src/lib/providerModels/apiKeyModels.js`: four parsers + resolvers, `llm7ModelsUrl`.
- `src/lib/providerModels/liveResolvers.js`: register them.
- `open-sse/providers/registry/{venice,bazaarlink,llm7,sambanova}.js`: `features: { liveModels: true }`.
- `src/app/api/providers/[id]/test/testUtils.js`: use `llm7ModelsUrl`.
- Tests: `live-model-resolvers.test.js`, `live-models-utils.test.js` exact lists;
  new `tests/unit/venice-bazaarlink-llm7-sambanova-live-models.test.js`
  (parsers, LLM7 custom base URL, failure warning without key echo).

## Validation

```bash
npm run lint
npx vitest run -c tests/vitest.config.js tests/unit/venice-bazaarlink-llm7-sambanova-live-models.test.js \
  tests/unit/live-models-utils.test.js tests/unit/live-model-resolvers.test.js tests/unit/venice-provider.test.js
node tests/__baseline__/verify-providers.mjs
npm test
```

## Risks

- Bazaarlink's static ids drift from upstream (9 of 24 missing today); the live
  list replacing them is the point. Chat still routes unknown ids upstream.
- Venice lists 128 text models; `/v1/models` grows accordingly, users trim via
  Disable as with other live providers.
