# Plan: YAN-142 OpenAI + YAN-138 GitHub Copilot live model catalogs

Target: v1.1.0, PR into `master`, no backport. GitHub #698 (OpenAI), #697 (Copilot).
Part of YAN-135. No switch needed: every failure keeps the static catalog.

## Upstream

| Provider | Endpoint                                   | Shape                                    | Kind info                                  |
| -------- | ------------------------------------------ | ---------------------------------------- | ------------------------------------------ |
| OpenAI   | `GET https://api.openai.com/v1/models`     | `{ data: [{ id, owned_by, created }] }`  | none, classify by id                       |
| Copilot  | `GET https://api.githubcopilot.com/models` | `{ data: [{ id, name, capabilities }] }` | `capabilities.type`, `capabilities.limits` |

OpenAI id classes: `text-embedding-*` embedding; `tts-*`, `*-tts` tts; `whisper-*`,
`*-transcribe*` stt; `dall-e-*`, `gpt-image-*`, `chatgpt-image-*` image; dropped
(no route serves them): moderation, realtime, `sora-*`, `babbage-002`, `davinci-002`,
`*-instruct`, `computer-use-*`. Everything else (incl. `ft:*` fine-tunes) is chat.
Static registry kind wins when the id is known.

## Changes

1. `src/lib/providerModels/staticExtras.js` (new): `withStaticNonChatModels(providerId, live)`
   keeps static non-chat entries the live list lacks (moved out of `googleModels.js`).
2. `src/lib/providerModels/openaiModels.js` (new): `classifyOpenAIModel(id)`,
   `parseOpenAIModels(body)`, `resolveOpenAI(connection)` (API key, Bearer).
3. `liveResolvers.js`: register `openai`; `github` keeps static embeddings.
4. `open-sse/services/copilotModels.js`: map `max_prompt_tokens` (Copilot's input
   cap; fallback `max_context_window_tokens`) to `contextLength`, `max_output_tokens`
   to `maxOutputTokens`.
5. `open-sse/providers/registry/openai.js`: `features: { liveModels: true }`.
6. `src/app/api/providers/[id]/models/route.js`: drop shadowed `openai` config.
7. Tests: registry lists; new `tests/unit/openai-copilot-live-models.test.js`
   (classifier, fallback, Copilot filter + limits + 401 refresh + embeddings kept).

## Not done

- Copilot tool/vision flags: a partial live caps object would replace the pattern
  table's caps in `/v1/models`; add when caps merge instead of replace.
- `OpenAI-Organization`/`OpenAI-Project` headers: project keys don't need them.
