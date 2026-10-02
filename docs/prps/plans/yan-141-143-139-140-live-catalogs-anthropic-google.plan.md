# Plan: Live model catalogs for Anthropic, Gemini, Gemini CLI and Antigravity

## Summary

Part of YAN-135. Registers live model resolvers for `anthropic` (YAN-141), `gemini` (YAN-143), `gemini-cli` (YAN-139) and `antigravity` (YAN-140) in the shared resolver module and flags them `features.liveModels`, so the provider page, the model picker, the **Fetch models** button and `/v1/models` all use the account's live catalog. The legacy `PROVIDER_MODELS_CONFIG` entries for these four providers are removed (the live path shadows them).

## Metadata

- **Complexity**: Medium
- **Linear / GitHub**: YAN-141 #686, YAN-143 #687, YAN-139 #688, YAN-140 #689
- **Target release**: v1.1.0 (into `master`, no backport)
- **Switch**: none needed. Every path falls back to the static catalog with a visible warning.

## Design

All four resolvers return `{ models, warning? }` and never throw (contract of `resolveLiveModels`).

| Provider      | Upstream                                                                                          | Auth                                        | Mapping                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `anthropic`   | `GET api.anthropic.com/v1/models?limit=1000` (+ `after_id` paging)                                | `x-api-key`                                 | Reuses the Claude API-key path (`fetchAllAnthropicModels`, `parseAnthropicModels`)                       |
| `gemini`      | `GET generativelanguage.googleapis.com/v1beta/models?pageSize=1000` (+ `pageToken`)               | `x-goog-api-key` header (no key in the URL) | `models/` prefix stripped, `displayName`, `inputTokenLimit`/`outputTokenLimit`, kind from methods and id |
| `gemini-cli`  | `POST cloudcode-pa…/v1internal:fetchAvailableModels` `{ project }`                                | Google OAuth, refresh on 401/403            | Shared Cloud Code parser (map or array, drops `isInternal`, `maxTokens`/`maxOutputTokens`)               |
| `antigravity` | `POST daily-cloudcode-pa…/v1internal:fetchAvailableModels` `{ project }`, IDE UA + client headers | Google OAuth (Antigravity client), refresh  | Same parser, then reconciled with the static routing aliases (below)                                     |

- **Gemini kinds:** `embedContent` → embedding; `imagen-*` / `*-image*` → image; `veo-*` → video; `*-tts` → tts; other `generateContent` → llm; anything else (e.g. bidi-only live models) dropped. Static non-LLM entries the live list lacks (STT aliases, legacy embeddings) are kept.
- **Antigravity aliases:** static ids such as `gemini-3.8-flash` route to wire ids via `upstreamModelId` (`gemini-3.8-flash-medium(medium)`). A static entry stays when its wire id (`upstreamModelId` without the `(level)` suffix, or its own id) is in the live list; a live wire id already exposed through a static alias is not listed twice. Unknown live ids pass through. Only `gemini-*`, `claude-*`, `gpt-*` and `image*` keys are listed (the map also carries internal `chat_*`/`tab_*` completions).
- **Gemini CLI:** live list replaces the static one; when the fetch fails and no project id is stored, the warning says to reconnect.

## Tasks

1. `src/lib/providerModels/googleModels.js` (new): Gemini API resolver, Cloud Code parser, Gemini CLI + Antigravity resolvers.
2. `src/lib/providerModels/liveResolvers.js`: register `anthropic`, `gemini`, `gemini-cli`, `antigravity`; Anthropic shares the Claude API-key path.
3. `open-sse/providers/registry/{anthropic,gemini,gemini-cli,antigravity}.js`: `features.liveModels: true`.
4. `src/app/api/providers/[id]/models/route.js`: drop the four shadowed config entries and `parseGeminiCliModels`.
5. Tests: one file `tests/unit/google-anthropic-live-models.test.js` (parsers, alias reconciliation, header auth, refresh); update the provider lists in `live-models-utils.test.js` and `live-model-resolvers.test.js`.

## Validation

- `npm run lint`, `npm test` (no new known-fails), `npm run build`.
- Dashboard smoke on a dev server with stubbed upstreams is not possible without accounts; covered by route-level tests through `GET /api/providers/[id]/models` and `buildModelsList`.
