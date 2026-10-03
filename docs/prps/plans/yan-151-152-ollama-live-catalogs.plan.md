# Plan: live model catalogs for Ollama Local and Ollama Cloud

YAN-151 (Ollama Local), YAN-152 (Ollama Cloud), target v1.1.0, part of YAN-135.
GitHub #716, #717. No backport, no switch: every failure keeps the static list.

## Upstream

- Cloud: `GET https://ollama.com/api/tags` (public; Bearer key sent when set).
- Local: `GET {resolveOllamaLocalHost(conn)}/api/tags`, no auth, daemon may be down.
- Shape: `{ models: [{ name, model, details: { family, families } }] }`, no `id`.

## Changes

1. `src/lib/providerModels/ollamaModels.js`: `parseOllamaTags` (id = `model || name`,
   deduped; embedding models, detected by name or bert family, are dropped since
   both registries serve chat only),
   `resolveOllama` (10 s timeout), `resolveOllamaLocal` (5 s timeout,
   "Ollama not reachable at <host>" on network error).
2. `liveResolvers.js`: register `ollama`, `ollama-local`.
3. Registry `ollama.js`, `ollama-local.js`: `features.liveModels: true`.
4. `src/app/api/providers/[id]/models/route.js`: drop the two shadowed configs
   (they parsed tags as OpenAI-style and lost the ids).
5. Tests: registry lists in `live-model-resolvers.test.js` / `live-models-utils.test.js`;
   new `tests/unit/ollama-live-models.test.js` (parser, dashboard + `/v1/models`,
   unreachable host warning).

## Not done

- `/api/show` capabilities (tools/vision): add when the picker needs per-model flags.
