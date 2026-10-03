# Plan: YAN-158 Together AI, YAN-159 Fireworks AI, YAN-160 Cerebras live model catalogs

Target: v1.1.0, PR into `master`, no backport. GitHub #711 (Together), #712
(Fireworks), #713 (Cerebras). Part of YAN-135. No switch needed: every failure keeps
the static catalog.

## Upstream

All three are `GET …/models` with `Authorization: Bearer <key>`, unpaginated.

| Provider  | Endpoint                                           | Shape             | Useful fields                                       |
| --------- | -------------------------------------------------- | ----------------- | --------------------------------------------------- |
| Together  | `GET https://api.together.xyz/v1/models`           | bare array        | `type`, `display_name`, `context_length`, `pricing` |
| Fireworks | `GET https://api.fireworks.ai/inference/v1/models` | array or `{data}` | `kind`, `supports_chat`, `context_length`           |
| Cerebras  | `GET https://api.cerebras.ai/v1/models`            | `{data}`          | `id` only                                           |

## Mapping

Together and Fireworks only route `llm` and `embedding` here (registry
`serviceKinds`), so other kinds are dropped.

- **Together:** `chat`/`language`/`code` → llm, `embedding` → embedding; `image`,
  `rerank`, `moderation` dropped. Rows priced 0 input / 0 output are dedicated-only
  (not serverless) and dropped. `display_name` → name, `context_length` →
  `contextLength`.
- **Fireworks:** `kind: EMBEDDING_MODEL` → embedding, unless the id says `rerank`
  (dropped); `FLUMINA_*` (image) dropped; otherwise `supports_chat` → llm. Name is the
  id tail. `context_length` → `contextLength`. `supports_chat` alone is unreliable
  (embedding models report true), so `kind` wins.
- **Cerebras:** every id is chat; name from the static registry when known.

## Changes

1. `src/lib/providerModels/apiKeyModels.js`: `entries()` also accepts a bare array;
   `parseTogetherModels`, `parseFireworksModels`, `parseCerebrasModels`, and their
   resolvers.
2. `liveResolvers.js`: register `together`, `fireworks`, `cerebras`.
3. Registry `together.js`, `fireworks.js`, `cerebras.js`: `features.liveModels: true`.
4. `src/app/api/providers/[id]/models/route.js`: drop the three shadowed configs.
5. Tests: registry lists in `live-model-resolvers.test.js` / `live-models-utils.test.js`;
   new `tests/unit/together-fireworks-cerebras-live-models.test.js` (parsers,
   dashboard + `/v1/models`, failure warning).

## Not done

- Cerebras limits: the no-auth `public/v1/models` has `max_context_length` /
  `max_completion_tokens`; merge it when limits matter.
- Fireworks account-deployed models live under the control-plane API
  (`/v1/accounts/{account}/models`), not the inference list.
