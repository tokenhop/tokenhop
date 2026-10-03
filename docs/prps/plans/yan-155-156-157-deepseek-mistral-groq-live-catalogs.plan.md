# Plan: YAN-155 DeepSeek, YAN-156 Mistral, YAN-157 Groq live model catalogs

Target: v1.1.0, PR into `master`, no backport. GitHub #706 (DeepSeek), #707
(Mistral), #708 (Groq). Part of YAN-135. No switch needed: every failure keeps the
static catalog.

## Upstream

All three are OpenAI-style `GET …/models` with `Authorization: Bearer <key>`.

| Provider | Endpoint                                    | Useful fields                                                                  |
| -------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| DeepSeek | `GET https://api.deepseek.com/models`       | `id` only                                                                      |
| Mistral  | `GET https://api.mistral.ai/v1/models`      | `capabilities.completion_chat`, `max_context_length`, `deprecation`, `aliases` |
| Groq     | `GET https://api.groq.com/openai/v1/models` | `active`, `context_window`, `max_completion_tokens`                            |

## Mapping

- **DeepSeek:** every id is chat. Static virtual variants (`deepseek-v4-pro-max`,
  `-none`) carry `upstreamModelId`; they are kept when their upstream id is live, so
  the thinking variants don't vanish from the dashboard.
- **Mistral:** `*embed*` ids → `embedding`; `completion_chat` → chat; anything else
  (OCR, moderation, classifiers) dropped. Entries with a `deprecation` date are
  dropped. Alias groups (`mistral-large-2512` / `mistral-large-latest`) collapse to
  one entry, preferring the `-latest` id the static registry uses.
  `max_context_length` → `contextLength`.
- **Groq:** `active: false` dropped; `whisper*` → `stt`; TTS ids dropped (Groq has no
  TTS route here); everything else chat, guard models included (they are served by
  chat completions). `context_window` → `contextLength`, `max_completion_tokens` →
  `maxOutputTokens`.

## Changes

1. `src/lib/providerModels/apiKeyModels.js` (new): shared Bearer list fetch (10 s
   timeout, warning on failure/empty), `parseDeepSeekModels`, `parseMistralModels`,
   `parseGroqModels`, `resolveDeepSeek`, `resolveMistral`, `resolveGroq`.
2. `liveResolvers.js`: register `deepseek`, `mistral`, `groq`.
3. Registry `deepseek.js`, `mistral.js`, `groq.js`: `features.liveModels: true`.
4. `src/app/api/providers/[id]/models/route.js`: drop the three shadowed configs.
5. Tests: registry lists in `live-model-resolvers.test.js` / `live-models-utils.test.js`;
   new `tests/unit/deepseek-mistral-groq-live-models.test.js` (parsers, dashboard +
   `/v1/models`, failure warning).

## Not done

- Groq guard-model tag: nothing consumes a tag yet; add with a dashboard filter.
- Mistral `vision`/`function_calling` caps: same partial-caps limit as Copilot.
