# Plan: YAN-163 NVIDIA NIM, YAN-170 Nebius, YAN-171 SiliconFlow, YAN-172 Hyperbolic live model catalogs

Target: v1.1.0, PR into `master`, no backport. GitHub #737 (NVIDIA NIM), #738
(Nebius), #739 (SiliconFlow), #740 (Hyperbolic). Part of YAN-135. No switch
needed: every failure keeps the static catalog plus a warning.

## Upstream

| Provider    | Endpoint                                                  | Auth                 | Useful fields                                              |
| ----------- | --------------------------------------------------------- | -------------------- | ---------------------------------------------------------- |
| NVIDIA NIM  | `GET https://integrate.api.nvidia.com/v1/models`          | public (key sent)    | `id`, `owned_by` only (81 entries on 2026-10-03)           |
| Nebius      | `GET https://api.studio.nebius.ai/v1/models`              | Bearer (401 without) | OpenAI list, ids                                           |
| SiliconFlow | `GET https://api.siliconflow.com/v1/models?sub_type=chat` | Bearer (401 without) | OpenAI list; `sub_type` filters server-side without `type` |
| Hyperbolic  | `GET https://api.hyperbolic.xyz/v1/models`                | Bearer (401 without) | `supports_chat`, `supports_image_input`, `context_length`  |

## Decisions

- **NVIDIA NIM:** no kind field, so ids are classified by pattern. `embed` ids →
  `embedding` (routed via `embeddingConfig`). Safety/guard/reward/parse/detector/clip
  ids and `google/deplot` have no route and are dropped; the rest are chat. Static
  TTS/STT entries (FastPitch, Parakeet, …) aren't in the list and are kept via
  `withStaticNonChatModels`. Registry names kept for known ids.
- **Nebius:** `embed` ids → `embedding`; image models (flux, sdxl, stable-diffusion)
  and guard models have no route and are dropped.
- **SiliconFlow:** server-side `sub_type=chat` returns chat models only; the registry
  serves llm only.
- **Hyperbolic:** rows with `supports_chat: false` (image/audio) are dropped;
  `context_length` and `supports_image_input` mapped.

## Changes

1. `src/lib/providerModels/apiKeyModels.js`: four parsers + resolvers.
2. `liveResolvers.js`: register `nvidia`, `nebius`, `siliconflow`, `hyperbolic`.
3. Registry: `features.liveModels: true` on the four.
4. `src/app/api/providers/[id]/models/route.js`: drop the four shadowed configs.
5. Tests: registry lists in `live-model-resolvers.test.js` / `live-models-utils.test.js`;
   new `tests/unit/nim-nebius-siliconflow-hyperbolic-live-models.test.js`.

## Not done

- No provider keys were available, so Nebius/SiliconFlow/Hyperbolic shapes come from
  docs, not live calls. The parsers only need `id` (plus optional fields).
- Nebius `?verbose=true` metadata — add when the field names are confirmed.
