# Plan: YAN-161 Perplexity, YAN-162 Perplexity Agent, YAN-153 Vercel AI Gateway, YAN-154 Chutes live model catalogs

Target: v1.1.0, PR into `master`, no backport. GitHub #722 (Perplexity), #723
(Perplexity Agent), #724 (Vercel AI Gateway), #725 (Chutes). Part of YAN-135. No
switch needed: every failure keeps the static catalog (or the empty one) plus a warning.

## Upstream

| Provider          | Endpoint                                     | Auth                  | Shape    | Useful fields                                                                  |
| ----------------- | -------------------------------------------- | --------------------- | -------- | ------------------------------------------------------------------------------ |
| Perplexity Agent  | `GET https://api.perplexity.ai/v1/models`    | Bearer (401 without)  | `{data}` | `id` (`provider/model`), `owned_by` only                                       |
| Vercel AI Gateway | `GET https://ai-gateway.vercel.sh/v1/models` | public (key sent too) | `{data}` | `type`, `name`, `context_window`, `max_tokens`, `modalities.input`             |
| Chutes            | `GET https://llm.chutes.ai/v1/models`        | public (key sent too) | `{data}` | `context_length`, `max_output_length`, `input_modalities`, `output_modalities` |

Perplexity docs (docs.perplexity.ai `models-get`): `/v1/models` lists the **Agent API**
ids only (`openai/gpt-5.5`, `perplexity/sonar`, …). `GET /models` does not exist (404).

## Decisions

- **Perplexity (Sonar, YAN-161): no live catalog.** The Sonar chat API has no model
  list; `/v1/models` is the Agent catalog, whose prefixed ids `/chat/completions`
  can't route. Listing it would offer unroutable models. Instead: `validateUrl` moves
  to the live `/v1/models` (the registry's `/models` 404s, so the validate route
  rejected every key) and the static list gains `sonar-reasoning-pro` and
  `sonar-deep-research`.
- **Perplexity Agent:** every id is chat; registry names kept for known ids.
- **Vercel AI Gateway:** `language` → llm, `embedding`, `image` kept; video, speech,
  transcription, realtime, reranking, evaluation have no route here and are dropped.
- **Chutes:** rows whose `output_modalities` lack `text` are dropped; the rest are chat.
- Perplexity Agent and Vercel drop `modelsFetcher` (the suggested-chips path); the live
  catalog and Fetch Models replace it. `passthroughModels` stays (manual ids).

## Changes

1. `src/lib/providerModels/apiKeyModels.js`: `parsePerplexityAgentModels`,
   `parseVercelModels`, `parseChutesModels` + resolvers.
2. `liveResolvers.js`: register `perplexity-agent`, `vercel-ai-gateway`, `chutes`.
3. Registry: `features.liveModels: true` on the three; drop `modelsFetcher` from
   perplexity-agent and vercel; perplexity `validateUrl` + two Sonar models.
4. `src/app/api/providers/[id]/models/route.js`: drop the three shadowed configs.
5. Tests: registry lists in `live-model-resolvers.test.js` / `live-models-utils.test.js`;
   new `tests/unit/perplexity-vercel-chutes-live-models.test.js`.

## Not done

- Perplexity Router API (`/router/v1/models`, private preview) — add a provider when it ships.
- Vercel video/speech/transcription kinds — add when tokenhop routes them for Vercel.
